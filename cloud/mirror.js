// Keeps the local server's private files (settings, history, session, …) in MongoDB.
//
// The files stay the working copy, so everything keeps working when the cluster cannot be reached:
//   start()     MongoDB is the source of truth: its copies overwrite the files; files it does not
//               have yet are uploaded (first run / migration).
//   changed(f)  after the server wrote or removed a file: upload it (or delete the copy). When offline
//               the change is remembered and sent once the connection is back (retried every 30 s).
// The Telegram session is stored encrypted with TDL_SECRET (or a key generated in the data folder).

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { openDb, getValues, setValue, deleteValue, encrypt, decrypt, keyFromSecret, mongoHost } from "./common.js";

const RETRY_MS = 30_000;

/**
 * @param files     { "<file path>": { name: "settings.json", secret?: true } } the files to keep in sync
 * @param keyFile   where to keep a generated encryption key when TDL_SECRET is not set
 */
export function createMirror({ uri, dbName, instance = "default", secret, keyFile, files, timeoutMs, log = console }) {
  const status = { enabled: !!uri, connected: false, host: uri ? mongoHost(uri) : null, error: null, lastSync: null };
  const byPath = new Map(Object.entries(files).map(([p, f]) => [path.resolve(p), f]));
  const dirty = new Set(); // file paths changed while offline
  let db = null;
  let timer = null;
  let key = null;
  let chain = Promise.resolve(); // uploads run one after another, so an older copy never lands last

  const docId = (f) => `local:${instance}:${f.name}`;

  function encryptionKey() {
    if (key) return key;
    if (secret) return (key = keyFromSecret(secret));
    // No TDL_SECRET: a random key kept next to the session (only this computer can read the copy).
    let stored = "";
    try {
      stored = fs.readFileSync(keyFile, "utf8").trim();
    } catch {
      stored = crypto.randomBytes(32).toString("base64url");
      fs.writeFileSync(keyFile, stored, { mode: 0o600 });
    }
    return (key = keyFromSecret(stored));
  }

  /** What goes into MongoDB for a file (undefined = the file does not exist). */
  function readLocal(file, f) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
    if (f.secret) return encrypt(text.trim(), encryptionKey());
    try {
      return JSON.parse(text);
    } catch {
      return undefined; // half-written / broken file: keep the copy in MongoDB
    }
  }

  function writeLocal(file, f, value) {
    const text = f.secret ? decrypt(value, encryptionKey()) : JSON.stringify(value, null, 2);
    if (text === null) {
      log.warn(`MongoDB: không giải mã được ${f.name} (TDL_SECRET khác với máy đã lưu) — giữ bản trên máy.`);
      return false;
    }
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  }

  async function connect() {
    db = await openDb(uri, { dbName, timeoutMs });
    status.connected = true;
    status.error = null;
  }

  function offline(err) {
    db = null;
    status.connected = false;
    status.error = err.message.replace(/mongodb(\+srv)?:\/\/\S+/g, "mongodb://…"); // never echo the password
    if (!timer) timer = setInterval(retry, RETRY_MS).unref();
  }

  async function upload(file) {
    const f = byPath.get(file);
    const value = readLocal(file, f);
    if (value === undefined && fs.existsSync(file)) return; // unreadable right now: try with the next change
    if (value === undefined) await deleteValue(db, docId(f));
    else await setValue(db, docId(f), value);
    status.lastSync = Date.now();
  }

  function flush() {
    chain = chain.then(async () => {
      for (const file of [...dirty]) {
        dirty.delete(file); // a change during the upload marks it again
        try {
          await upload(file);
        } catch (err) {
          dirty.add(file);
          throw err;
        }
      }
    });
    const run = chain;
    chain = chain.catch(() => {}); // the next flush starts clean
    return run;
  }

  async function retry() {
    try {
      if (!db) await connect();
      await flush();
      clearInterval(timer);
      timer = null;
      log.log(`MongoDB: đã kết nối lại ${status.host}, đồng bộ xong.`);
    } catch (err) {
      offline(err);
    }
  }

  return {
    status,

    /** Before the server reads its files: bring them up to date from MongoDB. */
    async start() {
      if (!uri) return status;
      try {
        await connect();
        const remote = await getValues(db, [...byPath.values()].map(docId));
        for (const [file, f] of byPath) {
          const value = remote[docId(f)];
          if (value !== undefined) writeLocal(file, f, value);
          else if (fs.existsSync(file)) await upload(file); // first run: move the local data up
        }
        status.lastSync = Date.now();
        log.log(`MongoDB: đã đồng bộ dữ liệu với ${status.host} (instance "${instance}").`);
      } catch (err) {
        offline(err);
        log.warn(`MongoDB: không kết nối được ${status.host} — dùng dữ liệu trên máy, sẽ thử lại sau. (${status.error})`);
      }
      return status;
    },

    /** After a synced file was written or removed. Never throws; never blocks the caller. */
    changed(file) {
      if (!uri) return;
      file = path.resolve(file);
      if (!byPath.has(file)) return;
      dirty.add(file);
      if (!db) return; // offline: sent by the retry timer
      flush().catch(offline);
    },

    /** Wait until pending uploads are done (tests, shutdown). */
    async settle() {
      await chain;
      if (db && dirty.size) await flush().catch(offline);
    },

    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
