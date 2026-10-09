// In-browser "backend" for the Vercel build.
//
// It answers the same /api/* routes the UI calls on the local server (server.js), but talks to
// Telegram directly from the user's browser (GramJS over WebSocket). Nothing goes through a server:
// the Telegram session stays in this browser, and files go straight from Telegram to the user's disk.
//
//   - session / settings / history: localStorage of this browser
//   - download folder: File System Access API (Chrome, Edge desktop); other browsers save into the
//     browser's Downloads folder through a streamed service-worker download (no whole file in memory)
//   - preview / play: the service worker (sw.js) answers /api/media with Range support and pulls the
//     bytes from this page, which reads them from Telegram or from the downloaded file

import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import bigInt from "big-integer";
import {
  FILTERS,
  sanitize,
  safeMediaType,
  fileInfo,
  mediaKind,
  displayName,
  splitName,
  dialogType,
  resolveChat,
  entityTitle,
} from "../core.js";

const STORE = { session: "tdl.session", api: "tdl.api", settings: "tdl.settings", history: "tdl.history" };

// API ID / hash baked in at build time (TG_API_ID / TG_API_HASH, e.g. from the project's .env).
// When present, users choose between these and their own app from my.telegram.org.
const BAKED = { id: Number(__TG_API_ID__) || 0, hash: String(__TG_API_HASH__ || "") };
const HAS_BAKED = !!(BAKED.id && BAKED.hash);
const BACK = "__back__"; // sent by the "← choose again" link on the API ID / hash steps

const CONCURRENCY = 3;
const HISTORY_LIMIT = 2000;
const CHUNK = 512 * 1024; // divides 1 MB, so aligned requests never cross a Telegram 1 MB block
const PHOTO_CACHE_MAX = 40;

// Phones and tablets: Chrome Android has showDirectoryPicker, but the system picker refuses the usual
// folders (Download, storage root) and the write permission is lost between visits, so the folder
// choice is a PC/desktop-only feature; elsewhere files go to the browser's Downloads folder.
const isMobile =
  navigator.userAgentData?.mobile ??
  (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)); // iPadOS reports a Mac

const caps = {
  pickFolder: typeof window.showDirectoryPicker === "function" && !isMobile,
  openFolder: false,
  serviceWorker: "serviceWorker" in navigator,
};

const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

// ---------- storage ----------

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full or blocked (private mode): keep working in memory
  }
}

// Directory handles cannot be stored in localStorage, only in IndexedDB.
function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("tdl", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const req = db.transaction("kv").objectStore("kv").get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    if (value === undefined) tx.objectStore("kv").delete(key);
    else tx.objectStore("kv").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- events (what the local server sends over SSE) ----------

const listeners = new Map();

function emit(event, data) {
  for (const cb of listeners.get(event) || []) {
    try {
      cb(structuredClone(data));
    } catch (err) {
      console.error(err);
    }
  }
}

function on(event, cb) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(cb);
}

// ---------- settings & download folder ----------

let dirHandle = null; // default download folder (FileSystemDirectoryHandle)
const pickedHandles = new Map(); // folder name -> handle chosen in the picker, until it is used / saved
const settings = { downloadDir: null, subfolderPerChat: true, ...load(STORE.settings, {}) };

const publicSettings = () => ({ downloadDir: settings.downloadDir, subfolderPerChat: settings.subfolderPerChat });

function saveSettings(patch) {
  Object.assign(settings, patch);
  save(STORE.settings, publicSettings());
  emit("settings", publicSettings());
}

async function setDefaultDir(handle) {
  dirHandle = handle;
  await idbSet("dir", handle || undefined);
  saveSettings({ downloadDir: handle ? handle.name : null });
}

/** Read/write permission on a folder. Asking needs a user click, so only ask from a click handler. */
async function hasPermission(handle, ask) {
  const opts = { mode: "readwrite" };
  try {
    if ((await handle.queryPermission(opts)) === "granted") return true;
    return ask && (await handle.requestPermission(opts)) === "granted";
  } catch {
    return false;
  }
}

async function chatDir(base, title, create) {
  if (!settings.subfolderPerChat) return base;
  try {
    return await base.getDirectoryHandle(sanitize(title), { create });
  } catch {
    return null;
  }
}

const folderLabel = (base, title) => (settings.subfolderPerChat ? `${base.name}/${sanitize(title)}` : base.name);

// ---------- history (removing entries never touches the files) ----------

let history = load(STORE.history, []);
let historySeq = history.reduce((max, h) => Math.max(max, h.id || 0), 0);

function addHistory(job, status) {
  const entry = {
    id: ++historySeq,
    at: Date.now(),
    status, // done | skipped | failed
    mode: job.mode, // fs = chosen folder, browser = browser's Downloads folder
    chat: job.chat,
    scanKey: job.scanKey,
    msgId: job.msgId,
    name: job.name,
    display: job.display,
    size: job.size,
    path: job.where || null,
    error: job.error || null,
  };
  history.unshift(entry);
  if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
  save(STORE.history, history);
  emit("history-add", entry);
}

function removeHistory(ids) {
  const drop = new Set(ids.map(Number));
  const before = history.length;
  history = history.filter((h) => !drop.has(h.id));
  save(STORE.history, history);
  emit("history", history);
  return before - history.length;
}

// ---------- auth ----------

let client = null;
const auth = { step: "connecting", error: null, me: null, phone: "", apiChoice: HAS_BAKED };
let pendingInput = null;
let earlyPhone = null;

/** Credentials already chosen in this browser, or null. Saved as { mode: "builtin" } or { id, hash }. */
function savedCreds() {
  const saved = load(STORE.api, null);
  if (saved?.mode === "builtin") return HAS_BAKED ? BAKED : null;
  return saved?.id && saved?.hash ? saved : null;
}

/** Ask how to connect: the built-in app or the user's own API ID/hash. */
async function chooseCreds() {
  for (;;) {
    const mode = HAS_BAKED ? await waitInput("api_choice") : "own";
    if (mode === "builtin") {
      save(STORE.api, { mode: "builtin" });
      return BAKED;
    }
    const creds = await askApiCreds();
    if (creds) return creds;
  }
}

function waitInput(kind) {
  if (kind === "phone" && earlyPhone) {
    const value = earlyPhone;
    earlyPhone = null;
    return Promise.resolve(value);
  }
  auth.step = kind;
  emit("auth", auth);
  return new Promise((resolve, reject) => (pendingInput = { kind, resolve, reject }));
}

/** Own API ID + hash; null when the user goes back to the choice screen. */
async function askApiCreds() {
  for (;;) {
    const id = String(await waitInput("api_id")).trim();
    if (id === BACK && HAS_BAKED) return (auth.error = null);
    if (!/^\d{3,12}$/.test(id)) {
      auth.error = "API ID là một dãy số (lấy ở my.telegram.org)";
      continue;
    }
    auth.error = null;
    const hash = String(await waitInput("api_hash")).trim().toLowerCase();
    if (hash === BACK.toLowerCase() && HAS_BAKED) return (auth.error = null);
    if (!/^[0-9a-f]{32}$/.test(hash)) {
      auth.error = "API hash gồm 32 ký tự 0-9, a-f";
      continue;
    }
    auth.error = null;
    const creds = { id: Number(id), hash };
    save(STORE.api, creds);
    return creds;
  }
}

// Each sign-in attempt has a number; going back to the API choice starts a new one, and anything the
// abandoned attempt does afterwards (errors, prompts, "ready") is ignored.
let authRun = 0;

async function startAuth({ keepStep = false } = {}, run = authRun) {
  if (!keepStep) auth.step = "connecting";
  auth.error = null;
  auth.me = null;
  emit("auth", auth);

  const creds = savedCreds() || (await chooseCreds());

  client = new TelegramClient(new StringSession(load(STORE.session, "")), creds.id, creds.hash, {
    connectionRetries: 5,
    useWSS: true, // wss:// on port 443; plain ws:// is blocked on https pages
  });
  client.setLogLevel("error");
  await client.connect();

  if (!(await client.checkAuthorization())) {
    await client.start({
      phoneNumber: () => waitInput("phone"),
      phoneCode: () => waitInput("code"),
      password: () => waitInput("password"),
      onError: (err) => {
        if (run !== authRun) return true; // abandoned attempt: stop quietly
        auth.error = err.message;
        emit("auth", auth);
        return /API_ID/.test(err.message); // wrong API ID/hash: stop and ask for them again
      },
    });
  }
  if (run !== authRun) return;
  save(STORE.session, client.session.save());

  const me = await client.getMe();
  auth.me = { name: entityTitle(me), username: me.username || null };
  auth.step = "ready";
  auth.error = null;
  emit("auth", auth);
}

function runAuth(options) {
  const run = ++authRun;
  startAuth(options, run).catch((err) => {
    if (run !== authRun) return; // replaced by a newer attempt (e.g. back to the API choice)
    if (/API_ID/.test(err.message || "")) {
      const wasBuiltin = load(STORE.api, null)?.mode === "builtin";
      save(STORE.api, undefined); // ask again how to connect
      auth.error = wasBuiltin
        ? "API có sẵn đang không dùng được, hãy tự tạo API ID của bạn"
        : "API ID / API hash không đúng, hãy nhập lại";
      return runAuth();
    }
    auth.step = "error";
    auth.error = err.message;
    emit("auth", auth);
  });
}

/** "← Choose again" on the phone step: forget the chosen API and start over at the choice screen. */
function backToChoice() {
  const old = client;
  const waiting = pendingInput;
  client = null;
  pendingInput = null;
  earlyPhone = null;
  save(STORE.api, undefined);
  Object.assign(auth, { error: null, me: null });
  runAuth(); // new attempt first, so the old one's rejection below is ignored
  waiting?.reject(new Error("back to API choice"));
  old?.destroy().catch(() => {});
}

function logout() {
  const old = client;
  save(STORE.session, undefined);
  history = []; // this browser may be used by someone else next
  save(STORE.history, history);
  emit("history", history);
  scans.clear();
  photoCache.clear();
  cancelQueued();
  pendingInput = null;
  earlyPhone = null;
  Object.assign(auth, { step: "phone", error: null, me: null, phone: "", apiChoice: HAS_BAKED });
  emit("auth", auth);
  (async () => {
    try {
      await Promise.race([old?.invoke(new Api.auth.LogOut()), new Promise((r) => setTimeout(r, 5000))]);
    } catch {
      // session may already be invalid
    }
    await old?.destroy().catch(() => {});
  })();
  runAuth({ keepStep: true });
}

function requireReady() {
  if (auth.step !== "ready") throw httpError(401, "Chưa đăng nhập");
}

// ---------- scanning ----------

const scans = new Map(); // key -> { key, chat, type, title, items: Map<msgId, { msg, info }> }

async function scanChat(chat, type) {
  const entity = await resolveChat(client, chat);
  const title = entityTitle(entity);
  const key = `${entity.id}|${type}`;
  const Filter = FILTERS[type];
  const items = new Map();
  for await (const msg of client.iterMessages(entity, { filter: Filter ? new Filter() : undefined })) {
    const info = fileInfo(msg);
    if (!info) continue;
    items.set(msg.id, { msg, info });
    if (items.size % 50 === 0) emit("scan", { chat, count: items.size });
  }
  const scan = { key, chat, type, title, items };
  scans.set(key, scan);
  return scan;
}

function getScan(key) {
  const scan = scans.get(key);
  if (!scan) throw httpError(404, "Kênh chưa được quét, hãy tải lại danh sách");
  return scan;
}

/** name -> FileSystemFileHandle of the files already in the chat's folder (null when unavailable). */
async function diskIndex(scan) {
  if (!dirHandle || !(await hasPermission(dirHandle, false))) return null;
  const dir = await chatDir(dirHandle, scan.title, false);
  const index = new Map();
  if (!dir) return index;
  for await (const [name, handle] of dir.entries()) if (handle.kind === "file") index.set(name, handle);
  return index;
}

/** A complete local copy of an item in the default folder, as a File, or null. */
async function localFile(index, item) {
  if (!index) return null;
  const { name, size } = item.info;
  const { base, ext } = splitName(name);
  for (const candidate of [name, `${base}_${item.msg.id}${ext}`]) {
    const handle = index.get(candidate);
    if (!handle) continue;
    const file = await handle.getFile();
    if (!size || file.size === size) return file;
  }
  return null;
}

async function describeScan(scan) {
  const index = await diskIndex(scan);
  // Downloads into the browser's Downloads folder can't be checked on disk: the history is the record.
  const inBrowserDownloads = new Set(
    history.filter((h) => h.scanKey === scan.key && h.mode === "browser" && h.status !== "failed").map((h) => h.msgId)
  );
  const files = [];
  for (const item of scan.items.values()) {
    files.push({
      id: item.msg.id,
      name: item.info.name,
      kind: mediaKind(item.msg),
      title: item.info.title || null,
      performer: item.info.performer || null,
      duration: item.info.duration || null,
      size: item.info.size,
      date: item.msg.date,
      downloaded: inBrowserDownloads.has(item.msg.id) || !!(await localFile(index, item)),
    });
  }
  return { key: scan.key, title: scan.title, outDir: dirHandle ? folderLabel(dirHandle, scan.title) : null, files };
}

// ---------- download queue ----------

const jobs = new Map();
const queue = [];
let active = 0;
const writing = new Map(); // "folder/name" -> promise, so re-posted twins never write the same file at once

function publicJob(job) {
  const { msg, item, scan, base, ...rest } = job;
  return rest;
}

function updateJob(job, patch) {
  Object.assign(job, patch);
  emit("job", publicJob(job));
}

let lastProgress = 0;
function progress(job, received) {
  job.received = received;
  const now = Date.now();
  if (now - lastProgress > 300) {
    lastProgress = now;
    emit("job", publicJob(job));
  }
}

function enqueue(scan, ids, target) {
  let added = 0;
  for (const raw of ids) {
    const item = scan.items.get(Number(raw));
    if (!item) continue;
    const id = `${scan.key}|${item.msg.id}`;
    if (["queued", "downloading"].includes(jobs.get(id)?.status)) continue;
    const job = {
      id,
      scanKey: scan.key,
      msgId: item.msg.id,
      name: item.info.name,
      display: displayName(item.info),
      chat: scan.title,
      size: item.info.size,
      received: 0,
      status: "queued",
      error: null,
      mode: target.mode,
      base: target.base,
      item,
      scan,
    };
    jobs.set(id, job);
    queue.push(id);
    emit("job", publicJob(job));
    added++;
  }
  pump();
  return added;
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const job = jobs.get(queue.shift());
    if (!job || job.status !== "queued") continue;
    active++;
    runJob(job)
      .catch((err) => {
        updateJob(job, { status: "failed", error: err.message });
        addHistory(job, "failed");
      })
      .finally(() => {
        active--;
        pump();
      });
  }
}

async function runJob(job) {
  try {
    if (job.mode === "fs") await downloadToFolder(job);
    else await downloadToBrowser(job);
  } catch (err) {
    if (err.seconds) {
      // FLOOD_WAIT: Telegram asks us to slow down; retry after the wait.
      updateJob(job, { status: "queued", received: 0, error: `Telegram yêu cầu chờ ${err.seconds}s` });
      await new Promise((r) => setTimeout(r, err.seconds * 1000));
      queue.push(job.id);
      return;
    }
    throw err;
  }
}

/** Bytes of an item from Telegram, as Uint8Array chunks, for [start, end]. */
async function* telegramRange(item, start, end) {
  if (item.msg.media instanceof Api.MessageMediaPhoto) {
    const buf = await photoBytes(item);
    yield buf.subarray(start, end + 1);
    return;
  }
  const aligned = start - (start % CHUNK);
  let skip = start - aligned;
  let remaining = end - start + 1;
  for await (const chunk of client.iterDownload({
    file: item.msg.media,
    offset: bigInt(aligned),
    requestSize: CHUNK,
    fileSize: bigInt(item.info.size),
  })) {
    let buf = skip ? chunk.subarray(skip) : chunk;
    skip = 0;
    if (buf.length > remaining) buf = buf.subarray(0, remaining);
    remaining -= buf.length;
    yield new Uint8Array(buf);
    if (remaining <= 0) return;
  }
}

async function downloadToFolder(job) {
  const dir = await chatDir(job.base, job.chat, true);
  if (!dir) throw new Error("Không tạo được thư mục con trong thư mục đã chọn");
  const { base, ext } = splitName(job.name);
  const lockKey = `${job.base.name}/${job.chat}/${job.name}`;
  while (writing.has(lockKey)) await writing.get(lockKey).catch(() => {});

  // Same name + same size already there (or a re-post twin just wrote it): nothing to do.
  let target = job.name;
  for (const candidate of [job.name, `${base}_${job.msgId}${ext}`]) {
    try {
      const file = await (await dir.getFileHandle(candidate)).getFile();
      if (!job.size || file.size === job.size) {
        job.where = `${folderLabel(job.base, job.chat)}/${candidate}`;
        updateJob(job, { status: "skipped", received: job.size, file: candidate });
        return addHistory(job, "skipped");
      }
      target = `${base}_${job.msgId}${ext}`; // a different file has this name
    } catch {
      break; // no file with this name
    }
  }

  let release;
  writing.set(lockKey, new Promise((r) => (release = r)));
  try {
    updateJob(job, { status: "downloading", error: null });
    const handle = await dir.getFileHandle(target, { create: true });
    const writable = await handle.createWritable(); // written to a temp file, swapped in on close()
    try {
      let received = 0;
      const total = job.size || (await photoBytes(job.item)).length;
      for await (const chunk of telegramRange(job.item, 0, total - 1)) {
        await writable.write(chunk);
        received += chunk.length;
        progress(job, received);
      }
      await writable.close();
      job.where = `${folderLabel(job.base, job.chat)}/${target}`;
      updateJob(job, { status: "done", received, size: received, file: target });
      addHistory(job, "done");
    } catch (err) {
      await writable.abort().catch(() => {});
      throw err;
    }
  } finally {
    writing.delete(lockKey);
    release();
  }
}

// Downloads without a chosen folder: a hidden iframe opens /__dl, the service worker answers it as an
// attachment and pulls the bytes from this page (serveStream below), so the browser streams it to disk.
const browserDownloads = new Map(); // job id -> { resolve, reject }

async function downloadToBrowser(job) {
  updateJob(job, { status: "downloading", error: null });
  const ready = await providerReady();
  if (!ready) {
    // No service worker (e.g. private mode in some browsers): small files only, through memory.
    if (job.size > 300 * 1024 * 1024) throw new Error("Trình duyệt này không hỗ trợ tải file lớn; hãy dùng Chrome/Edge");
    const parts = [];
    let received = 0;
    for await (const chunk of telegramRange(job.item, 0, (job.size || (await photoBytes(job.item)).length) - 1)) {
      parts.push(chunk);
      received += chunk.length;
      progress(job, received);
    }
    saveBlob(new Blob(parts), job.name);
    job.where = `Tải về/${job.name}`;
    updateJob(job, { status: "done", received, size: received, file: job.name });
    return addHistory(job, "done");
  }
  await new Promise((resolve, reject) => {
    browserDownloads.set(job.id, { resolve, reject });
    const url = `/__dl?key=${encodeURIComponent(job.scanKey)}&id=${job.msgId}&job=${encodeURIComponent(job.id)}&c=${encodeURIComponent(swClientId || "")}`;
    const frame = document.createElement("iframe");
    frame.hidden = true;
    frame.src = url;
    document.body.append(frame);
    setTimeout(() => frame.remove(), 60_000);
  });
}

function saveBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

function cancelQueued() {
  let n = 0;
  for (const id of queue.splice(0)) {
    const job = jobs.get(id);
    if (job?.status === "queued") {
      updateJob(job, { status: "cancelled" });
      n++;
    }
  }
  return n;
}

// ---------- media for the service worker (preview, play, browser downloads) ----------

const photoCache = new Map();

async function photoBytes(item) {
  const key = item.msg.id;
  let buf = photoCache.get(key);
  if (!buf) {
    buf = new Uint8Array(await client.downloadMedia(item.msg));
    if (!buf.length) throw httpError(404, "Không tải được ảnh");
    photoCache.set(key, buf);
    if (photoCache.size > PHOTO_CACHE_MAX) photoCache.delete(photoCache.keys().next().value);
  }
  return buf;
}

function parseRange(header, size) {
  const m = /bytes=(\d*)-(\d*)/.exec(header || "");
  if (!m || (!m[1] && !m[2])) return { start: 0, end: size - 1, partial: false };
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  return start <= end && start < size ? { start, end, partial: true } : null;
}

async function* fileRange(file, start, end) {
  const reader = file.slice(start, end + 1).stream().getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** One request from the service worker, answered over its own MessagePort. */
async function serveStream(req, port) {
  const job = req.download ? jobs.get(req.jobId) : null;
  const finish = (fn, value) => {
    const waiter = job && browserDownloads.get(job.id);
    if (waiter) {
      browserDownloads.delete(job.id);
      waiter[fn](value);
    }
  };
  try {
    requireReady();
    const scan = getScan(req.key);
    const item = scan.items.get(Number(req.id));
    if (!item) throw httpError(404, "Không tìm thấy file");

    let size = item.info.size;
    let source;
    const local = req.download ? null : await localFile(await diskIndex(scan), item);
    if (local) {
      size = local.size;
      source = (s, e) => fileRange(local, s, e);
    } else {
      if (!size) size = (await photoBytes(item)).length;
      source = (s, e) => telegramRange(item, s, e);
    }

    const range = req.download ? { start: 0, end: size - 1, partial: false } : parseRange(req.range, size);
    if (!range) {
      port.postMessage({ type: "error", status: 416, size });
      return;
    }
    const doc = item.msg.media?.document;
    const mime = item.msg.media instanceof Api.MessageMediaPhoto ? "image/jpeg" : doc?.mimeType;
    port.postMessage({
      type: "meta",
      status: range.partial ? 206 : 200,
      size,
      start: range.start,
      end: range.end,
      mime: req.download ? "application/octet-stream" : safeMediaType(mime),
      name: item.info.name,
    });

    const it = source(range.start, range.end);
    let received = 0;
    port.onmessage = async (m) => {
      if (m.data?.type === "cancel") {
        await it.return?.();
        if (job) {
          updateJob(job, { status: "cancelled", error: "Đã huỷ trong trình duyệt" });
          finish("resolve");
        }
        return;
      }
      if (m.data?.type !== "pull") return;
      try {
        const { value, done } = await it.next();
        if (done) {
          port.postMessage({ type: "end" });
          if (job) {
            job.where = `Tải về/${job.name}`;
            updateJob(job, { status: "done", received, size: received, file: job.name });
            addHistory(job, "done");
            finish("resolve");
          }
          return;
        }
        const copy = new Uint8Array(value); // own buffer, safe to transfer
        received += copy.length;
        if (job) progress(job, received);
        port.postMessage({ type: "chunk", data: copy }, [copy.buffer]);
      } catch (err) {
        port.postMessage({ type: "error", status: 502, message: err.message });
        finish("reject", err);
      }
    };
  } catch (err) {
    port.postMessage({ type: "error", status: err.status || 500, message: err.message });
    finish("reject", err);
  }
}

// The service worker keeps a registry of pages it can pull bytes from; it is lost when the worker is
// stopped, so the page registers again whenever the worker asks.
let swClientId = null;
let providerResolve;
let providerPromise = new Promise((r) => (providerResolve = r));

function registerProvider() {
  const controller = navigator.serviceWorker?.controller;
  if (!controller) return;
  const ch = new MessageChannel();
  ch.port1.onmessage = (e) => {
    if (e.data?.type === "open" && e.ports[0]) serveStream(e.data, e.ports[0]);
  };
  controller.postMessage({ type: "provider" }, [ch.port2]);
}

async function providerReady() {
  if (!caps.serviceWorker) return false;
  if (swClientId) return true;
  registerProvider();
  return Promise.race([providerPromise.then(() => true), new Promise((r) => setTimeout(() => r(false), 4000))]);
}

async function startServiceWorker() {
  if (!caps.serviceWorker) return;
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "provider-ok") {
      swClientId = e.data.clientId;
      providerResolve();
    }
    if (e.data?.type === "need-provider") registerProvider();
  });
  navigator.serviceWorker.addEventListener("controllerchange", registerProvider);
  try {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    const registration = await navigator.serviceWorker.ready;
    // A hard reload bypasses the worker for this page; ask it to take control (controllerchange follows).
    if (!navigator.serviceWorker.controller) registration.active?.postMessage({ type: "claim" });
    registerProvider();
  } catch (err) {
    console.warn("service worker:", err.message);
  }
}

// ---------- the /api/* router ----------

async function route(method, url, body) {
  const route = `${method} ${url.pathname}`;
  switch (route) {
    case "GET /api/status":
      return auth;

    case "POST /api/login": {
      const { kind, value } = body;
      if (!String(value ?? "").trim()) throw httpError(400, "Vui lòng nhập giá trị");
      if (value === BACK && kind === "phone" && HAS_BAKED && auth.step === "phone") {
        backToChoice();
        return { ok: true };
      }
      if (!pendingInput && kind === "phone" && auth.step === "phone") {
        earlyPhone = String(value).trim();
        auth.step = "waiting";
        auth.error = null;
        emit("auth", auth);
        return { ok: true };
      }
      if (!pendingInput || pendingInput.kind !== kind) throw httpError(409, "Không chờ thông tin này");
      const { resolve } = pendingInput;
      pendingInput = null;
      auth.step = "waiting";
      emit("auth", auth);
      resolve(String(value).trim());
      return { ok: true };
    }

    case "POST /api/logout":
      requireReady();
      logout();
      return { ok: true };

    case "GET /api/dialogs": {
      requireReady();
      const dialogs = await client.getDialogs({});
      return dialogs.map((d) => ({
        id: String(d.id),
        title: d.title || entityTitle(d.entity),
        type: dialogType(d),
        username: d.entity?.username || null,
      }));
    }

    case "GET /api/files": {
      requireReady();
      const chat = (url.searchParams.get("chat") || "").trim();
      const type = url.searchParams.get("type") || "all";
      if (!chat) throw httpError(400, "Thiếu kênh");
      if (!(type in FILTERS)) throw httpError(400, "Loại file không hợp lệ");
      return describeScan(await scanChat(chat, type));
    }

    case "GET /api/scan":
      return describeScan(getScan(url.searchParams.get("key")));

    case "POST /api/download": {
      requireReady();
      const { key, ids, dir, remember } = body;
      if (!Array.isArray(ids) || !ids.length) throw httpError(400, "Chưa chọn file nào");
      const scan = getScan(key);
      if (!caps.pickFolder) {
        return { added: enqueue(scan, ids, { mode: "browser" }), outDir: "thư mục Tải về của trình duyệt" };
      }
      const base = dir ? pickedHandles.get(dir) : dirHandle;
      if (!base) throw httpError(409, "Chưa chọn thư mục tải xuống", { code: "NEED_DIR" });
      if (!(await hasPermission(base, true))) {
        throw httpError(403, "Chưa được cấp quyền ghi vào thư mục. Hãy bấm Tải xuống lại và chọn Cho phép.");
      }
      if (dir && remember) await setDefaultDir(base);
      return { added: enqueue(scan, ids, { mode: "fs", base }), outDir: folderLabel(base, scan.title) };
    }

    case "GET /api/settings":
      return publicSettings();

    case "POST /api/settings": {
      if ("subfolderPerChat" in body) saveSettings({ subfolderPerChat: !!body.subfolderPerChat });
      if ("downloadDir" in body) {
        if (body.downloadDir === null) await setDefaultDir(null);
        else if (body.downloadDir !== settings.downloadDir) {
          const handle = pickedHandles.get(body.downloadDir);
          if (!handle) throw httpError(400, "Hãy chọn thư mục bằng nút Chọn…");
          await setDefaultDir(handle);
        }
      }
      return publicSettings();
    }

    case "GET /api/history":
      return history;

    case "POST /api/history/delete": {
      if (!Array.isArray(body.ids) || !body.ids.length) throw httpError(400, "Chưa chọn mục nào");
      return { removed: removeHistory(body.ids) };
    }

    case "POST /api/history/clear":
      return { removed: removeHistory(history.map((h) => h.id)) };

    case "POST /api/cancel":
      return { cancelled: cancelQueued() };

    case "POST /api/clear":
      for (const [id, job] of jobs) if (!["queued", "downloading"].includes(job.status)) jobs.delete(id);
      emit("jobs", [...jobs.values()].map(publicJob));
      return { ok: true };

    case "POST /api/open-folder":
      throw httpError(400, "Trình duyệt không mở được thư mục trên máy; hãy mở bằng trình quản lý file");
  }
  throw httpError(404, "Not found");
}

/** Same contract as fetch() on the local server: resolves { status, data }. */
async function request(method, path, body) {
  try {
    const data = await route(method, new URL(path, location.origin), body || {});
    return { status: 200, data: structuredClone(data) };
  } catch (err) {
    return { status: err.status || 500, data: { error: err.message, ...(err.code && { code: err.code }) } };
  }
}

/** Native folder picker (Chrome / Edge). Resolves { path } or null when cancelled. */
async function pickDirectory() {
  if (!caps.pickFolder) return null;
  try {
    const handle = await window.showDirectoryPicker({ id: "tdl-downloads", mode: "readwrite" });
    pickedHandles.set(handle.name, handle);
    return { path: handle.name };
  } catch (err) {
    if (err.name === "AbortError") return null;
    throw err;
  }
}

let started = false;
async function start() {
  if (started) return;
  started = true;
  try {
    dirHandle = (caps.pickFolder && (await idbGet("dir"))) || null;
  } catch {
    dirHandle = null;
  }
  if (!dirHandle && settings.downloadDir) saveSettings({ downloadDir: null });
  emit("auth", auth);
  emit("jobs", []);
  emit("settings", publicSettings());
  emit("history", history);
  startServiceWorker();
  runAuth();
}

window.TDL_BACKEND = { caps, request, on, start, pickDirectory };
