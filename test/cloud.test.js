// MongoDB storage: encryption + validation, the local server's mirror, the /api/cloud functions of the
// browser version and the real server started with MONGODB_URI. Uses a throw-away in-memory MongoDB
// (mongodb-memory-server), never a real cluster.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import {
  encrypt,
  decrypt,
  keyFromSecret,
  ACCOUNT_DATA,
  normalizeApi,
  isSessionString,
  isMongoUri,
  mongoHost,
  closeDb,
  openDb,
} from "../cloud/common.js";
import { createMirror } from "../cloud/mirror.js";
import { createCloudApi, tcpSession } from "../cloud/api.js";
import { SHARES_PER_ACCOUNT, SHARE_ACCOUNT_BYTES } from "../cloud/share.js";
import { createCloudSync, createAccountSync } from "../web/cloud-sync.js";
import { readAccount, joinAccount, applyOps, checkOps } from "../cloud/account.js";
import { editPlaylists, sortPlaylists, SHARE_FILE_MAX, SHARE_CHUNK, SHARE_SONGS_MAX } from "../core.js";
import { presign } from "../cloud/r2.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SESSION_A = "1BAAOMTQ5LjE1NC4xNjcuNTEBu" + "A".repeat(320);
const SESSION_B = "1BAAOMTQ5LjE1NC4xNjcuNTEBu" + "B".repeat(320);
const quiet = { log() {}, warn() {} };

// One outer suite: its after() hook runs only once every test below has finished.
describe("MongoDB storage", () => {
  let mongo;
  let uri;
  let raw; // direct client to look inside the database
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tdl-cloud-"));

  before(async () => {
    mongo = await MongoMemoryServer.create();
    uri = mongo.getUri();
    raw = await MongoClient.connect(uri);
  });
  after(async () => {
    await closeDb();
    await raw?.close();
    await mongo?.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const docs = (db = "tele_downloader") => raw.db(db).collection("kv").find().toArray();

  describe("encryption and validation", () => {
    test("sessions round-trip with the right key only, tampering is detected", () => {
      const key = keyFromSecret("a long enough secret");
      const box = encrypt(SESSION_A, key);
      assert.ok(!JSON.stringify(box).includes("AAAA"), "no plain text in the box");
      assert.equal(decrypt(box, key), SESSION_A);
      assert.equal(decrypt(box, keyFromSecret("another secret")), null);
      assert.equal(decrypt({ ...box, data: Buffer.from("x").toString("base64") }, key), null);
      assert.notDeepEqual(encrypt(SESSION_A, key).iv, box.iv, "fresh IV every time");
    });

    test("browser sessions (WebSocket hosts) are checked over TCP: same data centre and key, IP address", async () => {
      const { StringSession } = await import("telegram/sessions/index.js");
      const { AuthKey } = await import("telegram/crypto/AuthKey.js");
      const key = new AuthKey();
      await key.setKey(Buffer.alloc(256, 7));
      for (const [dc, host, ip] of [
        [2, "venus.web.telegram.org", "149.154.167.51"],
        [5, "flora.web.telegram.org", "91.108.56.130"],
      ]) {
        const browser = new StringSession("");
        browser.setDC(dc, host, 443);
        browser.setAuthKey(key);
        const tcp = await tcpSession(browser.save());
        assert.deepEqual([tcp.dcId, tcp.serverAddress, tcp.port], [dc, ip, 443]);
        assert.ok(tcp.getAuthKey().getKey().equals(key.getKey()), "auth key kept");
      }
      const node = new StringSession("");
      node.setDC(5, "91.108.56.102", 443);
      node.setAuthKey(key);
      assert.equal((await tcpSession(node.save())).serverAddress, "91.108.56.102", "an IP is left alone");
    });

    test("a session never points the server at another host (SSRF): only Telegram's addresses are dialled", async () => {
      const { StringSession } = await import("telegram/sessions/index.js");
      const { AuthKey } = await import("telegram/crypto/AuthKey.js");
      const key = new AuthKey();
      await key.setKey(Buffer.alloc(256, 7));
      const made = (dc, host, port) => {
        const s = new StringSession("");
        s.setDC(dc, host, port);
        s.setAuthKey(key);
        return s.save();
      };
      for (const [host, port] of [
        ["127.0.0.1", 27017],
        ["169.254.169.254", 80],
        ["10.0.0.1", 443],
        ["192.168.1.1", 22],
        ["internal.example.com", 443],
        ["149.154.176.1", 443], // just outside 149.154.160.0/20
      ]) {
        const tcp = await tcpSession(made(2, host, port));
        assert.deepEqual([tcp.serverAddress, tcp.port], ["149.154.167.51", 443], `${host}:${port} replaced`);
      }
      const odd = await tcpSession(made(4, "149.154.167.92", 6379));
      assert.deepEqual([odd.serverAddress, odd.port], ["149.154.167.92", 443], "only ports 80 / 443");
      assert.equal((await tcpSession(made(2, "149.154.167.40", 80))).port, 80);
      await assert.rejects(tcpSession(made(99, "attacker.example", 443)), /unknown Telegram data centre/);
      await assert.rejects(tcpSession(made(0, "127.0.0.1", 80)), /unknown Telegram data centre/);
    });

    test("account data is validated (null = remove, undefined = rejected)", () => {
      assert.deepEqual(ACCOUNT_DATA.settings({ subfolderPerChat: 0, downloadDir: "Nhạc", extra: 1 }), {
        subfolderPerChat: false,
        downloadDir: "Nhạc",
      });
      assert.equal(ACCOUNT_DATA.settings([]), undefined);
      assert.deepEqual(ACCOUNT_DATA.history([{ id: 1, name: "a.mp3", size: 3, path: null }]), [
        { id: 1, name: "a.mp3", size: 3, path: null },
      ]);
      for (const bad of ["x", [{ nested: { a: 1 } }], [{ s: "x".repeat(2001) }], Array(2001).fill({ id: 1 })]) {
        assert.equal(ACCOUNT_DATA.history(bad), undefined);
      }
      assert.deepEqual(ACCOUNT_DATA.favorites(["-100123|5", "-100123|5", "9|1"]), ["-100123|5", "9|1"]);
      assert.equal(ACCOUNT_DATA.favorites(["nope"]), undefined);
      assert.deepEqual(ACCOUNT_DATA.visibleChats(["1", 2]), ["1", "2"]);
      assert.equal(ACCOUNT_DATA.visibleChats(null), null);
      assert.deepEqual(normalizeApi({ mode: "builtin", id: 5 }), { mode: "builtin" });
      assert.deepEqual(normalizeApi({ id: "123", hash: "0123456789abcdef0123456789abcdef" }), {
        id: 123,
        hash: "0123456789abcdef0123456789abcdef",
      });
      assert.equal(normalizeApi({ id: 1, hash: "short" }), undefined);
      assert.ok(isSessionString(SESSION_A));
      assert.ok(!isSessionString("short") && !isSessionString(SESSION_A + "<script>"));
      assert.ok(isMongoUri("mongodb+srv://u:p@cluster0.abc.mongodb.net/?retryWrites=true"));
      assert.ok(!isMongoUri("https://example.com") && !isMongoUri(""));
      assert.equal(mongoHost("mongodb+srv://user:secret@cluster0.abc.mongodb.net/db"), "cluster0.abc.mongodb.net");
    });
  });

  describe("local server mirror", () => {
    const files = (dir) => ({
      [path.join(dir, "settings.json")]: { name: "settings.json" },
      [path.join(dir, "session.txt")]: { name: "session.txt", secret: true },
    });

    test("first start uploads the files (session encrypted); MongoDB then wins on another computer", async () => {
      const a = fs.mkdtempSync(path.join(tmp, "a-"));
      fs.writeFileSync(path.join(a, "settings.json"), JSON.stringify({ subfolderPerChat: false }));
      fs.writeFileSync(path.join(a, "session.txt"), SESSION_A);
      const m1 = createMirror({
        uri,
        dbName: "mirror1",
        secret: "shared secret!!!",
        keyFile: path.join(a, ".k"),
        files: files(a),
        log: quiet,
      });
      assert.equal((await m1.start()).connected, true);
      const stored = await docs("mirror1");
      assert.deepEqual(stored.find((d) => d._id === "local:default:settings.json").value, { subfolderPerChat: false });
      assert.ok(!JSON.stringify(stored).includes("AAAA"), "session is not stored in plain text");

      // a change is uploaded
      fs.writeFileSync(path.join(a, "settings.json"), JSON.stringify({ subfolderPerChat: true, downloadDir: "/x" }));
      m1.changed(path.join(a, "settings.json"));
      await m1.settle();
      assert.deepEqual((await docs("mirror1")).find((d) => d._id === "local:default:settings.json").value, {
        subfolderPerChat: true,
        downloadDir: "/x",
      });

      // another computer (same secret, empty folder) gets everything
      const b = fs.mkdtempSync(path.join(tmp, "b-"));
      const m2 = createMirror({
        uri,
        dbName: "mirror1",
        secret: "shared secret!!!",
        keyFile: path.join(b, ".k"),
        files: files(b),
        log: quiet,
      });
      await m2.start();
      assert.equal(fs.readFileSync(path.join(b, "session.txt"), "utf8"), SESSION_A);
      assert.equal(fs.statSync(path.join(b, "session.txt")).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(b, "settings.json"), "utf8")), {
        subfolderPerChat: true,
        downloadDir: "/x",
      });

      // a removed file (logout) removes the copy
      fs.rmSync(path.join(a, "session.txt"));
      m1.changed(path.join(a, "session.txt"));
      await m1.settle();
      assert.ok(!(await docs("mirror1")).some((d) => d._id === "local:default:session.txt"));
      m1.stop();
      m2.stop();
    });

    test("a different TDL_SECRET cannot read the session: the local file is kept", async () => {
      const a = fs.mkdtempSync(path.join(tmp, "c-"));
      fs.writeFileSync(path.join(a, "session.txt"), SESSION_A);
      const m1 = createMirror({
        uri,
        dbName: "mirror2",
        secret: "secret number one",
        keyFile: path.join(a, ".k"),
        files: files(a),
        log: quiet,
      });
      await m1.start();
      const b = fs.mkdtempSync(path.join(tmp, "d-"));
      fs.writeFileSync(path.join(b, "session.txt"), SESSION_B);
      const m2 = createMirror({
        uri,
        dbName: "mirror2",
        secret: "secret number two",
        keyFile: path.join(b, ".k"),
        files: files(b),
        log: quiet,
      });
      await m2.start();
      assert.equal(fs.readFileSync(path.join(b, "session.txt"), "utf8"), SESSION_B);
      m1.stop();
      m2.stop();
    });

    test("unreachable cluster: files keep working, status says offline (password never echoed)", async () => {
      const a = fs.mkdtempSync(path.join(tmp, "e-"));
      fs.writeFileSync(path.join(a, "settings.json"), JSON.stringify({ subfolderPerChat: false }));
      const bad = "mongodb://user:hunter2@127.0.0.1:1/?directConnection=true";
      const m = createMirror({
        uri: bad,
        secret: "whatever whatever",
        keyFile: path.join(a, ".k"),
        files: files(a),
        timeoutMs: 300,
        log: quiet,
      });
      const st = await m.start();
      assert.equal(st.enabled, true);
      assert.equal(st.connected, false);
      assert.ok(st.error && !st.error.includes("hunter2"));
      m.changed(path.join(a, "settings.json")); // must not throw
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(a, "settings.json"), "utf8")), { subfolderPerChat: false });
      m.stop();
    });

    test("no TDL_SECRET: a key is generated once in the data folder (600)", async () => {
      const a = fs.mkdtempSync(path.join(tmp, "f-"));
      fs.writeFileSync(path.join(a, "session.txt"), SESSION_A);
      const m = createMirror({
        uri,
        dbName: "mirror3",
        keyFile: path.join(a, ".cloud-key"),
        files: files(a),
        log: quiet,
      });
      await m.start();
      assert.equal(fs.statSync(path.join(a, ".cloud-key")).mode & 0o777, 0o600);
      m.stop();
    });
  });

  describe("/api/cloud (browser version)", () => {
    const ACCOUNTS = { [SESSION_A]: "111", [SESSION_B]: "222" };
    const verify = async (session) => {
      if (!ACCOUNTS[session]) throw new Error("AUTH_KEY_UNREGISTERED");
      return ACCOUNTS[session];
    };
    const env = () => ({
      MONGODB_URI: uri,
      MONGODB_DB: "cloudapi",
      TDL_SECRET: "0123456789abcdef-secret",
      TG_API_ID: "123",
      TG_API_HASH: "0123456789abcdef0123456789abcdef",
    });

    /** Call a handler like Vercel would. */
    async function call(
      handle,
      method,
      action,
      { body, token, raw: rawBody, type = "application/json", query = "", headers = {} } = {},
    ) {
      const text = rawBody ?? (body === undefined ? "" : JSON.stringify(body));
      const req = Readable.from(method === "POST" ? [Buffer.from(text)] : []);
      Object.assign(req, {
        method,
        url: `/api/cloud/${action}${query}`,
        headers: {
          ...(method === "POST" && { "content-type": type }),
          ...(token && { authorization: `Bearer ${token}` }),
          ...headers,
        },
      });
      const res = {
        headers: {},
        statusCode: 200,
        body: "",
        setHeader(k, v) {
          this.headers[k.toLowerCase()] = v;
        },
        chunks: [],
        write(b) {
          this.chunks.push(Buffer.from(b));
        },
        end(b) {
          this.body = this.chunks.length ? Buffer.concat(this.chunks) : b;
        },
      };
      await handle(req, res, action);
      const json = /json/.test(res.headers["content-type"] || "");
      return { status: res.statusCode, data: json ? JSON.parse(res.body) : res.body, headers: res.headers };
    }

    test("not configured: status says so, everything else is 503 CLOUD_OFF", async () => {
      const h = createCloudApi({ env: {}, verify });
      assert.deepEqual((await call(h, "GET", "status")).data, { enabled: false });
      const r = await call(h, "POST", "login", { body: { session: SESSION_A } });
      assert.equal(r.status, 503);
      assert.equal(r.data.code, "CLOUD_OFF");
      const short = createCloudApi({ env: { ...env(), TDL_SECRET: "short" }, verify });
      assert.equal((await call(short, "GET", "status")).data.enabled, false, "a short secret is not accepted");
    });

    test("login proves the account with Telegram; data is per account and validated", async () => {
      const h = createCloudApi({ env: env(), verify });
      assert.equal(
        (await call(h, "POST", "login", { body: { session: SESSION_A.replace(/A/g, "C") } })).status,
        401,
        "Telegram says no",
      );
      assert.equal((await call(h, "POST", "login", { body: { session: "x" } })).status, 400);

      const a = await call(h, "POST", "login", { body: { session: SESSION_A, api: { mode: "builtin" } } });
      assert.equal(a.status, 200);
      assert.equal(a.data.accountId, "111");
      assert.match(a.data.token, /^[\w-]{43}$/);
      assert.deepEqual(a.data.data, {
        settings: null,
        history: [],
        visibleChats: null,
        favorites: [],
        recent: [],
        playlists: [],
      });
      assert.equal(a.headers["cache-control"], "no-store");

      const ta = a.data.token;
      const ops = (name, list) => call(h, "POST", "ops", { token: ta, body: { name, ops: list } });
      assert.equal(
        (
          await ops("favorites", [
            { op: "add", id: "5|2" },
            { op: "add", id: "5|1" },
          ])
        ).status,
        200,
      );
      assert.equal((await ops("history", [{ op: "add", entries: [{ id: 1, name: "a.mp3" }] }])).status, 200);
      for (const [name, bad] of [
        ["favorites", [{ op: "add", id: "bad" }]],
        ["session", [{ op: "set", value: "x" }]],
        ["history", [{ op: "add", entries: [{ id: "x" }] }]],
        ["history", [{ op: "drop" }]],
        ["favorites", "x"],
        ["settings", [{ op: "add", id: "5|1" }]],
      ]) {
        assert.equal((await ops(name, bad)).status, 400, `${name} ${JSON.stringify(bad)}`);
      }
      assert.deepEqual((await call(h, "GET", "data", { token: ta })).data.favorites, ["5|1", "5|2"]);

      // another account sees nothing of the first one
      const b = await call(h, "POST", "login", { body: { session: SESSION_B } });
      assert.deepEqual(b.data.data, {
        settings: null,
        history: [],
        visibleChats: null,
        favorites: [],
        recent: [],
        playlists: [],
      });
      assert.deepEqual((await call(h, "GET", "data", { token: b.data.token })).data.favorites, []);

      // removing
      await ops("history", [{ op: "clear" }]);
      assert.deepEqual((await call(h, "GET", "data", { token: ta })).data.history, []);

      // a second device of the same account gets the same data
      const a2 = await call(h, "POST", "login", { body: { session: SESSION_A } });
      assert.deepEqual(a2.data.data.favorites, ["5|1", "5|2"]);
      assert.notEqual(a2.data.token, ta, "a new token per device");

      // what is stored: tokens hashed, session encrypted
      const tokens = await raw.db("cloudapi").collection("tokens").find().toArray();
      assert.ok(!JSON.stringify(tokens).includes(ta), "tokens are stored as hashes only");
      const kv = await raw.db("cloudapi").collection("kv").find().toArray();
      assert.ok(!JSON.stringify(kv).includes("AAAAAAAA"), "session encrypted");
    });

    test("own API hash is stored encrypted and given back with the session", async () => {
      const h = createCloudApi({ env: env(), verify });
      const own = { id: 999, hash: "fedcba9876543210fedcba9876543210" };
      const { data } = await call(h, "POST", "login", { body: { session: SESSION_B, api: own } });
      const kv = await raw.db("cloudapi").collection("kv").find({ _id: "acct:222:api" }).toArray();
      assert.ok(!JSON.stringify(kv).includes(own.hash));
      assert.deepEqual((await call(h, "GET", "session", { token: data.token })).data, { session: SESSION_B, api: own });
      assert.equal(
        (await call(h, "POST", "login", { body: { session: SESSION_B, api: { id: 1, hash: "x" } } })).status,
        400,
      );
    });

    test("tokens: bad / missing are 401; logout forgets the session and revokes the token", async () => {
      const h = createCloudApi({ env: env(), verify });
      for (const token of [undefined, "nope", "x".repeat(43)]) {
        assert.equal((await call(h, "GET", "data", { token })).status, 401);
      }
      const { data } = await call(h, "POST", "login", { body: { session: SESSION_A } });
      const fresh = SESSION_A.replace(/A$/, "Z");
      assert.equal((await call(h, "POST", "session", { token: data.token, body: { session: fresh } })).status, 200);
      assert.equal((await call(h, "GET", "session", { token: data.token })).data.session, fresh);
      assert.equal((await call(h, "POST", "logout", { token: data.token, body: {} })).status, 200);
      assert.equal((await call(h, "GET", "data", { token: data.token })).status, 401, "revoked");
      const again = await call(h, "POST", "login", { body: { session: SESSION_A } });
      assert.equal(
        (await call(h, "GET", "session", { token: again.data.token })).data.session,
        SESSION_A,
        "the new login stored its session",
      );
      assert.deepEqual(
        (await call(h, "GET", "data", { token: again.data.token })).data.favorites,
        ["5|1", "5|2"],
        "data survives a logout",
      );
    });

    test("the phone app (keepSession): its session proves the account but the browser's stays stored", async () => {
      const h = createCloudApi({ env: env(), verify });
      const web = await call(h, "POST", "login", { body: { session: SESSION_A } });
      const appSession = SESSION_A.replace(/A$/, "Y");
      ACCOUNTS[appSession] = "111";
      const app = await call(h, "POST", "login", { body: { session: appSession, keepSession: true } });
      assert.equal(app.status, 200);
      assert.equal(app.data.accountId, "111");
      assert.equal(
        (await call(h, "GET", "session", { token: web.data.token })).data.session,
        SESSION_A,
        "the browser's session was not replaced",
      );
      assert.equal(
        (await call(h, "POST", "logout", { token: app.data.token, body: { keepSession: true } })).status,
        200,
      );
      assert.equal((await call(h, "GET", "data", { token: app.data.token })).status, 401, "the app's token is revoked");
      assert.equal(
        (await call(h, "GET", "session", { token: web.data.token })).data.session,
        SESSION_A,
        "the browser's session is still there after the app signs out",
      );
      delete ACCOUNTS[appSession];
    });

    test("requests: JSON content type, size limit, unknown actions, database down", async () => {
      const h = createCloudApi({ env: env(), verify });
      assert.equal((await call(h, "POST", "login", { body: { session: SESSION_A }, type: "text/plain" })).status, 415);
      assert.equal((await call(h, "POST", "login", { raw: "{bad json" })).status, 400);
      assert.equal(
        (await call(h, "POST", "login", { raw: JSON.stringify({ session: "x".repeat(3 * 1024 * 1024) }) })).status,
        413,
      );
      assert.equal((await call(h, "POST", "login", { raw: "null" })).status, 400, "a JSON null body is not a crash");
      assert.equal((await call(h, "POST", "login", { raw: "[1]" })).status, 400);
      // Vercel parses the body itself: req.body is a getter that throws on broken JSON, or null for "null"
      const vercel = async (getBody) => {
        const req = { method: "POST", headers: { "content-type": "application/json" } };
        Object.defineProperty(req, "body", { get: getBody });
        const res = {
          setHeader() {},
          end(b) {
            this.body = b;
          },
        };
        await h(req, res, "login");
        return res.statusCode;
      };
      assert.equal(
        await vercel(() => {
          throw Object.assign(new Error("Invalid JSON"), { statusCode: 400 });
        }),
        400,
      );
      assert.equal(await vercel(() => null), 400);
      assert.equal((await call(h, "GET", "nope")).status, 404);
      assert.equal((await call(h, "DELETE", "data")).status, 404);
      const down = createCloudApi({
        env: {
          ...env(),
          MONGODB_URI: "mongodb://u:pw@127.0.0.1:1/?directConnection=true&serverSelectionTimeoutMS=300",
        },
        verify,
      });
      const r = await call(down, "POST", "login", { body: { session: SESSION_A } });
      assert.equal(r.status, 503);
      assert.equal(r.data.code, "CLOUD_DOWN");
      assert.ok(!JSON.stringify(r.data).includes("pw@"), "no connection string in the error");
    });

    describe("shared playlists (Cloudflare R2)", () => {
      const R2 = {
        R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
        R2_ACCESS_KEY_ID: "key",
        R2_SECRET_ACCESS_KEY: "secret",
        R2_BUCKET: "dlimusic",
      };
      const objects = new Map(); // R2: key -> Buffer
      let r2Batch = "ok"; // how R2 answers DeleteObjects: "ok" | "refused" (not through a signed URL) | "partly"
      const keyOf = (url) => decodeURIComponent(new URL(url).pathname).replace(/^\/dlimusic\/?/, "");
      const r2 = async (url, { method = "GET", body, headers = {} } = {}) => {
        const u = new URL(url);
        assert.equal(u.host, `${R2.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
        assert.ok(u.searchParams.get("X-Amz-Signature"));
        if (method === "POST" && u.searchParams.has("delete")) {
          assert.ok(headers["Content-MD5"]);
          if (r2Batch === "refused") return new Response("NotImplemented", { status: 501 });
          const keys = [...String(body).matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
          // "partly": the first key is reported as not removed (quiet mode lists only those)
          const failed = r2Batch === "partly" ? keys.slice(0, 1) : [];
          for (const k of keys) if (!failed.includes(k)) objects.delete(k);
          return new Response(
            `<DeleteResult>${failed.map((k) => `<Error><Key>${k}</Key><Code>InternalError</Code></Error>`).join("")}</DeleteResult>`,
            { status: 200 },
          );
        }
        const key = keyOf(url);
        if (method === "DELETE") {
          objects.delete(key);
          return new Response(null, { status: 204 });
        }
        if (method === "PUT") {
          objects.set(key, Buffer.from(body));
          return new Response(null, { status: 200 });
        }
        if (!objects.has(key)) return new Response(null, { status: 404 });
        const [, a, b] = /bytes=(\d+)-(\d+)/.exec(headers.Range);
        return new Response(objects.get(key).subarray(Number(a), Number(b) + 1), { status: 206 });
      };
      let clock = new Date("2026-10-29T00:00:00Z");
      const h = () =>
        createCloudApi({ env: { ...env(), MONGODB_DB: "shares", ...R2 }, verify, fetchFn: r2, now: () => clock });
      const song = (title, size, ref) => ({ title, performer: "Ca sĩ", duration: 200, size, type: "audio/mpeg", ref });
      const bytes = (n, seed) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7 + seed) % 256));
      const put = (api, token, code, id, k, body) =>
        call(api, "POST", "share-put", {
          token,
          query: `?code=${code}&id=${id}&k=${k}`,
          raw: body,
          type: "application/octet-stream",
        });

      test("R2 requests are signed like AWS's own example (Signature V4, query string)", () => {
        const url = presign({
          method: "GET",
          host: "examplebucket.s3.amazonaws.com",
          path: "/test.txt",
          region: "us-east-1",
          accessKeyId: "AKIAIOSFODNN7EXAMPLE",
          secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
          expires: 86400,
          now: new Date("2013-05-24T00:00:00Z"),
        });
        assert.match(url, /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
      });

      test("without R2 settings sharing is off; the owner needs a token", async () => {
        const off = createCloudApi({ env: env(), verify });
        assert.deepEqual((await call(off, "GET", "share-status")).data, { enabled: false });
        assert.equal(
          (await call(off, "GET", "share-open", { query: "?code=abcdefghijklmnop" })).data.code,
          "SHARE_OFF",
        );
        assert.deepEqual((await call(h(), "GET", "share-status")).data, { enabled: true });
        assert.equal((await call(h(), "POST", "share-create", { body: {} })).status, 401);
      });

      test("the link opens at once; songs become playable as their pieces arrive, played one piece per range", async () => {
        const api = h();
        const { token } = (await call(api, "POST", "login", { body: { session: SESSION_A } })).data;
        const create = (body) => call(api, "POST", "share-create", { token, body });
        assert.equal(
          (await create({ playlistId: "p1", name: "Chill", days: 3, songs: [song("a", 10, "1|1")] })).status,
          400,
        );
        assert.equal((await create({ playlistId: "p1", name: "Chill", days: 7, songs: [] })).status, 400);
        assert.equal(
          (await create({ playlistId: "p1", name: "Chill", days: 7, songs: [song("a", 10, "bad")] })).status,
          400,
        );
        const big = song("big", SHARE_FILE_MAX + 1, "1|9");
        assert.equal((await create({ playlistId: "p1", name: "Chill", days: 7, songs: [big] })).status, 400);

        const long = SHARE_CHUNK + 1000; // two pieces
        const a = bytes(long, 1);
        const b = bytes(500, 2);
        const created = await create({
          playlistId: "p1",
          name: "Chill",
          days: 7,
          songs: [song("a", long, "1|1"), song("b", 500, "1|2")],
        });
        assert.equal(created.status, 200);
        const { code, count, ready } = created.data.share;
        assert.match(code, /^[\w-]{16}$/);
        assert.deepEqual([count, ready], [2, 0]);

        // open straight away, nothing playable yet
        let open = await call(api, "GET", "share-open", { query: `?code=${code}` });
        assert.deepEqual(
          open.data.songs.map((x) => [x.title, x.ready]),
          [
            ["a", false],
            ["b", false],
          ],
        );
        assert.equal(open.data.songs[0].ref, undefined, "the listener never sees where a song comes from");
        assert.equal(open.data.songs[0].url, undefined, "no URL before the song is there");
        assert.equal((await call(api, "GET", "share-play", { query: `?code=${code}&i=1` })).data.code, "SHARE_PENDING");

        // pieces: right size only, only the owner
        assert.equal((await put(api, token, code, 1, 0, bytes(499, 2))).status, 400, "wrong size");
        assert.equal((await put(api, token, code, 1, 1, b)).status, 400, "no such piece");
        const other = (await call(api, "POST", "login", { body: { session: SESSION_B } })).data.token;
        assert.equal((await put(api, other, code, 1, 0, b)).status, 404, "not B's link");
        assert.equal((await put(api, token, code, 1, 0, b)).status, 200);
        assert.equal((await put(api, token, code, 0, 0, a.subarray(0, SHARE_CHUNK))).status, 200);
        assert.deepEqual((await call(api, "POST", "share-pending", { token, body: { code } })).data.songs, [
          { id: 0, ref: "1|1" },
        ]);
        assert.equal((await put(api, token, code, 0, 1, a.subarray(SHARE_CHUNK))).status, 200);
        open = await call(api, "GET", "share-open", { query: `?code=${code}` });
        assert.deepEqual(
          open.data.songs.map((x) => x.ready),
          [true, true],
        );
        // the URLs come with the list: playing needs no other request; they read nothing in MongoDB
        assert.match(open.data.songs[0].url, /^\/api\/cloud\/share-audio\?.*n=\d+&t=audio%2Fmpeg/);
        assert.equal(open.data.songs[1].size, 500);
        assert.deepEqual(
          (await call(api, "GET", "share-list", { token })).data.shares.map((x) => [x.count, x.ready]),
          [[2, 2]],
        );
        assert.equal((await call(api, "GET", "share-list", { token: other })).data.shares.length, 0);

        // playing: a signed URL of this function, answered piece by piece
        const { url } = (await call(api, "GET", "share-play", { query: `?code=${code}&i=0` })).data;
        assert.match(url, /^\/api\/cloud\/share-audio\?/);
        const audio = (q, range) => call(api, "GET", "share-audio", { query: q, headers: range ? { range } : {} });
        const q = url.slice(url.indexOf("?"));
        let r = await audio(q, "bytes=0-");
        assert.equal(r.status, 206);
        assert.equal(r.headers["content-range"], `bytes 0-${SHARE_CHUNK - 1}/${long}`, "one piece at most");
        assert.ok(a.subarray(0, SHARE_CHUNK).equals(r.data));
        r = await audio(q, `bytes=${SHARE_CHUNK - 10}-${SHARE_CHUNK + 9}`);
        assert.equal(
          r.headers["content-range"],
          `bytes ${SHARE_CHUNK - 10}-${SHARE_CHUNK - 1}/${long}`,
          "stops at the piece's end",
        );
        r = await audio(q, `bytes=${SHARE_CHUNK + 990}-`);
        assert.ok(a.subarray(SHARE_CHUNK + 990).equals(r.data));
        r = await audio(q, "bytes=-5");
        assert.equal(r.headers["content-range"], `bytes ${long - 5}-${long - 1}/${long}`);
        assert.equal((await audio(q, `bytes=${long}-`)).status, 416);
        assert.equal((await audio(q.replace(/sig=[^&]+/, "sig=x"))).status, 403, "a forged URL");
        assert.equal((await audio(q.replace(/id=0/, "id=1"))).status, 403, "the signature is for one song");
        assert.equal((await audio(q.replace(/n=\d+/, "n=99"))).status, 403, "and its size");
        assert.equal((await audio(q.replace(/t=[^&]+/, "t=text%2Fhtml"))).status, 403, "and its type");
        assert.equal(r.headers["cache-control"], "private, max-age=600", "the browser may keep a piece (seeking back)");
        clock = new Date(clock.getTime() + 11 * 60_000);
        assert.equal((await audio(q, "bytes=0-")).data.code, "SHARE_URL_EXPIRED", "10 minutes only");

        // a week later the link is gone, and the next owner request removes its songs
        clock = new Date(clock.getTime() + 7 * 86400_000);
        const expired = await call(api, "GET", "share-open", { query: `?code=${code}` });
        assert.equal(expired.status, 410);
        assert.equal(expired.data.code, "SHARE_EXPIRED");
        assert.equal(expired.data.name, "Chill", "the page says which playlist it was");
        assert.equal(expired.data.expiredAt, new Date("2026-10-29T00:00:00Z").getTime() + 7 * 86400_000);
        assert.equal(expired.data.songs, undefined, "and nothing more");
        assert.equal((await put(api, token, code, 1, 0, b)).status, 404, "nothing more is uploaded");
        assert.equal((await call(api, "GET", "share-list", { token })).data.shares.length, 0);
        assert.equal([...objects.keys()].filter((k) => k.startsWith(`s/${code}/`)).length, 0);
        assert.equal(
          (await call(api, "GET", "share-open", { query: `?code=${code}` })).data.code,
          "SHARE_GONE",
          "removed by the sweep: not found",
        );
        assert.equal((await call(api, "GET", "share-open", { query: "?code=nope" })).status, 404);
      });

      for (const answer of ["refused", "partly"])
        test(`revoking removes every song from R2 even when DeleteObjects is ${answer}: one DELETE each`, async () => {
          const api = h();
          const { token } = (await call(api, "POST", "login", { body: { session: SESSION_A } })).data;
          const { code } = (
            await call(api, "POST", "share-create", {
              token,
              body: { playlistId: "p9", name: "Pop", days: 1, songs: [song("x", 10, "2|5"), song("y", 10, "2|6")] },
            })
          ).data.share;
          await put(api, token, code, 0, 0, bytes(10, 3));
          await put(api, token, code, 1, 0, bytes(10, 4));
          r2Batch = answer;
          try {
            assert.deepEqual((await call(api, "POST", "share-revoke", { token, body: { code } })).data, { ok: true });
          } finally {
            r2Batch = "ok";
          }
          assert.deepEqual(
            [...objects.keys()].filter((k) => k.startsWith(`s/${code}/`)),
            [],
          );
          assert.equal((await call(api, "GET", "share-open", { query: `?code=${code}` })).data.code, "SHARE_GONE");
        });

      test("sync: new songs are added (to upload), those taken out leave the link and R2, the rest stay as they are", async () => {
        const api = h();
        const { token } = (await call(api, "POST", "login", { body: { session: SESSION_A } })).data;
        const { code } = (
          await call(api, "POST", "share-create", {
            token,
            body: {
              playlistId: "s1",
              name: "Sync",
              days: 7,
              songs: [song("a", 10, "3|1"), song("b", 10, "3|2"), song("c", 10, "3|3")],
              skipped: ["3|9"],
            },
          })
        ).data.share;
        for (const id of [0, 1, 2]) await put(api, token, code, id, 0, bytes(10, id));
        let list = (await call(api, "GET", "share-list", { token })).data.shares.find((x) => x.code === code);
        assert.deepEqual([list.refs, list.skipped], [["3|1", "3|2", "3|3"], ["3|9"]], "what the dialog compares with");
        assert.deepEqual(list.skippedInfo, [{ ref: "3|9", why: null, name: null }], "a ref alone: no reason known");

        // the playlist now: c first, a, a new d; b taken out
        const r = await call(api, "POST", "share-sync", {
          token,
          body: { code, songs: [song("c", 10, "3|3"), song("a", 10, "3|1"), song("d", 20, "3|4")], skipped: ["3|9"] },
        });
        assert.equal(r.status, 200);
        assert.deepEqual([r.data.added, r.data.removed], [1, 1]);
        assert.deepEqual(r.data.pending, [{ id: 3, ref: "3|4" }], "only the new song is uploaded");
        assert.equal(objects.has(`s/${code}/1/0`), false, "b left R2");
        assert.equal(objects.has(`s/${code}/0/0`) && objects.has(`s/${code}/2/0`), true, "a and c stayed");
        let open = (await call(api, "GET", "share-open", { query: `?code=${code}` })).data;
        assert.deepEqual(
          open.songs.map((x) => [x.title, x.id, x.ready]),
          [
            ["c", 2, true],
            ["a", 0, true],
            ["d", 3, false],
          ],
          "the playlist's order; the songs keep their place in R2",
        );
        // c still plays from where it was
        const c = await call(api, "GET", "share-audio", {
          query: open.songs[0].url.slice(open.songs[0].url.indexOf("?")),
        });
        assert.ok(bytes(10, 2).equals(c.data));
        // the new one uploads by its id
        assert.equal((await put(api, token, code, 3, 0, bytes(20, 3))).status, 200);
        assert.equal((await put(api, token, code, 1, 0, bytes(10, 1))).data.code, "SHARE_SONG_GONE", "b is gone");
        open = (await call(api, "GET", "share-open", { query: `?code=${code}` })).data;
        assert.deepEqual(
          open.songs.map((x) => x.ready),
          [true, true, true],
        );
        // nothing changed: nothing to do
        const again = await call(api, "POST", "share-sync", {
          token,
          body: { code, songs: [song("c", 10, "3|3"), song("a", 10, "3|1"), song("d", 20, "3|4")] },
        });
        assert.deepEqual([again.data.added, again.data.removed, again.data.pending], [0, 0, []]);
        // the reasons the owner's page sends are kept, for the dialog (bad ones dropped)
        const why = await call(api, "POST", "share-sync", {
          token,
          body: {
            code,
            songs: [song("c", 10, "3|3"), song("a", 10, "3|1"), song("d", 20, "3|4")],
            skipped: [{ ref: "3|9", why: "big", name: "Mix 2 giờ" }, { ref: "3|8", why: "nope" }, { ref: "bad" }],
          },
        });
        assert.deepEqual(why.data.share.skippedInfo, [
          { ref: "3|9", why: "big", name: "Mix 2 giờ" },
          { ref: "3|8", why: null, name: null },
        ]);
        assert.deepEqual(why.data.share.skipped, ["3|9", "3|8"]);
        assert.equal(
          (await call(api, "POST", "share-sync", { token, body: { code, songs: [] } })).status,
          400,
          "an empty playlist does not empty the link",
        );
      });

      test("extend: days more from the current end, 90 days after the link was made at most", async () => {
        const api = h();
        const { token } = (await call(api, "POST", "login", { body: { session: SESSION_A } })).data;
        const made = clock.getTime();
        const { code, expiresAt } = (
          await call(api, "POST", "share-create", {
            token,
            body: { playlistId: "e1", name: "Ext", days: 30, songs: [song("a", 10, "4|1")] },
          })
        ).data.share;
        assert.equal(expiresAt, made + 30 * 86400_000);
        const extend = (days, t = token) => call(api, "POST", "share-extend", { token: t, body: { code, days } });
        assert.equal((await extend(3)).status, 400);
        let r = await extend(7);
        assert.equal(r.data.share.expiresAt, made + 37 * 86400_000, "added to the current end");
        assert.equal(r.data.capped, false);
        const other = (await call(api, "POST", "login", { body: { session: SESSION_B } })).data.token;
        assert.equal((await extend(7, other)).status, 404, "not B's link");
        await extend(30);
        r = await extend(30);
        assert.equal(r.data.share.expiresAt, made + 90 * 86400_000, "90 days at most");
        assert.equal(r.data.capped, true);
        assert.equal((await extend(1)).data.code, "SHARE_MAX");
        assert.equal(
          (await call(api, "GET", "share-open", { query: `?code=${code}` })).data.expiresAt,
          made + 90 * 86400_000,
        );
      });

      test("a link made before song ids keeps playing its songs, and gets ids on the owner's next request", async () => {
        const api = h();
        const { token } = (await call(api, "POST", "login", { body: { session: SESSION_A } })).data;
        const { code } = (
          await call(api, "POST", "share-create", {
            token,
            body: { playlistId: "l1", name: "Old", days: 7, songs: [song("a", 10, "5|1"), song("b", 10, "5|2")] },
          })
        ).data.share;
        await put(api, token, code, 0, 0, bytes(10, 7));
        // as such a link is stored: no ids, no nextId
        const col = raw.db("shares").collection("shares");
        const doc = await col.findOne({ _id: code });
        await col.updateOne(
          { _id: code },
          { $set: { songs: doc.songs.map(({ id, ...x }) => x) }, $unset: { nextId: "", skipped: "" } },
        );
        let open = (await call(api, "GET", "share-open", { query: `?code=${code}` })).data;
        assert.deepEqual(
          open.songs.map((x) => x.id),
          [0, 1],
        );
        const a = await call(api, "GET", "share-audio", {
          query: open.songs[0].url.slice(open.songs[0].url.indexOf("?")),
        });
        assert.ok(bytes(10, 7).equals(a.data), "played from where it was");
        // an upload sent the old way (i = index) still lands in its place
        const old = await call(api, "POST", "share-put", {
          token,
          query: `?code=${code}&i=1&k=0`,
          raw: bytes(10, 8),
          type: "application/octet-stream",
        });
        assert.equal(old.status, 200);
        const now = await col.findOne({ _id: code });
        assert.deepEqual(
          now.songs.map((x) => [x.id, x.ok]),
          [
            [0, true],
            [1, true],
          ],
        );
        assert.equal(now.nextId, 2);
      });

      test("revoking closes the link at once and removes its songs", async () => {
        const api = h();
        const { token } = (await call(api, "POST", "login", { body: { session: SESSION_A } })).data;
        const { code } = (
          await call(api, "POST", "share-create", {
            token,
            body: { playlistId: "p2", name: "Rock", days: 1, songs: [song("x", 10, "2|5")] },
          })
        ).data.share;
        await put(api, token, code, 0, 0, bytes(10, 3));
        assert.equal(objects.has(`s/${code}/0/0`), true);
        assert.equal((await call(api, "GET", "share-open", { query: `?code=${code}` })).status, 200);
        assert.deepEqual((await call(api, "POST", "share-revoke", { token, body: { code } })).data, { ok: true });
        assert.equal((await call(api, "GET", "share-open", { query: `?code=${code}` })).status, 404);
        assert.equal(objects.has(`s/${code}/0/0`), false);
      });

      // what someone could try: an owner is anyone with a Telegram account, a listener anyone with the link
      describe("abuse", () => {
        const abuse = (extra) =>
          createCloudApi({
            env: { ...env(), MONGODB_DB: "abuse", ...R2 },
            verify,
            fetchFn: r2,
            now: () => clock,
            ...extra,
          });
        const many = (n, chat, size = SHARE_FILE_MAX) =>
          Array.from({ length: n }, (_, i) => song(`s${i}`, size, `${chat}|${i + 1}`));
        before(() => raw.db("abuse").dropDatabase());

        test("an account cannot park terabytes in R2: its open links hold SHARE_ACCOUNT_BYTES at most", async () => {
          const api = abuse();
          const { token } = (await call(api, "POST", "login", { body: { session: SESSION_A } })).data;
          const create = (songs, id) =>
            call(api, "POST", "share-create", { token, body: { playlistId: id, name: "X", days: 30, songs } });
          const fit = Math.floor(SHARE_ACCOUNT_BYTES / SHARE_FILE_MAX);
          let r = await create(many(SHARE_SONGS_MAX, 1), "q1"); // 1000 × 100 MB
          assert.equal(r.status, 400);
          assert.equal(r.data.code, "SHARE_QUOTA");
          const half = Math.floor(fit / 2);
          r = await create(many(half, 2), "q2");
          assert.equal(r.status, 200);
          const { code } = r.data.share;
          assert.equal((await create(many(fit - half + 1, 3), "q3")).data.code, "SHARE_QUOTA", "together past it");
          // a sync may not grow a link past it either, but may make one smaller
          r = await call(api, "POST", "share-sync", { token, body: { code, songs: many(fit + 1, 2) } });
          assert.equal(r.data.code, "SHARE_QUOTA");
          r = await call(api, "POST", "share-sync", { token, body: { code, songs: many(1, 2) } });
          assert.equal(r.status, 200);
          assert.equal(r.data.share.count, 1);
        });

        test("links made all at once do not get past the limits", async () => {
          const api = abuse();
          const { token } = (await call(api, "POST", "login", { body: { session: SESSION_B } })).data;
          const create = (i) =>
            call(api, "POST", "share-create", {
              token,
              body: { playlistId: `r${i}`, name: "R", days: 1, songs: [song("a", 10, `7|${i + 1}`)] },
            });
          const burst = await Promise.all(Array.from({ length: SHARES_PER_ACCOUNT + 10 }, (_, i) => create(i)));
          const made = burst.filter((r) => r.status === 200).length;
          assert.ok(made >= 1 && made <= SHARES_PER_ACCOUNT, `${made} links`);
          assert.ok(burst.every((r) => r.status === 200 || r.data.code === "SHARE_BUSY"));
          // one after another (as the page does): up to the limit, not one more
          let n = made;
          while (n < SHARES_PER_ACCOUNT) assert.equal((await create(100 + n++)).status, 200);
          assert.equal((await create(999)).status, 400);
          assert.equal((await call(api, "GET", "share-list", { token })).data.shares.length, SHARES_PER_ACCOUNT);
        });

        test("a song is not written to R2 over and over: once playable it stays, and a day's uploads are capped", async () => {
          let writes = 0;
          const counting = (url, opts = {}) => {
            if (opts.method === "PUT") writes++;
            return r2(url, opts);
          };
          const api = abuse({ fetchFn: counting, shareLimits: { dayBytes: 2 * SHARE_CHUNK } });
          const { token } = (await call(api, "POST", "login", { body: { session: SESSION_A } })).data;
          const { code } = (
            await call(api, "POST", "share-create", {
              token,
              body: {
                playlistId: "w1",
                name: "W",
                days: 7,
                songs: [song("a", 10, "6|1"), song("b", SHARE_CHUNK + 10, "6|2")],
              },
            })
          ).data.share;
          assert.equal((await put(api, token, code, 0, 0, bytes(10, 1))).status, 200);
          for (let i = 0; i < 5; i++) assert.equal((await put(api, token, code, 0, 0, bytes(10, 2))).status, 200);
          assert.equal(writes, 1, "a playable song is not written again");
          const open = (await call(api, "GET", "share-open", { query: `?code=${code}` })).data;
          const first = await call(api, "GET", "share-audio", {
            query: open.songs[0].url.slice(open.songs[0].url.indexOf("?")),
          });
          assert.ok(bytes(10, 1).equals(first.data), "what the listener hears is what was sent first");
          // the first piece of an unfinished song, sent again and again: the day's quota stops it
          const piece = bytes(SHARE_CHUNK, 3);
          assert.equal((await put(api, token, code, 1, 0, piece)).status, 200);
          const r = await put(api, token, code, 1, 0, piece);
          assert.equal(r.status, 429);
          assert.equal(r.data.code, "SHARE_DAY_LIMIT");
          assert.equal(writes, 2);
          // the next day: it goes on
          clock = new Date(clock.getTime() + 86400_000);
          assert.equal((await put(api, token, code, 1, 1, bytes(10, 4))).status, 200);
        });

        test("nothing the function answers runs as a page, whatever bytes were uploaded", async () => {
          const api = abuse();
          const { token } = (await call(api, "POST", "login", { body: { session: SESSION_B } })).data;
          // B's links of the test before: revoked, room for one
          for (const l of (await call(api, "GET", "share-list", { token })).data.shares)
            await call(api, "POST", "share-revoke", { token, body: { code: l.code } });
          const html = Buffer.from("<script>alert(document.cookie)</script>");
          const { code } = (
            await call(api, "POST", "share-create", {
              token,
              body: {
                playlistId: "x1",
                name: "<img src=x onerror=alert(1)>",
                days: 1,
                songs: [song("x", html.length, "4|1")],
              },
            })
          ).data.share;
          await put(api, token, code, 0, 0, html);
          const open = await call(api, "GET", "share-open", { query: `?code=${code}` });
          assert.match(open.headers["content-security-policy"], /sandbox/);
          const url = open.data.songs[0].url;
          const a = await call(api, "GET", "share-audio", { query: url.slice(url.indexOf("?")) });
          assert.equal(a.status, 206);
          assert.equal(a.headers["content-type"], "audio/mpeg");
          assert.match(a.headers["content-security-policy"], /sandbox/);
        });
      });
    });
  });

  describe("server.js with MONGODB_URI", () => {
    const TOKEN = "t-cloud-" + Date.now();
    const freePort = () =>
      new Promise((r) => {
        const s = net.createServer().listen(0, () => {
          const p = s.address().port;
          s.close(() => r(p));
        });
      });

    async function startServer(dataDir, extra = {}) {
      const port = await freePort();
      const proc = spawn(process.execPath, ["server.js"], {
        cwd: ROOT,
        env: {
          ...process.env,
          PORT: String(port),
          UI_TOKEN: TOKEN,
          TDL_DATA_DIR: dataDir,
          TDL_ENV_FILE: path.join(tmp, "none.env"),
          API_FILE: path.join(dataDir, "api.json"),
          MONGODB_URI: uri,
          MONGODB_DB: "server",
          TDL_SECRET: "server secret 1234",
          ...extra,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      await new Promise((resolve, reject) => {
        proc.stdout.on("data", (d) => {
          out += d;
          if (out.includes("Telegram downloader UI")) resolve();
        });
        proc.stderr.on("data", (d) => (out += d));
        proc.on("exit", (code) => reject(new Error(`server exited ${code}: ${out}`)));
      });
      const call = async (p, body) =>
        (
          await fetch(`http://127.0.0.1:${port}${p}`, {
            method: body ? "POST" : "GET",
            headers: { Cookie: `tdl_token=${TOKEN}`, ...(body && { "Content-Type": "application/json" }) },
            body: body && JSON.stringify(body),
          })
        ).json();
      return { proc, call, out: () => out };
    }

    test(
      "settings saved on one server are there for a server started on an empty data folder",
      { timeout: 60_000 },
      async () => {
        const a = fs.mkdtempSync(path.join(tmp, "srv-a-"));
        const s1 = await startServer(a);
        try {
          assert.equal((await s1.call("/api/cloud")).connected, true);
          await s1.call("/api/settings", { subfolderPerChat: false });
          await new Promise((r) => setTimeout(r, 300));
        } finally {
          s1.proc.kill();
        }
        const b = fs.mkdtempSync(path.join(tmp, "srv-b-"));
        const s2 = await startServer(b);
        try {
          assert.equal((await s2.call("/api/settings")).subfolderPerChat, false);
          const st = await s2.call("/api/cloud");
          assert.equal(st.host, "127.0.0.1");
          assert.ok(!JSON.stringify(st).includes("mongodb://"), "the connection string is never sent to the page");
        } finally {
          s2.proc.kill();
        }
      },
    );

    test(
      "unreachable cluster: the server still starts and keeps the data in its files",
      { timeout: 60_000 },
      async () => {
        const a = fs.mkdtempSync(path.join(tmp, "srv-c-"));
        const s = await startServer(a, {
          MONGODB_URI: "mongodb://127.0.0.1:1/?directConnection=true",
          TDL_MONGO_TIMEOUT_MS: "500",
        });
        try {
          const st = await s.call("/api/cloud");
          assert.equal(st.enabled, true);
          assert.equal(st.connected, false);
          await s.call("/api/settings", { subfolderPerChat: false });
          assert.equal(JSON.parse(fs.readFileSync(path.join(a, "settings.json"), "utf8")).subfolderPerChat, false);
          assert.match(s.out(), /không kết nối được/);
        } finally {
          s.proc.kill();
        }
      },
    );

    test("no MONGODB_URI: nothing to sync, reported as disabled", { timeout: 30_000 }, async () => {
      const a = fs.mkdtempSync(path.join(tmp, "srv-d-"));
      const s = await startServer(a, { MONGODB_URI: "" });
      try {
        assert.deepEqual(await s.call("/api/cloud"), {
          enabled: false,
          connected: false,
          host: null,
          error: null,
          lastSync: null,
          kind: "local",
        });
      } finally {
        s.proc.kill();
      }
    });
  });

  describe("shared account data: every device sees the same", () => {
    const KEYS = {
      session: "tdl.session",
      api: "tdl.api",
      settings: "tdl.settings",
      history: "tdl.history",
      visibleChats: "tdl.visibleChats",
      favorites: "tdl.favorites",
      recent: "tdl.recent",
      playlists: "tdl.playlists",
    };
    const env = {
      MONGODB_URI: "",
      MONGODB_DB: "shared",
      TDL_SECRET: "shared account secret 123",
      TG_API_ID: "1",
      TG_API_HASH: "0123456789abcdef0123456789abcdef",
    };
    let handler;
    let db;
    before(async () => {
      env.MONGODB_URI = uri;
      handler = createCloudApi({
        env,
        verify: async (s) => (s === SESSION_A ? "111" : s === SESSION_B ? "222" : Promise.reject(new Error("no"))),
      });
      db = await openDb(uri, { dbName: "shared" });
    });
    const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));

    /** fetch() that goes straight into the handler, like the browser calling the Vercel function. */
    const fetchVia = (h) => async (url, opts) => {
      const req = Readable.from(opts.body ? [Buffer.from(opts.body)] : []);
      Object.assign(req, {
        method: opts.method,
        headers: Object.fromEntries(Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), v])),
      });
      const res = {
        statusCode: 200,
        body: "",
        setHeader() {},
        end(b) {
          this.body = b;
        },
      };
      await h(req, res, url.split("/").pop());
      return { ok: res.statusCode < 400, status: res.statusCode, json: async () => JSON.parse(res.body) };
    };

    /** One browser (the web app): its own localStorage and app data. */
    function browser({ session = SESSION_A, account = "111", favorites = [], history = [], fetchFn } = {}) {
      const ls = new Map();
      const app = { account, history, subfolderPerChat: true };
      let sync = null;
      const store = {
        load: (k, f) => (ls.has(k) ? JSON.parse(ls.get(k)) : f),
        save: (k, v) => {
          v === undefined ? ls.delete(k) : ls.set(k, JSON.stringify(v));
          sync?.changed(k);
        },
      };
      store.save(KEYS.session, session);
      store.save(KEYS.favorites, favorites.length ? { [account]: favorites } : {});
      sync = createCloudSync({
        store,
        keys: KEYS,
        signedIn: () => app.account,
        fetchFn: fetchFn || fetchVia(handler),
        debounceMs: 5,
        pullMs: 3_600_000,
        read: (name, acc) =>
          name === "settings"
            ? { subfolderPerChat: app.subfolderPerChat }
            : name === "history"
              ? app.history
              : name === "visibleChats"
                ? (store.load(KEYS.visibleChats, {})[acc] ?? null)
                : store.load(KEYS[name], {})[acc] || [],
        apply: (name, value, acc) => {
          if (name === "settings") app.subfolderPerChat = value.subfolderPerChat;
          else if (name === "history") app.history = value;
          else store.save(KEYS[name], { ...store.load(KEYS[name], {}), [acc]: value });
        },
      });
      const favs = () => store.load(KEYS.favorites, {})[account] || [];
      const heart = (id) =>
        store.save(KEYS.favorites, {
          ...store.load(KEYS.favorites, {}),
          [account]: [id, ...favs().filter((x) => x !== id)],
        });
      const unheart = (id) =>
        store.save(KEYS.favorites, { ...store.load(KEYS.favorites, {}), [account]: favs().filter((x) => x !== id) });
      const download = (entry) => {
        app.history = [entry, ...app.history];
        store.save(KEYS.history, app.history);
      };
      return { ls, app, store, sync, favs, heart, unheart, download };
    }

    /** The local server: the same shared logic, straight to MongoDB (as server.js does). */
    function computer(acc = "111", data = {}) {
      const app = {
        history: data.history || [],
        favorites: data.favorites || [],
        recent: data.recent || [],
        playlists: data.playlists || [],
        visibleChats: data.visibleChats ?? null,
        subfolderPerChat: data.subfolderPerChat ?? true,
      };
      let sync = null;
      sync = createAccountSync({
        read: (name) => (name === "settings" ? { subfolderPerChat: app.subfolderPerChat } : app[name]),
        apply: (name, value) => {
          if (name === "settings") app.subfolderPerChat = value.subfolderPerChat;
          else app[name] = value;
        },
        debounceMs: 5,
        pullMs: 3_600_000,
      });
      const transport = {
        join: (d) => joinAccount(db, acc, d),
        ops: (n, o) => applyOps(db, acc, n, checkOps(n, o)),
        read: () => readAccount(db, acc),
      };
      return {
        app,
        sync,
        start: () => sync.start(transport),
        change: (name, value) => {
          app[name] = value;
          sync.changed(name);
        },
      };
    }

    test("joining merges: nothing this device had is lost, nothing MongoDB had is lost", async () => {
      const pc = computer("111", {
        favorites: ["1|1", "1|2"],
        history: [{ id: 1, at: 10, name: "pc.mp3" }],
        subfolderPerChat: false,
      });
      await pc.start();
      const web = browser({ favorites: ["9|9", "1|2"], history: [{ id: 1, at: 20, name: "web.mp3" }] });
      assert.equal(await web.sync.sync("111"), true);
      assert.deepEqual(new Set(web.favs()), new Set(["1|1", "1|2", "9|9"]));
      assert.deepEqual(
        web.app.history.map((h) => h.name),
        ["web.mp3", "pc.mp3"],
        "same old id 1 on two devices: both kept",
      );
      assert.equal(web.app.subfolderPerChat, false, "MongoDB's setting (from the computer) wins");
      await pc.sync.pull();
      assert.deepEqual(
        new Set(pc.app.favorites),
        new Set(["1|1", "1|2", "9|9"]),
        "the computer gets the web app's favourites",
      );
      assert.equal(pc.app.history.length, 2);
    });

    test("changes on one device reach the others (computer ⇄ web app)", async () => {
      const pc = computer("111");
      await pc.start();
      const web = browser();
      await web.sync.sync("111");
      web.heart("7|7");
      web.download({ id: 1_790_000_000_000_001, at: 30, name: "new-on-web.mp3" });
      await wait();
      await web.sync.flush();
      await pc.sync.pull();
      assert.equal(pc.app.favorites[0], "7|7");
      assert.equal(pc.app.history[0].name, "new-on-web.mp3");
      pc.change(
        "favorites",
        pc.app.favorites.filter((x) => x !== "9|9"),
      );
      pc.change("visibleChats", ["1", "7"]);
      await wait();
      await pc.sync.flush();
      await web.sync.pull();
      assert.ok(!web.favs().includes("9|9"), "removed on the computer, gone on the web app");
      // a song played on the computer shows in "Phát gần đây" of the web app, and the other way round
      pc.change("recent", [{ id: "5|50", at: 100, name: "pc.mp3" }, ...pc.app.recent]);
      await wait();
      await pc.sync.flush();
      await web.sync.pull();
      assert.equal(web.store.load(KEYS.recent)["111"][0].id, "5|50");
      assert.deepEqual(web.store.load(KEYS.visibleChats)["111"], ["1", "7"]);
    });

    test("playlists: made, renamed, reordered, deleted on one device; two devices on two playlists keep both", async () => {
      const a = computer("111");
      const b = computer("111");
      await a.start();
      await b.start();
      const edit = (dev, change) => {
        const r = editPlaylists(dev.app.playlists, change);
        dev.change("playlists", r.playlists);
        return r.id;
      };
      const chill = edit(a, { op: "create", name: "Chill", songs: ["1|1", "1|2"] });
      await wait();
      await a.sync.flush();
      await b.sync.pull();
      assert.deepEqual(
        b.app.playlists.map((p) => [p.name, p.songs]),
        [["Chill", ["1|1", "1|2"]]],
      );
      // at the same time: a renames and reorders "Chill", b makes "Gym"
      edit(a, { op: "rename", id: chill, name: "Chill out" });
      edit(a, { op: "order", id: chill, songs: ["1|2", "1|1"] });
      edit(b, { op: "create", name: "Gym", songs: ["2|1"] });
      await wait();
      await a.sync.flush();
      await b.sync.flush();
      await a.sync.pull();
      await b.sync.pull();
      for (const dev of [a, b])
        assert.deepEqual(
          sortPlaylists(dev.app.playlists).map((p) => [p.name, p.songs]),
          [
            ["Gym", ["2|1"]],
            ["Chill out", ["1|2", "1|1"]],
          ],
        );
      edit(b, { op: "delete", id: chill });
      await wait();
      await b.sync.flush();
      await a.sync.pull();
      assert.deepEqual(
        a.app.playlists.map((p) => p.name),
        ["Gym"],
        "deleted on one device, gone on the other",
      );
      // a device that does not know playlists (an older app) joins: they stay in MongoDB
      assert.equal((await readAccount(db, "111")).playlists.length, 1);
      const old = await joinAccount(db, "111", { favorites: [] });
      assert.equal(old.playlists.length, 1);
      assert.equal(checkOps("playlists", [{ op: "put", playlist: { id: "x", name: "", songs: [] } }]), undefined);
    });

    test("two devices changing things at the same time lose nothing", async () => {
      const a = browser();
      const b = browser();
      await a.sync.sync("111");
      await b.sync.sync("111");
      a.heart("21|1");
      b.heart("22|2");
      a.download({ id: 1_790_000_000_000_101, at: 40, name: "a.mp3" });
      b.download({ id: 1_790_000_000_000_102, at: 41, name: "b.mp3" });
      await wait();
      await Promise.all([a.sync.flush(), b.sync.flush()]);
      await a.sync.pull();
      await b.sync.pull();
      for (const d of [a, b]) {
        assert.ok(d.favs().includes("21|1") && d.favs().includes("22|2"), "both hearts");
        assert.ok(
          ["a.mp3", "b.mp3"].every((n) => d.app.history.some((h) => h.name === n)),
          "both downloads",
        );
      }
    });

    test("what came from MongoDB is not sent straight back; other accounts stay separate", async () => {
      let ops = 0;
      const counting = async (url, opts) => {
        if (url.endsWith("/ops")) ops++;
        return fetchVia(handler)(url, opts);
      };
      const d = browser({ fetchFn: counting });
      await d.sync.sync("111");
      await d.sync.pull();
      await wait();
      assert.equal(ops, 0);
      const other = browser({ session: SESSION_B, account: "222" });
      await other.sync.sync("222");
      assert.deepEqual(other.favs(), []);
      assert.deepEqual(other.app.history, []);
    });

    test("sign out: pending changes are sent, clearing this browser afterwards deletes nothing in MongoDB", async () => {
      const d = browser();
      await d.sync.sync("111");
      const before = (await readAccount(db, "111")).history.length;
      d.heart("33|3"); // not uploaded yet (debounce)
      const token = d.store.load("tdl.cloudToken").token;
      const out = d.sync.signOut();
      d.app.account = null;
      d.app.history = []; // what the web app does right after signing out
      d.store.save(KEYS.history, []);
      d.store.save(KEYS.favorites, {});
      await out;
      await wait();
      const after = await readAccount(db, "111");
      assert.equal(after.history.length, before, "history kept");
      assert.equal(after.favorites[0], "33|3", "the last heart made it");
      assert.equal(
        (await fetchVia(handler)("/api/cloud/data", { method: "GET", headers: { Authorization: `Bearer ${token}` } }))
          .status,
        401,
        "token revoked",
      );
    });

    test("not deployed (404) or not configured: quietly local, no retry; unreachable: retry later", async () => {
      for (const reply of [
        { status: 404, body: {} },
        { status: 503, body: { code: "CLOUD_OFF" } },
      ]) {
        const fetchFn = async () => ({ ok: false, status: reply.status, json: async () => reply.body });
        const timers = { setTimeout: () => assert.fail("no retry expected"), clearTimeout() {} };
        const d = browser({ fetchFn });
        const s2 = createCloudSync({
          store: d.store,
          keys: KEYS,
          signedIn: () => "111",
          read: () => null,
          apply() {},
          fetchFn,
          timers,
        });
        assert.equal(await s2.sync("111"), false);
        assert.deepEqual([s2.status.enabled, s2.status.connected, s2.status.error], [false, false, null]);
      }
      const scheduled = [];
      const fetchFn = async () => {
        throw new Error("Failed to fetch");
      };
      const d = browser({ fetchFn });
      const s3 = createCloudSync({
        store: d.store,
        keys: KEYS,
        signedIn: () => "111",
        read: () => null,
        apply() {},
        fetchFn,
        timers: { setTimeout: (fn, ms) => scheduled.push(ms), clearTimeout() {} },
      });
      assert.equal(await s3.sync("111"), false);
      assert.match(s3.status.error, /Failed to fetch/);
      assert.deepEqual(scheduled, [60_000]);
    });

    test("restore: device token but no session -> the session comes back from MongoDB", async () => {
      const d = browser();
      await d.sync.sync("111");
      d.store.save(KEYS.session, undefined);
      assert.equal(await d.sync.restoreSession(), true);
      assert.equal(d.store.load(KEYS.session), SESSION_A);
      assert.equal(await d.sync.restoreSession(), false, "nothing to restore while a session is there");
    });
  });
}); // MongoDB storage
