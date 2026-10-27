// MongoDB (Atlas) storage shared by the local server (cloud/mirror.js) and the Vercel functions
// (cloud/api.js). Node only.
//
// Collections (database MONGODB_DB, default "tele_downloader"):
//   kv      { _id, value, updatedAt }  one document per stored item
//             "local:<instance>:<file>"   the local server's files (settings.json, session.txt, …)
//             "acct:<account id>:<name>"  data of one Telegram account using the browser version
//   tokens  { _id: sha256(token), accountId, createdAt, lastUsedAt }  device tokens of the browser version
//
// Telegram sessions (full account access) and own API hashes are stored encrypted (AES-256-GCM).

import crypto from "node:crypto";
import { MongoClient } from "mongodb";
import { normalizeChatIds, isFavoriteId, FAVORITES_LIMIT, RECENT_MAX, PLAYLISTS_MAX, cleanPlaylist } from "../core.js";

export const DEFAULT_DB = "tele_downloader";
const TOKEN_TTL_DAYS = 400;

// ---------- connection (one client per cluster, reused by warm serverless invocations) ----------
// A client is never closed while the process runs: closing one that is still in use makes the driver
// reconnect it behind our back. Several databases of the same cluster share the client.

const clients = new Map(); // uri -> Promise<MongoClient>
const indexed = new Set(); // "uri|db" whose indexes were created

/** Connected database; fails within `timeoutMs` when the cluster cannot be reached. */
export async function openDb(uri, { dbName = DEFAULT_DB, timeoutMs = 6000 } = {}) {
  let pending = clients.get(uri);
  if (!pending) {
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: timeoutMs,
      connectTimeoutMS: timeoutMs,
      maxPoolSize: 5,
      appName: "tele-downloader",
    });
    pending = client.connect().then(() => client);
    clients.set(uri, pending);
    pending.catch(() => {
      if (clients.get(uri) === pending) clients.delete(uri); // next call tries again
      client.close().catch(() => {});
    });
  }
  const db = (await pending).db(dbName);
  if (!indexed.has(`${uri}|${dbName}`)) {
    indexed.add(`${uri}|${dbName}`);
    await db
      .collection("tokens")
      .createIndex({ lastUsedAt: 1 }, { expireAfterSeconds: TOKEN_TTL_DAYS * 86400 })
      .catch(() => {});
  }
  return db;
}

/** Close every client (process shutdown, tests). */
export async function closeDb() {
  const all = [...clients.values()];
  clients.clear();
  indexed.clear();
  await Promise.all(
    all.map((p) =>
      p.then(
        (c) => c.close(),
        () => {},
      ),
    ),
  );
}

/** A connection string worth trying (never logged: it contains the password). */
export const isMongoUri = (uri) => typeof uri === "string" && /^mongodb(\+srv)?:\/\/\S+$/.test(uri.trim());

/** "mongodb+srv://user:pass@host/…" -> "host", for messages. */
export function mongoHost(uri) {
  try {
    return new URL(uri.replace(/^mongodb(\+srv)?:/, "http:")).hostname;
  } catch {
    return "?";
  }
}

// ---------- key / value documents ----------

const kv = (db) => db.collection("kv");

export async function getValue(db, id) {
  const doc = await kv(db).findOne({ _id: id });
  return doc ? doc.value : undefined;
}

export async function getValues(db, ids) {
  const docs = await kv(db)
    .find({ _id: { $in: ids } })
    .toArray();
  return Object.fromEntries(docs.map((d) => [d._id, d.value]));
}

export async function setValue(db, id, value) {
  await kv(db).updateOne({ _id: id }, { $set: { value, updatedAt: new Date() } }, { upsert: true });
}

export async function deleteValue(db, id) {
  await kv(db).deleteOne({ _id: id });
}

// ---------- encryption of secrets (sessions, own API hash) ----------

/** 32-byte key from a secret of any length (TDL_SECRET). */
export const keyFromSecret = (secret) => crypto.createHash("sha256").update(String(secret)).digest();

export function encrypt(text, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

/** Plain text, or null when the box was made with another key or was tampered with. */
export function decrypt(box, key) {
  try {
    if (!box || box.v !== 1) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"));
    decipher.setAuthTag(Buffer.from(box.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(box.data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// ---------- device tokens (browser version) ----------

export const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");
const isToken = (t) => typeof t === "string" && /^[\w-]{43}$/.test(t);

export async function issueToken(db, accountId) {
  const token = crypto.randomBytes(32).toString("base64url"); // 43 characters
  const now = new Date();
  await db.collection("tokens").insertOne({ _id: hashToken(token), accountId, createdAt: now, lastUsedAt: now });
  return token;
}

/** Account id of a device token, or null (unknown, revoked or expired). */
export async function accountForToken(db, token) {
  if (!isToken(token)) return null;
  const doc = await db
    .collection("tokens")
    .findOneAndUpdate({ _id: hashToken(token) }, { $set: { lastUsedAt: new Date() } }, { returnDocument: "after" });
  return doc?.accountId || null;
}

export async function revokeToken(db, token) {
  if (isToken(token)) await db.collection("tokens").deleteOne({ _id: hashToken(token) });
}

// ---------- what an account may store, validated (null = remove, undefined = invalid) ----------

const plainEntry = (e) =>
  e &&
  typeof e === "object" &&
  !Array.isArray(e) &&
  Object.keys(e).length <= 24 &&
  Object.values(e).every(
    (v) =>
      v === null ||
      typeof v === "boolean" ||
      (typeof v === "number" && Number.isFinite(v)) ||
      (typeof v === "string" && v.length <= 2000),
  );

export const ACCOUNT_DATA = {
  settings(v) {
    if (v === null) return null;
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    const out = {};
    if ("subfolderPerChat" in v) out.subfolderPerChat = !!v.subfolderPerChat;
    if ("downloadDir" in v) {
      if (v.downloadDir !== null && (typeof v.downloadDir !== "string" || v.downloadDir.length > 500)) return undefined;
      out.downloadDir = v.downloadDir;
    }
    return out;
  },
  history(v) {
    if (v === null) return null;
    if (!Array.isArray(v) || v.length > 2000 || !v.every(plainEntry)) return undefined;
    return v;
  },
  visibleChats(v) {
    return normalizeChatIds(v); // null = show every chat
  },
  favorites(v) {
    if (v === null) return null;
    if (!Array.isArray(v) || v.length > FAVORITES_LIMIT || !v.every(isFavoriteId)) return undefined;
    return [...new Set(v)];
  },
  playlists(v) {
    if (v === null) return null;
    if (!Array.isArray(v) || v.length > PLAYLISTS_MAX) return undefined;
    const out = v.map(cleanPlaylist);
    return out.every(Boolean) ? out : undefined;
  },
  recent(v) {
    if (v === null) return null;
    if (!Array.isArray(v) || v.length > RECENT_MAX || !v.every((e) => plainEntry(e) && isFavoriteId(e.id)))
      return undefined;
    return v;
  },
};

/** API settings of the browser version: the built-in app, or the user's own id + hash. */
export function normalizeApi(v) {
  if (v === null || v === undefined) return null;
  if (v && v.mode === "builtin") return { mode: "builtin" };
  const id = Number(v?.id);
  const hash = String(v?.hash || "");
  return Number.isInteger(id) && id > 0 && /^[0-9a-f]{32}$/i.test(hash) ? { id, hash } : undefined;
}

/** A GramJS StringSession as saved by the client (base64-ish text). */
export const isSessionString = (s) =>
  typeof s === "string" && s.length >= 100 && s.length <= 2000 && /^[\w+/=-]+$/.test(s);
