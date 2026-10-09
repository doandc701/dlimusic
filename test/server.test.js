// API tests for server.js. Starts a real server on a free port with a temporary download folder.
//
// The "telegram" suite talks to the real Telegram account in session.txt: it scans a chat and
// downloads ONE small file into the temp folder. It is skipped when there is no logged-in session.
// Pick the chat with TEST_CHAT=<username|id> (default: nhaclotclub, else your first channel).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tele-dl-server-"));
const DOWNLOAD_DIR = path.join(TMP, "music"); // chosen through the API, like a user would
const FS_DIR = path.join(TMP, "browse"); // playground for the folder browser tests
fs.mkdirSync(DOWNLOAD_DIR);
fs.mkdirSync(path.join(FS_DIR, "Alpha"), { recursive: true });
fs.mkdirSync(path.join(FS_DIR, "beta"));
fs.mkdirSync(path.join(FS_DIR, ".hidden"));
const MAX_TEST_FILE = 60 * 1024 ** 2; // don't pull anything bigger than this in tests

const TOKEN = "t-" + crypto.randomBytes(24).toString("base64url");
const COOKIE = `tdl_token=${TOKEN}`;
/** fetch() as the real user: carries the access cookie unless the test overrides Cookie. */
const authed = (url, opts = {}) => fetch(url, { ...opts, headers: { Cookie: COOKIE, ...opts.headers } });

// --open launches this instead of a browser: it records the URL the browser would get.
const OPENED = path.join(TMP, "opened-url.txt");
const OPENER = path.join(TMP, "open.sh");
fs.writeFileSync(OPENER, `#!/bin/sh\nprintf '%s' "$1" > '${OPENED}'\n`, { mode: 0o700 });

let server;
let base;
let ready = false;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function api(pathname, { method = "GET", body, headers = {} } = {}) {
  const res = await authed(base + pathname, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json", ...headers } : headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

/**
 * Subscribe to server-sent events. Resolves once connected (so actions triggered afterwards
 * cannot be missed) to { done }, which resolves with the first event data matching predicate.
 */
async function listen(predicate, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const res = await authed(base + "/api/events", { signal: ctrl.signal });
  const done = (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event && data && predicate(event, JSON.parse(data))) return JSON.parse(data);
        }
      }
      throw new Error("event stream closed");
    } catch (err) {
      if (err.name === "AbortError") throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for event`);
      throw err;
    } finally {
      clearTimeout(timer);
      ctrl.abort();
    }
  })();
  return { done };
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["server.js", "--open"], {
    cwd: ROOT,
    // Isolated settings/history, and no DOWNLOAD_DIR: the server starts with no download folder.
    env: { ...process.env, PORT: String(port), DOWNLOAD_DIR: "", SETTINGS_FILE: path.join(TMP, "settings.json"), HISTORY_FILE: path.join(TMP, "history.json"), UI_TOKEN: TOKEN, TOKEN_FILE: path.join(TMP, ".ui-token"), TDL_OPEN_CMD: OPENER, API_FILE: path.join(TMP, "api.json") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on("data", (d) => String(d).includes("Telegram downloader UI") && resolve());
    server.on("exit", (code) => reject(new Error(`server exited with ${code}`)));
  });

  // Wait for the Telegram connection to settle (ready, or waiting for login).
  for (let i = 0; i < 60; i++) {
    const { data } = await api("/api/status");
    if (data.step === "ready") ready = true;
    if (!["connecting", "waiting"].includes(data.step)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
});

after(() => {
  server?.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("http basics", () => {
  test("serves the UI", async () => {
    const res = await authed(base + "/");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
    assert.match(await res.text(), /bootstrap@5\.3\.8/);
  });

  test("unknown routes return 404", async () => {
    assert.equal((await api("/nope")).status, 404);
    assert.equal((await api("/api/nope")).status, 404);
  });

  test("status reports the auth step", async () => {
    const { status, data } = await api("/api/status");
    assert.equal(status, 200);
    assert.ok(["ready", "api_choice", "api_id", "api_hash", "phone", "code", "password", "error"].includes(data.step), data.step);
  });
});

describe("security", () => {
  test("rejects requests from another origin", async () => {
    const { status } = await api("/api/cancel", { method: "POST", body: {}, headers: { Origin: "http://evil.example" } });
    assert.equal(status, 403);
  });

  test("rejects a foreign Host header (DNS rebinding)", async () => {
    // fetch() won't let us override Host, so use a raw HTTP request.
    const { port } = new URL(base);
    const status = await new Promise((resolve, reject) => {
      const sock = net.connect(Number(port), "127.0.0.1", () =>
        sock.write(`GET /api/status HTTP/1.1\r\nHost: evil.example:${port}\r\nCookie: ${COOKIE}\r\nConnection: close\r\n\r\n`));
      let out = "";
      sock.on("data", (d) => (out += d));
      sock.on("end", () => resolve(Number(out.split(" ")[1])));
      sock.on("error", reject);
    });
    assert.equal(status, 403);
  });

  test("POST requires a JSON content type (blocks simple cross-site form posts)", async () => {
    // /api/settings works signed in or not, so this checks only the content-type rule
    const res = await authed(base + "/api/settings", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
    assert.equal(res.status, 415);
  });

  test("R9: oversized body is 413, malformed JSON is 400, server stays up", async () => {
    const big = "a".repeat(1_100_000);
    const r1 = await authed(base + "/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ x: big }) });
    assert.equal(r1.status, 413);
    const r2 = await authed(base + "/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
    assert.equal(r2.status, 400);
    assert.equal((await authed(base + "/api/status")).status, 200); // still alive
  });

    test("login input is refused when the server is not waiting for it", async () => {
    const { status } = await api("/api/login", { method: "POST", body: { kind: "code", value: "12345" } });
    assert.equal(status, 409);
  });
});

describe("security hardening (R1-R7)", () => {
  const plain = (p, opts) => fetch(base + p, opts); // no cookie: another OS user / another program

  test("R3/R4: without the token every API and the page are locked", async () => {
    for (const p of ["/api/status", "/api/dialogs", "/api/settings", "/api/history", `/api/fs?path=${encodeURIComponent(os.homedir())}`, "/api/events"]) {
      const res = await plain(p);
      assert.equal(res.status, 401, p);
      const body = await res.json();
      assert.equal(body.code, "NEED_TOKEN");
      assert.ok(!JSON.stringify(body).includes("phone"), "nothing about the account leaks");
    }
    const post = await plain("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ downloadDir: TMP }) });
    assert.equal(post.status, 401);
    const page = await plain("/");
    assert.equal(page.status, 401);
    assert.match(await page.text(), /token/);
  });

  test("R3: a wrong or truncated token is rejected", async () => {
    for (const bad of ["x", TOKEN.slice(0, -1), TOKEN + "x", ""]) {
      assert.equal((await plain("/api/status", { headers: { Cookie: `tdl_token=${encodeURIComponent(bad)}` } })).status, 401, bad);
      assert.equal((await plain(`/?token=${encodeURIComponent(bad)}`, { redirect: "manual" })).status, 401, bad);
    }
  });

  test("R3: the link with the right token sets an HttpOnly SameSite=Strict cookie and drops the token from the URL", async () => {
    const res = await plain(`/?token=${TOKEN}`, { redirect: "manual" });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/");
    const cookie = res.headers.get("set-cookie");
    assert.match(cookie, /^tdl_token=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
  });

  test("npm run web opens the browser with a one-time code, never the real token", async () => {
    for (let i = 0; i < 40 && !fs.existsSync(OPENED); i++) await new Promise((r) => setTimeout(r, 100));
    const opened = new URL(fs.readFileSync(OPENED, "utf8"));
    assert.ok(!opened.href.includes(TOKEN), "the token is not on the command line");
    const code = opened.searchParams.get("once");
    assert.ok(code && code.length >= 32);

    const first = await plain(`/?once=${code}`, { redirect: "manual" });
    assert.equal(first.status, 303, "first use signs the browser in");
    assert.match(first.headers.get("set-cookie"), /^tdl_token=.*HttpOnly.*SameSite=Strict/);
    assert.equal(first.headers.get("location"), "/");

    assert.equal((await plain(`/?once=${code}`, { redirect: "manual" })).status, 401, "a used code is dead");
    assert.equal((await plain("/?once=made-up-code", { redirect: "manual" })).status, 401);
    assert.equal((await plain(`/api/status?once=${code}`)).status, 401, "codes never open the API");
  });

  test("R3: the token never appears in API responses", async () => {
    for (const p of ["/api/status", "/api/settings", "/api/history"]) {
      assert.ok(!(await (await authed(base + p)).text()).includes(TOKEN), p);
    }
  });

  test("R2: the page sends CSP (no inline script except ours, no framing) and safety headers", async () => {
    const res = await authed(base + "/");
    const csp = res.headers.get("content-security-policy");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /script-src 'self' https:\/\/cdn\.jsdelivr\.net 'sha256-/);
    assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp), "no unsafe-inline for scripts");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal(res.headers.get("cross-origin-resource-policy"), "same-origin");
    // every inline <script> on the page is covered by a hash in the CSP
    const html = await res.text();
    for (const [, js] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      assert.ok(csp.includes(crypto.createHash("sha256").update(js).digest("base64")), "inline script allowed by hash");
    }
  });

  test("R2: API responses are not cached and not embeddable", async () => {
    const res = await authed(base + "/api/status");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("cross-origin-resource-policy"), "same-origin");
  });

  test("R1: settings, history and token files are owner-only (600)", async () => {
    await api("/api/settings", { method: "POST", body: { subfolderPerChat: true } });
    for (const f of ["settings.json", ".ui-token"]) {
      const file = path.join(TMP, f);
      if (f === ".ui-token" && !fs.existsSync(file)) continue; // token came from UI_TOKEN env in tests
      assert.equal(fs.statSync(file).mode & 0o777, 0o600, f);
    }
  });
});

describe("validation", () => {
  test("media for an unknown scan is 404", async () => {
    assert.equal((await api("/api/media?key=nope&id=1")).status, 404);
  });

  test("download with an empty selection is 400", async (t) => {
    if (!ready) return t.skip("not logged in");
    assert.equal((await api("/api/download", { method: "POST", body: { key: "x", ids: [] } })).status, 400);
  });

  test("download for a chat that was never scanned is 404", async (t) => {
    if (!ready) return t.skip("not logged in");
    assert.equal((await api("/api/download", { method: "POST", body: { key: "nope", ids: [1] } })).status, 404);
  });

  test("files: missing chat is 400, bad type is 400", async (t) => {
    if (!ready) return t.skip("not logged in");
    assert.equal((await api("/api/files")).status, 400);
    assert.equal((await api("/api/files?chat=me&type=bogus")).status, 400);
  });

  test("files: a chat that does not exist returns a readable error", async (t) => {
    if (!ready) return t.skip("not logged in");
    const { status, data } = await api("/api/files?chat=this_username_should_not_exist_zz9&type=music");
    assert.ok(status >= 400);
    assert.ok(data.error);
  });

  test("cancel with nothing queued cancels 0", async () => {
    assert.deepEqual((await api("/api/cancel", { method: "POST", body: {} })).data, { cancelled: 0 });
  });
});

describe("settings & folder browser", () => {
  test("starts with no download folder and sub-folders per chat", async () => {
    assert.deepEqual((await api("/api/settings")).data, { downloadDir: null, subfolderPerChat: true });
  });

  test("rejects a folder that does not exist", async () => {
    const { status, data } = await api("/api/settings", { method: "POST", body: { downloadDir: path.join(TMP, "nope") } });
    assert.equal(status, 400);
    assert.match(data.error, /không tồn tại/);
  });

  test("lists sub-folders (hidden ones excluded) with parent and shortcuts", async () => {
    const { status, data } = await api(`/api/fs?path=${encodeURIComponent(FS_DIR)}`);
    assert.equal(status, 200);
    assert.equal(data.path, FS_DIR);
    assert.equal(data.parent, TMP);
    assert.deepEqual(data.dirs, ["Alpha", "beta"]);
    assert.equal(data.writable, true);
    assert.ok(data.shortcuts.some((s) => s.label === "Home"));
  });

  test("a missing path falls back to its nearest existing parent", async () => {
    const { data } = await api(`/api/fs?path=${encodeURIComponent(path.join(FS_DIR, "Alpha", "x", "y"))}`);
    assert.equal(data.path, path.join(FS_DIR, "Alpha"));
  });

  test("creates a new folder, refuses unsafe names", async () => {
    const ok = await api("/api/fs/mkdir", { method: "POST", body: { parent: FS_DIR, name: "Nhạc mới" } });
    assert.equal(ok.status, 200);
    assert.ok(fs.statSync(path.join(FS_DIR, "Nhạc mới")).isDirectory());
    for (const name of ["../escape", "a/b", "..", "  "]) {
      assert.equal((await api("/api/fs/mkdir", { method: "POST", body: { parent: FS_DIR, name } })).status, 400, name);
    }
    assert.ok(!fs.existsSync(path.join(TMP, "escape")));
  });

  test("saves settings to the settings file", async () => {
    const { data } = await api("/api/settings", { method: "POST", body: { downloadDir: FS_DIR, subfolderPerChat: false } });
    assert.deepEqual(data, { downloadDir: FS_DIR, subfolderPerChat: false });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(TMP, "settings.json"), "utf8")), data);
    // back to "no folder" so the download tests can exercise the ask-for-a-folder flow
    await api("/api/settings", { method: "POST", body: { downloadDir: null, subfolderPerChat: true } });
  });
});

describe("telegram (real account)", () => {
  let scan;
  let file;
  let chatUsed;
  let outDir; // where the test download lands (returned by /api/download)
  let previewBytes; // a range streamed from Telegram before downloading, compared with the file later
  const PREVIEW_RANGE = [524000, 525287]; // crosses the 512 KB request boundary on purpose

  test("lists dialogs", async (t) => {
    if (!ready) return t.skip("no logged-in session.txt");
    const { status, data } = await api("/api/dialogs");
    assert.equal(status, 200);
    assert.ok(data.length > 0);
    for (const d of data) {
      assert.equal(typeof d.id, "string");
      assert.ok(["channel", "group", "user"].includes(d.type));
    }
  });

  test("scans a chat for music", async (t) => {
    if (!ready) return t.skip("no logged-in session.txt");
    const dialogs = (await api("/api/dialogs")).data;
    const wanted = process.env.TEST_CHAT || "nhaclotclub";
    const chat = dialogs.some((d) => d.username === wanted || d.id === wanted)
      ? wanted
      : dialogs.find((d) => d.type === "channel")?.id;
    if (!chat) return t.skip("no channel to scan");

    const { status, data } = await api(`/api/files?chat=${encodeURIComponent(chat)}&type=music`);
    assert.equal(status, 200, data.error);
    assert.ok(data.key && data.title);
    assert.equal(data.outDir, null, "no download folder chosen yet");
    for (const f of data.files) {
      assert.equal(typeof f.id, "number");
      assert.ok(f.name && !f.name.includes("/"));
      assert.equal(f.downloaded, false, "temp folder is empty, nothing is downloaded yet");
    }
    scan = data;
    chatUsed = chat;
    file = data.files.filter((f) => f.size > 0 && f.size <= MAX_TEST_FILE).sort((a, b) => a.size - b.size)[0];
    t.diagnostic(`${data.title}: ${data.files.length} files; test file: ${file?.name} (${file?.size} B)`);
  });

  test("preview streams a not-yet-downloaded file from Telegram with Range", { timeout: 60_000 }, async (t) => {
    if (!scan || !file) return t.skip("nothing to preview");
    if (file.size <= PREVIEW_RANGE[1]) return t.skip("test file too small for the range");
    const url = `${base}/api/media?key=${encodeURIComponent(scan.key)}&id=${file.id}`;

    const head = await authed(url, { headers: { Range: "bytes=0-1023" } });
    assert.equal(head.status, 206);
    assert.equal(head.headers.get("content-range"), `bytes 0-1023/${file.size}`);
    assert.equal((await head.arrayBuffer()).byteLength, 1024);

    const [a, b] = PREVIEW_RANGE;
    const mid = await authed(url, { headers: { Range: `bytes=${a}-${b}` } });
    assert.equal(mid.status, 206);
    previewBytes = Buffer.from(await mid.arrayBuffer());
    assert.equal(previewBytes.length, b - a + 1);

    const bad = await authed(url, { headers: { Range: `bytes=${file.size + 10}-` } });
    assert.equal(bad.status, 416);
    await bad.arrayBuffer();

    // Previewing must not create anything on disk.
    assert.deepEqual(fs.readdirSync(DOWNLOAD_DIR), []);
  });

  test("download without a folder asks for one (NEED_DIR)", async (t) => {
    if (!scan || !file) return t.skip("nothing to download");
    const { status, data } = await api("/api/download", { method: "POST", body: { key: scan.key, ids: [file.id] } });
    assert.equal(status, 409);
    assert.equal(data.code, "NEED_DIR");
  });

  test("downloads one file end-to-end and reports progress over SSE", { timeout: 300_000 }, async (t) => {
    if (!scan) return t.skip("scan did not run");
    if (!file) return t.skip(`no music file under ${MAX_TEST_FILE} B`);

    const seen = [];
    const { done } = await listen((ev, d) => {
      if (ev !== "job" || d.msgId !== file.id) return false;
      seen.push(d.status);
      return ["done", "failed"].includes(d.status);
    }, 280_000);

    const { status, data } = await api("/api/download", {
      method: "POST",
      body: { key: scan.key, ids: [file.id], dir: DOWNLOAD_DIR, remember: true },
    });
    assert.equal(status, 200);
    assert.equal(data.added, 1);
    outDir = data.outDir;
    assert.ok(outDir.startsWith(DOWNLOAD_DIR + path.sep), "sub-folder per chat inside the chosen folder");

    const job = await done;
    assert.equal(job.status, "done", job.error);
    assert.ok(seen.includes("downloading"), `saw statuses: ${seen.join(",")}`);

    const saved = path.join(outDir, job.file);
    assert.equal(fs.statSync(saved).size, file.size, "file size matches Telegram");
    assert.ok(!fs.existsSync(saved + ".part"), ".part file was renamed");
  });

  test("the downloaded file can be streamed with Range (seek in player)", async (t) => {
    if (!scan || !file) return t.skip("nothing downloaded");
    const res = await authed(`${base}/api/media?key=${encodeURIComponent(scan.key)}&id=${file.id}`, { headers: { Range: "bytes=100-199" } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get("content-range"), `bytes 100-199/${file.size}`);
    assert.equal((await res.arrayBuffer()).byteLength, 100);
  });

  test("previewed bytes are identical to the downloaded file", async (t) => {
    if (!previewBytes) return t.skip("preview did not run");
    const saved = fs.readdirSync(outDir).find((n) => !n.endsWith(".part"));
    const fd = fs.openSync(path.join(outDir, saved), "r");
    const local = Buffer.alloc(previewBytes.length);
    fs.readSync(fd, local, 0, local.length, PREVIEW_RANGE[0]);
    fs.closeSync(fd);
    assert.ok(local.equals(previewBytes), "streamed range matches the file on disk byte for byte");
  });

  test("downloading the same file again is skipped", { timeout: 30_000 }, async (t) => {
    if (!scan || !file) return t.skip("nothing downloaded");
    const { done } = await listen((ev, d) => ev === "job" && d.msgId === file.id && d.status !== "queued", 25_000);
    await api("/api/download", { method: "POST", body: { key: scan.key, ids: [file.id] } });
    assert.equal((await done).status, "skipped");
  });

  test("a rescan marks the file as downloaded", async (t) => {
    if (!scan || !file) return t.skip("nothing downloaded");
    const { status, data } = await api(`/api/files?chat=${encodeURIComponent(chatUsed)}&type=music`);
    assert.equal(status, 200);
    assert.equal(data.files.find((f) => f.id === file.id).downloaded, true);
  });

  test("the chosen folder was remembered as the default", async (t) => {
    if (!outDir) return t.skip("nothing downloaded");
    assert.equal((await api("/api/settings")).data.downloadDir, DOWNLOAD_DIR);
  });

  test("history records the download (done) and the re-download (skipped) with the file path", async (t) => {
    if (!outDir) return t.skip("nothing downloaded");
    const { data } = await api("/api/history");
    const mine = data.filter((h) => h.msgId === file.id);
    assert.deepEqual(mine.map((h) => h.status).sort(), ["done", "skipped"]);
    for (const h of mine) assert.equal(path.dirname(h.path), outDir);
    const onDisk = JSON.parse(fs.readFileSync(path.join(TMP, "history.json"), "utf8"));
    assert.equal(onDisk.length, data.length, "history is persisted");
  });

  test("removing a history entry keeps the file", async (t) => {
    if (!outDir) return t.skip("nothing downloaded");
    const entry = (await api("/api/history")).data.find((h) => h.msgId === file.id);
    const { data } = await api("/api/history/delete", { method: "POST", body: { ids: [entry.id] } });
    assert.equal(data.removed, 1);
    assert.ok(!(await api("/api/history")).data.some((h) => h.id === entry.id));
    assert.ok(fs.existsSync(entry.path), "file is still on disk");
  });

  test("clearing the whole history keeps the files", async (t) => {
    if (!outDir) return t.skip("nothing downloaded");
    const before = fs.readdirSync(outDir);
    const { data } = await api("/api/history/clear", { method: "POST", body: {} });
    assert.ok(data.removed >= 1);
    assert.deepEqual((await api("/api/history")).data, []);
    assert.deepEqual(fs.readdirSync(outDir), before);
    assert.equal((await api("/api/history/delete", { method: "POST", body: { ids: [] } })).status, 400);
  });

  test("downloaded flags follow the default folder (GET /api/scan, no rescan)", async (t) => {
    if (!outDir) return t.skip("nothing downloaded");
    const flag = async () => (await api(`/api/scan?key=${encodeURIComponent(scan.key)}`)).data.files.find((f) => f.id === file.id).downloaded;
    assert.equal(await flag(), true);
    await api("/api/settings", { method: "POST", body: { downloadDir: FS_DIR } });
    assert.equal(await flag(), false, "not in the new default folder and no history left");
    await api("/api/settings", { method: "POST", body: { downloadDir: DOWNLOAD_DIR } });
    assert.equal(await flag(), true);
  });

  test("clear removes finished jobs", async (t) => {
    if (!scan || !file) return t.skip("nothing downloaded");
    // Skip the snapshot sent on connect; wait for the broadcast triggered by /api/clear.
    let snapshot = true;
    const { done } = await listen((ev, d) => {
      if (ev !== "jobs") return false;
      if (snapshot) return (snapshot = false);
      return !d.some((j) => j.msgId === file.id);
    }, 10_000);
    await api("/api/clear", { method: "POST", body: {} });
    await done;
  });
});

// ---------- API choice on the login screen (no Telegram account involved) ----------

async function startServer(env) {
  const port = await freePort();
  const proc = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), UI_TOKEN: TOKEN, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    proc.stdout.on("data", (d) => String(d).includes("Telegram downloader UI") && resolve());
    proc.on("exit", (code) => reject(new Error(`server exited with ${code}`)));
  });
  const call = async (p, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method: body ? "POST" : "GET",
      headers: { Cookie: COOKIE, ...(body && { "Content-Type": "application/json" }) },
      body: body && JSON.stringify(body),
    });
    return res.json();
  };
  const waitStep = async (step) => {
    for (let i = 0; i < 50; i++) {
      const s = await call("/api/status");
      if (s.step === step) return s;
      await new Promise((r) => setTimeout(r, 100));
    }
    return call("/api/status");
  };
  return { proc, call, waitStep };
}

describe("API choice on the login screen", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tele-dl-api-"));
  const servers = [];
  after(() => {
    for (const s of servers) s.proc.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const envFile = (name, text) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, text);
    return f;
  };

  test("no API in .env: asks for the user's own API ID directly (was an error before)", async () => {
    const data = fs.mkdtempSync(path.join(dir, "d-"));
    const s = await startServer({ TDL_ENV_FILE: envFile("empty.env", "PHONE=+84\n"), TDL_DATA_DIR: data, API_FILE: path.join(data, "api.json") });
    servers.push(s);
    const st = await s.waitStep("api_id");
    assert.equal(st.step, "api_id");
    assert.equal(st.apiChoice, false, "nothing to choose without a built-in API");
    await s.call("/api/login", { kind: "api_id", value: "abc" });
    const again = await s.waitStep("api_id");
    assert.match(again.error, /dãy số/);
    assert.equal((await s.call("/api/login", { kind: "api_id", value: "__back__" })).ok, true);
    assert.equal((await s.waitStep("api_id")).step, "api_id", "no way back when there is no built-in API");
    assert.ok(!fs.existsSync(path.join(data, "api.json")), "nothing saved yet");
  });

  test("API in .env and not signed in: offers the choice; own API can go back to it", async () => {
    const data = fs.mkdtempSync(path.join(dir, "d-"));
    const env = envFile("full.env", "API_ID=123456\nAPI_HASH=0123456789abcdef0123456789abcdef\n");
    const s = await startServer({ TDL_ENV_FILE: env, TDL_DATA_DIR: data, API_FILE: path.join(data, "api.json") });
    servers.push(s);
    const st = await s.waitStep("api_choice");
    assert.equal(st.step, "api_choice");
    assert.equal(st.apiChoice, true);
    await s.call("/api/login", { kind: "api_choice", value: "own" });
    assert.equal((await s.waitStep("api_id")).step, "api_id");
    await s.call("/api/login", { kind: "api_id", value: "__back__" });
    assert.equal((await s.waitStep("api_choice")).step, "api_choice");
  });
});
