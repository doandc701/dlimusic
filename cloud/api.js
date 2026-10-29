// /api/cloud/* for the browser version (Vercel functions): keeps each Telegram account's data in MongoDB.
//
// Who is who: the browser signs in to Telegram by itself, then sends its session to POST /api/cloud/login.
// The server asks Telegram with that session which account it belongs to (getMe) — the only proof that
// cannot be faked — stores the session encrypted and answers with a random device token. Every other
// call carries `Authorization: Bearer <token>`; only the token's account can be read or written.
//
//   POST /api/cloud/login    { session, api, keepSession? } -> { token, accountId, data }
//                            keepSession: true (the phone app): the session only proves the account, it is not
//                            stored — the one kept for the browser version stays (two devices on one session
//                            would make Telegram drop it: AUTH_KEY_DUPLICATED)
//   GET  /api/cloud/data                              -> { settings, history, visibleChats, favorites }
//   POST /api/cloud/join     { data }                 -> { data }      (this device's copy merged with MongoDB's)
//   POST /api/cloud/ops      { name, ops }            -> { ok }        (changes as operations, see core.js)
//   GET  /api/cloud/session                           -> { session, api }   (restore on this device)
//   POST /api/cloud/session  { session }              -> { ok }        (GramJS saved a new session)
//   POST /api/cloud/logout   { keepSession? }         -> { ok }        (forget the session, revoke the token;
//                                                                         keepSession: the token only)
//   GET  /api/cloud/status                            -> { enabled }   (no token needed)
//   /api/cloud/share-*                                 shared playlists (cloud/share.js); share-put takes raw
//                                                      bytes, share-audio answers with them

import {
  openDb,
  getValues,
  setValue,
  deleteValue,
  encrypt,
  decrypt,
  keyFromSecret,
  issueToken,
  accountForToken,
  revokeToken,
  normalizeApi,
  isSessionString,
  isMongoUri,
} from "./common.js";
import { readAccount, joinAccount, checkOps, applyOps } from "./account.js";
import { SHARE_CHUNK } from "../core.js";
import { shareRoutes, RAW_BODY, RAW } from "./share.js";

const MAX_BODY = 2 * 1024 * 1024;

const fail = (status, error, code) => Object.assign(new Error(error), { status, code });

/**
 * @param env      { MONGODB_URI, MONGODB_DB, TDL_SECRET, TG_API_ID, TG_API_HASH }
 * @param verify   async (session, creds) => account id; asks Telegram (injected in tests)
 * @param fetchFn  fetch, for Cloudflare R2 (injected in tests)
 */
export function createCloudApi({ env, verify, fetchFn, now }) {
  const ready = isMongoUri(env.MONGODB_URI) && String(env.TDL_SECRET || "").length >= 16;
  const key = ready ? keyFromSecret(env.TDL_SECRET) : null;
  const builtin = () => {
    const id = Number(env.TG_API_ID);
    return Number.isInteger(id) && id > 0 && /^[0-9a-f]{32}$/i.test(env.TG_API_HASH || "")
      ? { id, hash: env.TG_API_HASH }
      : null;
  };
  const db = () => openDb(env.MONGODB_URI.trim(), { dbName: env.MONGODB_DB || undefined });
  const id = (account, name) => `acct:${account}:${name}`;

  async function account(req) {
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization || "")?.[1];
    const acc = token && (await accountForToken(await db(), token));
    if (!acc) throw fail(401, "Phiên đồng bộ đã hết hạn, hãy đăng nhập lại", "CLOUD_AUTH");
    return { acc, token };
  }

  const readData = async (acc) => readAccount(await db(), acc);

  async function saveApi(acc, api) {
    // the user's own API hash is a credential: stored encrypted like the session
    const value = api.mode === "builtin" ? api : { box: encrypt(JSON.stringify(api), key) };
    await setValue(await db(), id(acc, "api"), value);
  }

  const routes = {
    "GET status": async () => ({ enabled: ready }),

    "POST login": async (req, body) => {
      if (!isSessionString(body.session)) throw fail(400, "Phiên Telegram không hợp lệ");
      const api = normalizeApi(body.api ?? { mode: "builtin" });
      if (!api) throw fail(400, "API ID / hash không hợp lệ");
      const creds = api.mode === "builtin" ? builtin() : api;
      if (!creds) throw fail(400, "Máy chủ chưa có API dựng sẵn, hãy dùng API ID của bạn");
      let acc;
      try {
        acc = String(await verify(body.session, creds));
      } catch (err) {
        console.error("cloud login: Telegram did not confirm the session:", err?.message || err); // shown in the function logs
        throw fail(401, "Telegram không xác nhận phiên này", "CLOUD_VERIFY");
      }
      if (!/^\d{1,20}$/.test(acc)) throw fail(401, "Telegram không xác nhận phiên này", "CLOUD_VERIFY");
      const d = await db();
      if (body.keepSession !== true) {
        await setValue(d, id(acc, "session"), encrypt(body.session, key));
        await saveApi(acc, api);
      }
      return { token: await issueToken(d, acc), accountId: acc, data: await readData(acc) };
    },

    "GET data": async (req) => readData((await account(req)).acc),

    "POST join": async (req, body) => {
      const { acc } = await account(req);
      if (!body.data || typeof body.data !== "object") throw fail(400, "Dữ liệu không hợp lệ");
      return { data: await joinAccount(await db(), acc, body.data) };
    },

    "POST ops": async (req, body) => {
      const { acc } = await account(req);
      const ops = checkOps(body.name, body.ops);
      if (!ops) throw fail(400, "Dữ liệu không hợp lệ");
      await applyOps(await db(), acc, body.name, ops);
      return { ok: true };
    },

    "GET session": async (req) => {
      const { acc } = await account(req);
      const got = await getValues(await db(), [id(acc, "session"), id(acc, "api")]);
      const session = got[id(acc, "session")] ? decrypt(got[id(acc, "session")], key) : null;
      const stored = got[id(acc, "api")];
      const api = stored?.box ? JSON.parse(decrypt(stored.box, key) || "null") : stored || null;
      return { session, api };
    },

    "POST session": async (req, body) => {
      const { acc } = await account(req);
      if (!isSessionString(body.session)) throw fail(400, "Phiên Telegram không hợp lệ");
      await setValue(await db(), id(acc, "session"), encrypt(body.session, key));
      return { ok: true };
    },

    "POST logout": async (req, body) => {
      const { acc, token } = await account(req);
      const d = await db();
      // settings, history, favourites stay for the next sign-in
      if (body.keepSession !== true) await deleteValue(d, id(acc, "session"));
      await revokeToken(d, token);
      return { ok: true };
    },

    ...shareRoutes({ env, db, account, fail, key, fetchFn, now }),
  };

  /** Node (req, res) handler; `action` is the last path segment. */
  return async function handle(req, res, action) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const send = (status, data) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(data));
    };
    try {
      const route = routes[`${req.method} ${action}`];
      if (!route) throw fail(404, "Not found");
      if (action !== "status" && !ready) throw fail(503, "Chưa cấu hình MongoDB trên máy chủ", "CLOUD_OFF");
      let body = {};
      if (req.method === "POST" && RAW_BODY.has(action)) body = await readBytes(req, SHARE_CHUNK);
      else if (req.method === "POST") {
        if (!/^application\/json\b/i.test(req.headers["content-type"] || ""))
          throw fail(415, "Cần Content-Type: application/json");
        body = await readBody(req);
      }
      const result = await route(req, body);
      if (result?.[RAW]) {
        // not JSON: a song's bytes (cloud/share.js)
        const { status, headers, body: bytes } = result[RAW];
        res.statusCode = status;
        for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
        if (typeof bytes?.getReader !== "function") {
          res.setHeader("Content-Length", String(Buffer.byteLength(bytes)));
          return res.end(bytes);
        }
        // a stream (from R2): passed on as it comes, so the player starts before the whole piece is here
        for await (const chunk of bytes) res.write(Buffer.from(chunk));
        return res.end();
      }
      send(200, result);
    } catch (err) {
      if (res.headersSent) return void res.destroy?.(err); // a song's bytes cut half-way (R2): the player asks again
      const status = err.status || 503; // anything else: the database could not be reached
      send(status, {
        error: err.status ? err.message : "Không kết nối được MongoDB",
        ...(err.code && { code: err.code }),
        ...(!err.status && { code: "CLOUD_DOWN" }),
      });
    }
  };
}

/** Raw body (a piece of a song), at most `max` bytes: Vercel gives it as a Buffer; plain Node streams it. */
async function readBytes(req, max) {
  let given;
  try {
    given = req.body;
  } catch {
    given = undefined;
  }
  if (Buffer.isBuffer(given)) {
    if (given.length > max) throw fail(413, "Dữ liệu quá lớn");
    return given;
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw fail(413, "Dữ liệu quá lớn");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** JSON body: Vercel parses it into req.body; plain Node streams it. */
async function readBody(req) {
  let parsed;
  try {
    parsed = req.body; // Vercel parses it on first access and throws on broken JSON
  } catch {
    throw fail(400, "JSON không hợp lệ");
  }
  if (parsed !== undefined) {
    if (typeof parsed === "object" && parsed !== null && !Buffer.isBuffer(parsed)) return parsed;
    if (parsed === null) return {};
    if (String(parsed).length > MAX_BODY) throw fail(413, "Dữ liệu quá lớn");
    try {
      parsed = JSON.parse(String(parsed) || "{}");
    } catch {
      throw fail(400, "JSON không hợp lệ");
    }
    return parsed && typeof parsed === "object" ? parsed : {};
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw fail(413, "Dữ liệu quá lớn");
    chunks.push(chunk);
  }
  try {
    const json = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    return json && typeof json === "object" ? json : {};
  } catch {
    throw fail(400, "JSON không hợp lệ");
  }
}

// Telegram's data centres over plain TCP. Sessions made in the browser point at the WebSocket-only
// hosts (pluto / venus / aurora / vesta / flora .web.telegram.org), which Node cannot use.
const DC_IPV4 = {
  1: "149.154.175.53",
  2: "149.154.167.51",
  3: "149.154.175.100",
  4: "149.154.167.91",
  5: "91.108.56.130",
};

// Telegram's own IPv4 ranges (149.154.160.0/20, 91.108.4.0/22 … 91.108.20.0/22, 91.108.56.0/22).
const TELEGRAM_IPV4 = /^(149\.154\.(16\d|17[0-5])|91\.108\.([4-9]|1\d|2[0-3]|5[6-9]))\.\d{1,3}$/;

/**
 * The session with a TCP address for its data centre (same auth key), usable from Node. The address in a
 * session is chosen by whoever sent it: only Telegram's own addresses and ports are ever dialled, so the
 * server cannot be pointed at another host (SSRF).
 */
export async function tcpSession(session) {
  const { StringSession } = await import("telegram/sessions/index.js");
  const stored = new StringSession(session);
  await stored.load();
  if (!DC_IPV4[stored.dcId]) throw new Error("unknown Telegram data centre");
  if (TELEGRAM_IPV4.test(stored.serverAddress || "")) {
    if (stored.port !== 443 && stored.port !== 80) stored.setDC(stored.dcId, stored.serverAddress, 443);
  } else {
    stored.setDC(stored.dcId, DC_IPV4[stored.dcId], 443);
  }
  return stored;
}

/** Ask Telegram which account a session belongs to (connects with GramJS, then disconnects). */
export async function verifyWithTelegram(session, creds, timeoutMs = 20_000) {
  const { TelegramClient } = await import("telegram");
  const stored = await tcpSession(session);
  const client = new TelegramClient(stored, creds.id, creds.hash, { connectionRetries: 1, autoReconnect: false });
  client.setLogLevel("none");
  let timer;
  try {
    return await Promise.race([
      (async () => {
        await client.connect();
        const me = await client.getMe();
        return String(me.id);
      })(),
      new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("timeout")), timeoutMs))),
    ]);
  } finally {
    clearTimeout(timer);
    await client.destroy().catch(() => {});
  }
}
