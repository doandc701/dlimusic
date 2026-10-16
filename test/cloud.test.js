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
import { createCloudSync, createAccountSync } from "../web/cloud-sync.js";
import { readAccount, joinAccount, applyOps, checkOps } from "../cloud/account.js";

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
    async function call(handle, method, action, { body, token, raw: rawBody, type = "application/json" } = {}) {
      const text = rawBody ?? (body === undefined ? "" : JSON.stringify(body));
      const req = Readable.from(method === "POST" ? [Buffer.from(text)] : []);
      Object.assign(req, {
        method,
        headers: {
          ...(method === "POST" && { "content-type": type }),
          ...(token && { authorization: `Bearer ${token}` }),
        },
      });
      const res = {
        headers: {},
        statusCode: 200,
        body: "",
        setHeader(k, v) {
          this.headers[k.toLowerCase()] = v;
        },
        end(b) {
          this.body = b;
        },
      };
      await handle(req, res, action);
      return { status: res.statusCode, data: JSON.parse(res.body), headers: res.headers };
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
      assert.deepEqual(a.data.data, { settings: null, history: [], visibleChats: null, favorites: [], recent: [] });
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
      assert.deepEqual(b.data.data, { settings: null, history: [], visibleChats: null, favorites: [], recent: [] });
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
      assert.equal((await call(h, "POST", "logout", { token: app.data.token, body: { keepSession: true } })).status, 200);
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
