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
  normalizeChatIds,
  isFavoriteId,
  RECENT_MAX,
  FAVORITES_LIMIT,
  editPlaylists,
  sortPlaylists,
  QR_LOGIN,
  loginQr,
  newHistoryId,
  authErrorText,
  readPage,
  searchQuery,
  joinRequest,
  searchChats,
  joinChat,
  chatInfoQuery,
  chatInfo,
  photoId,
  avatarIdsQuery,
  createAvatars,
  songSearchScan,
  songSearchPage,
  songSearchKey,
  SONG_SEARCHES_MAX,
} from "../core.js";
import { createCloudSync } from "./cloud-sync.js";

// visibleChats: { "<account id>": ["<chat id>", …] }, the chats each account chose to show in the list
const STORE = {
  session: "tdl.session",
  api: "tdl.api",
  settings: "tdl.settings",
  history: "tdl.history",
  visibleChats: "tdl.visibleChats",
  favorites: "tdl.favorites",
  recent: "tdl.recent",
  playlists: "tdl.playlists", // { "<account id>": [{ id, name, songs, at, up }] } (core.js)
};

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
  cloudSync?.changed(key);
}

let cloudSync = null; // MongoDB copy (web/cloud-sync.js), created below; save() reports changes to it

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

function addHistory(job, status) {
  const entry = {
    id: newHistoryId(), // unique across devices: the history is shared by every device of the account
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

// ---------- MongoDB copy through /api/cloud (Vercel function; see cloud/api.js, web/cloud-sync.js) ----------

cloudSync = createCloudSync({
  store: { load, save },
  keys: STORE,
  signedIn: () => auth.me?.id || null,
  emit: (status) => emit("cloud", status),
  /** This account's value of a shared item (core.js formats). */
  read(name, account) {
    if (name === "settings") return { subfolderPerChat: settings.subfolderPerChat }; // the folder is per device
    if (name === "history") return history;
    const all = load(STORE[name], {}); // visibleChats / favorites / recent: { "<account id>": … }
    if (name === "visibleChats") return all[account] ?? null;
    return all[account] || [];
  },
  /** Take MongoDB's copy of an item into this browser. */
  apply(name, value, account) {
    if (name === "settings")
      return saveSettings({ subfolderPerChat: value.subfolderPerChat ?? settings.subfolderPerChat });
    if (name === "history") {
      history = value;
      save(STORE.history, history);
      return emit("history", history);
    }
    const key = STORE[name];
    const all = load(key, {});
    if (value === null || (Array.isArray(value) && !value.length && name !== "visibleChats")) delete all[account];
    else all[account] = value;
    save(key, all);
    emit("account", { name }); // the page shows the new favourites / chat list / recent plays
  },
});

// Back to this tab: show what other devices changed meanwhile.
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && cloudSync.pull());

// ---------- Telegram sign-in ----------

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
  auth.qr = null;
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
    const hash = String(await waitInput("api_hash"))
      .trim()
      .toLowerCase();
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

async function startAuth({ keepStep = false, error = null } = {}, run = authRun) {
  if (!keepStep) auth.step = "connecting";
  auth.error = error; // a message to keep showing on the next screen (wrong API, Telegram's wait…)
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
      phoneNumber: async () => {
        const value = await waitInput("phone");
        // "Đăng nhập bằng mã QR": GramJS switches to auth.ExportLoginToken when this error is thrown
        if (value === QR_LOGIN) throw Object.assign(new Error("QR"), { errorMessage: "RESTART_AUTH_WITH_QR" });
        return value;
      },
      phoneCode: () => waitInput("code"),
      password: () => waitInput("password"),
      qrCode: async ({ token }) => {
        if (run !== authRun) return;
        pendingInput = null;
        // a fresh token every 30 s; scanned with the Telegram app (Settings → Devices → Link Desktop Device)
        Object.assign(auth, { step: "qr", error: null, qr: { ...loginQr(token), expires: Date.now() + 30_000 } });
        emit("auth", auth);
      },
      onError: (err) => {
        if (run !== authRun) return true; // abandoned attempt: stop quietly
        if (err.seconds || /FLOOD/.test(err.errorMessage || err.message || "")) {
          // Telegram blocks codes for this number for a while: stop here (runAuth goes back to the phone
          // step, where the QR sign-in still works) instead of asking for a code again and again
          auth.floodUntil = Date.now() + (Number(err.seconds) || 0) * 1000;
          return true;
        }
        auth.error = authErrorText(err);
        emit("auth", auth);
        return /API_ID/.test(err.message); // wrong API ID/hash: stop and ask for them again
      },
    });
  }
  if (run !== authRun) return;
  save(STORE.session, client.session.save());

  const me = await client.getMe();
  if (run !== authRun) return;
  auth.me = {
    id: String(me.id),
    name: entityTitle(me),
    username: me.username || null,
    phone: me.phone ? `+${me.phone}` : null,
  };
  // MongoDB copy first (so the lists show the synced data), but never keep the user waiting long
  await Promise.race([cloudSync.sync(auth.me.id), new Promise((r) => setTimeout(r, 8000))]);
  if (run !== authRun) return;
  auth.step = "ready";
  auth.qr = null;
  auth.floodUntil = 0;
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
      return runAuth({ error: auth.error });
    }
    if (auth.floodUntil > Date.now() || /FLOOD/.test(err.errorMessage || err.message || "")) {
      const waitMs = Math.max(0, (auth.floodUntil || 0) - Date.now());
      auth.floodUntil = Date.now() + waitMs;
      auth.step = "phone";
      const old = client;
      client = null;
      pendingInput = null;
      old?.destroy().catch(() => {});
      return runAuth({
        keepStep: true,
        error: authErrorText({ errorMessage: "FLOOD_WAIT", seconds: Math.ceil(waitMs / 1000) }),
      });
    }
    auth.step = "error";
    auth.error = authErrorText(err);
    emit("auth", auth);
  });
}

/** "← Dùng số điện thoại" on the QR screen: drop the QR attempt and ask for the phone number again. */
function backFromQr() {
  const old = client;
  client = null;
  pendingInput = null;
  earlyPhone = null;
  // The phone form is shown at once: a QR attempt cannot be stopped, so a fresh client connects in the
  // background (~3 s); a number typed before it is ready is kept (earlyPhone) and used as soon as it is.
  Object.assign(auth, { step: "phone", error: null, me: null, qr: null });
  emit("auth", auth);
  runAuth({ keepStep: true }); // the abandoned attempt's errors are ignored (authRun changed)
  old?.destroy().catch(() => {});
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
  cloudSync.signOut();
  save(STORE.session, undefined);
  history = []; // this browser may be used by someone else next
  save(STORE.history, history);
  emit("history", history);
  scans.clear();
  photoCache.clear();
  avatars.clear();
  wholes.clear();
  if ("caches" in self) {
    // another account may sign in here
    caches.delete(NEXT_CACHE).catch(() => {});
    caches.delete(LONG_CACHE).catch(() => {});
  }
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

/** The UI moved to another chat: stop reading this one from Telegram. */
const scanStopped = () => httpError(499, "Đã dừng quét kênh", { stopped: true });

async function scanChat(chat, type, signal, scanId = null) {
  const entity = await resolveChat(client, chat);
  if (signal?.aborted) throw scanStopped();
  const scan = {
    key: `${entity.id}|${type}`,
    chat,
    type,
    title: entityTitle(entity),
    entity,
    items: new Map(),
    cursor: 0,
    more: true,
  };
  const page = await scanPage(scan, signal, scanId);
  scans.set(scan.key, scan);
  return { scan, page };
}

/** The next page of a scan (see readPage); pages of one scan run one after another. */
function scanPage(scan, signal, scanId = null) {
  const Filter = FILTERS[scan.type];
  const run = (scan.paging || Promise.resolve())
    .catch(() => {})
    .then(() =>
      scan.search
        ? songSearchPage(client, scan, { signal, stopped: scanStopped })
        : readPage(
            scan,
            (offsetId) => client.iterMessages(scan.entity, { filter: Filter ? new Filter() : undefined, offsetId }),
            {
              signal,
              stopped: scanStopped,
              // scanId (from the UI) tells this scan's progress apart from an earlier scan of the same chat
              onProgress: (count) => emit("scan", { chat: scan.chat, scanId, count }),
            },
          ),
    );
  scan.paging = run;
  return run;
}

/** GET /api/search/songs: the songs matching `q` in every chat of the account, as a list (key "search:…"). */
async function searchSongs(q, signal) {
  const scan = songSearchScan(q, scans.get(songSearchKey(q)));
  const page = await scanPage(scan, signal);
  scans.delete(scan.key); // newest last: the oldest searches are dropped first
  scans.set(scan.key, scan);
  const searches = [...scans.keys()].filter((k) => k.startsWith("search:"));
  for (const k of searches.slice(0, -SONG_SEARCHES_MAX)) scans.delete(k);
  return { scan, page };
}

function getScan(key) {
  const scan = scans.get(key);
  if (!scan) throw httpError(404, "Kênh chưa được quét, hãy tải lại danh sách");
  return scan;
}

// ---------- "Bài hát yêu thích": every favourite file, from all chats, as one list ----------

async function favoritesScan(ids, signal, { key = "fav", title = "Bài hát yêu thích" } = {}) {
  const byChat = new Map(); // chat id -> [message id…]
  for (const id of ids) {
    const [chat, msg] = id.split("|");
    if (!byChat.has(chat)) byChat.set(chat, []);
    byChat.get(chat).push(Number(msg));
  }
  const entities = new Map();
  if (byChat.size)
    for (const d of await client.getDialogs({})) if (d.entity) entities.set(String(d.entity.id), d.entity);
  const found = new Map();
  for (const [chat, msgIds] of byChat) {
    const entity = entities.get(chat);
    if (!entity) continue; // left that chat
    for (let i = 0; i < msgIds.length; i += 100) {
      if (signal?.aborted) throw scanStopped();
      for (const msg of await client.getMessages(entity, { ids: msgIds.slice(i, i + 100) })) {
        const info = msg && fileInfo(msg);
        if (info)
          found.set(`${chat}|${msg.id}`, { msg, info, chatTitle: entityTitle(entity), fav: `${chat}|${msg.id}` });
      }
    }
  }
  // Message ids repeat across chats, so the list uses its own ids (1, 2, …) in favourite order (newest first).
  const items = new Map();
  for (const id of ids) if (found.has(id)) items.set(items.size + 1, found.get(id));
  // "fav": the favourites list (shown as a list); "pl:<id>": a playlist (a list too, in its own order);
  // "recent": the songs played lately (played from the side panel)
  const scan = {
    key,
    chat: key,
    type: "all",
    title,
    ...(key === "fav" ? { fav: true } : key.startsWith("pl:") ? { playlist: key.slice(3) } : { recent: true }),
    items,
    missing: ids.length - items.size,
  };
  scans.set(scan.key, scan);
  return scan;
}

/** name -> FileSystemFileHandle of the files already in the chat's folder (null when unavailable). */
async function diskIndex(title) {
  if (!dirHandle || !(await hasPermission(dirHandle, false))) return null;
  const dir = await chatDir(dirHandle, title, false);
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

/** The scan's files for the page (all of them, or only `ids` = one more page), plus whether more exist. */
async function describeScan(scan, ids = null) {
  const indexes = new Map(); // chat title -> files in its folder (favourites span several chats)
  const indexFor = async (title) => {
    if (!indexes.has(title)) indexes.set(title, await diskIndex(title));
    return indexes.get(title);
  };
  // Downloads into the browser's Downloads folder can't be checked on disk: the history is the record.
  const inBrowserDownloads = new Set(
    history.filter((h) => h.scanKey === scan.key && h.mode === "browser" && h.status !== "failed").map((h) => h.msgId),
  );
  const files = [];
  for (const [id, item] of ids ? ids.map((id) => [id, scan.items.get(id)]) : scan.items) {
    files.push({
      id,
      ...(item.fav && { fav: item.fav, chat: item.chatTitle }),
      name: item.info.name,
      kind: mediaKind(item.msg),
      title: item.info.title || null,
      performer: item.info.performer || null,
      duration: item.info.duration || null,
      size: item.info.size,
      date: item.msg.date,
      downloaded:
        inBrowserDownloads.has(item.msg.id) || !!(await localFile(await indexFor(item.chatTitle ?? scan.title), item)),
    });
  }
  // lists from several chats (favourites, a song search): each file goes to its own chat's folder
  const outDir = dirHandle
    ? scan.fav || scan.playlist || scan.search
      ? dirHandle.name
      : folderLabel(dirHandle, scan.title)
    : null;
  return {
    key: scan.key,
    title: scan.title,
    outDir,
    more: !!scan.more,
    ...(scan.fav && { fav: true, missing: scan.missing }),
    ...(scan.search && { search: true, query: scan.query, total: scan.total || null }),
    ...(scan.recent && { recent: true, missing: scan.missing }),
    ...(scan.playlist && { playlist: scan.playlist, missing: scan.missing }),
    files,
  };
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
  if (job.abort) throw cancelledError(); // the chat was hidden: stop this download here
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
    const id = `${scan.key}|${raw}`;
    if (["queued", "downloading"].includes(jobs.get(id)?.status)) continue;
    const job = {
      id,
      scanKey: scan.key,
      msgId: item.msg.id,
      itemId: Number(raw), // id inside the scan (favourites number their files 1, 2, …)
      name: item.info.name,
      display: displayName(item.info),
      chat: item.chatTitle ?? scan.title, // favourites: each file goes to its own chat's folder
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
    if (err.cancelled) {
      updateJob(job, { status: "cancelled", received: 0 });
      return;
    }
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
    if (job.size > 300 * 1024 * 1024)
      throw new Error("Trình duyệt này không hỗ trợ tải file lớn; hãy dùng Chrome/Edge");
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
    const url = `/__dl?key=${encodeURIComponent(job.scanKey)}&id=${job.itemId}&job=${encodeURIComponent(job.id)}&c=${encodeURIComponent(swClientId || "")}`;
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

/**
 * Stop the downloads that came from some scans (chats just hidden from the list): queued ones are
 * dropped, running ones are aborted at their next chunk (the partial file is removed).
 */
function cancelScans(keys) {
  const wanted = new Set(keys);
  let n = 0;
  for (const job of jobs.values()) {
    if (!wanted.has(job.scanKey)) continue;
    if (job.status === "queued") {
      updateJob(job, { status: "cancelled" });
      n++;
    } else if (job.status === "downloading" && !job.abort) {
      job.abort = true;
      n++;
    }
  }
  for (let i = queue.length - 1; i >= 0; i--) if (jobs.get(queue[i])?.status !== "queued") queue.splice(i, 1);
  return n;
}

/** "Huỷ": every download, queued ones dropped and running ones aborted at their next chunk. */
function cancelAll() {
  let n = cancelQueued();
  for (const job of jobs.values()) {
    if (job.status === "downloading" && !job.abort) {
      job.abort = true;
      n++;
    }
  }
  return n;
}

const cancelledError = () => Object.assign(new Error("Đã huỷ"), { cancelled: true });

/** Scan keys sent by the UI for POST /api/cancel: undefined = every download (queued and running). */
function cancelKeys(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 1000 || !value.every((k) => typeof k === "string" && k.length <= 200))
    return null;
  return value;
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
// The chats' small profile photos (GET /api/avatars), downloaded ~3 at a time and kept in memory.
const avatars = createAvatars(() => client);

async function photoBytes(item) {
  const key = `${item.msg.chatId}|${item.msg.id}`; // message ids repeat across chats
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
  const reader = file
    .slice(start, end + 1)
    .stream()
    .getReader();
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
    const local = req.download ? null : await localFile(await diskIndex(item.chatTitle ?? scan.title), item);
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

    // playing, like the app: a song is fetched whole (and goes on while paused), the player reading it as it
    // comes; a long mix is read on ahead of the player. A download is read as it is written.
    const whole = !req.download && !local ? fetchWhole(req.key, req.id) : null;
    if (whole && ["audio", "voice"].includes(mediaKind(item.msg))) playingNow(mediaUrl(req.key, req.id));
    // a long mix sought far past what is fetched: that part is streamed meanwhile (the fetch goes on from the start)
    const far = whole?.long && !whole.done && range.start > whole.got + FAR_JUMP;
    const it = req.download
      ? source(range.start, range.end)
      : whole && !far
        ? wholeRange(whole, range.start, range.end)
        : readAhead(
            source(range.start, range.end),
            undefined,
            whole ? null : (got) => fetchProgress(mediaUrl(req.key, req.id), range.start + got, size),
          );
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

async function route(method, url, body, signal) {
  const route = `${method} ${url.pathname}`;
  switch (route) {
    case "GET /api/status":
      return auth;

    case "POST /api/login": {
      const { kind, value } = body;
      if (!String(value ?? "").trim()) throw httpError(400, "Vui lòng nhập giá trị");
      if (value === BACK && kind === "qr" && auth.step === "qr") {
        backFromQr();
        return { ok: true };
      }
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
      avatars.rememberDialogs(dialogs);
      return dialogs.map((d) => ({
        id: String(d.id),
        title: d.title || entityTitle(d.entity),
        type: dialogType(d),
        username: d.entity?.username || null,
        photo: photoId(d.entity),
      }));
    }

    case "GET /api/search": {
      // Telegram's global search: public channels / groups / people, or the chat of an invite link
      const q = searchQuery(url.searchParams.get("q"));
      requireReady();
      return searchChats(client, q, { onEntity: avatars.remember });
    }

    case "GET /api/search/songs": {
      // songs in every chat of the account (Telegram's "messages found"), as a list to play / download
      const q = searchQuery(url.searchParams.get("q"));
      requireReady();
      const { scan, page } = await searchSongs(q, signal);
      return describeScan(scan, page);
    }

    case "GET /api/chat-info": {
      // the open chat's subscribers / members, for the line under its title
      const chat = chatInfoQuery(url.searchParams.get("chat"));
      requireReady();
      return chatInfo(client, chat);
    }

    case "GET /api/avatars": {
      // the chats' small profile photos, like Telegram's chat list: { "<id>": "data:image/jpeg;base64,…" | null }
      const ids = avatarIdsQuery(url.searchParams.get("ids"));
      requireReady();
      return avatars.get(ids);
    }

    case "POST /api/join": {
      // { chat: username | id | t.me link } or { invite: hash }; users and bots are opened, not joined
      const target = joinRequest(body);
      requireReady();
      return joinChat(client, target);
    }

    case "GET /api/visible-chats": {
      requireReady();
      return { ids: load(STORE.visibleChats, {})[auth.me.id] || null };
    }

    case "POST /api/visible-chats": {
      requireReady();
      const ids = normalizeChatIds(body.ids);
      if (ids === undefined) throw httpError(400, "Danh sách hội thoại không hợp lệ");
      const all = load(STORE.visibleChats, {});
      if (ids === null) delete all[auth.me.id];
      else all[auth.me.id] = ids;
      save(STORE.visibleChats, all);
      return { ids };
    }

    case "GET /api/favorites":
      requireReady();
      return { ids: load(STORE.favorites, {})[auth.me.id] || [] };

    case "GET /api/recent":
      requireReady();
      return { items: load(STORE.recent, {})[auth.me.id] || [] };

    case "POST /api/recent": {
      // { op: "add", entry } (a song started) · { op: "remove", id } · { op: "clear" }
      requireReady();
      const all = load(STORE.recent, {});
      const list = all[auth.me.id] || [];
      let next;
      if (body.op === "add") {
        const e = body.entry;
        const ok =
          e &&
          typeof e === "object" &&
          isFavoriteId(e.id) &&
          Object.values(e).every((v) => v === null || ["string", "number", "boolean"].includes(typeof v));
        if (!ok) throw httpError(400, "Bài không hợp lệ");
        next = [e, ...list.filter((h) => h.id !== e.id)].slice(0, RECENT_MAX);
      } else if (body.op === "remove" && isFavoriteId(body.id)) next = list.filter((h) => h.id !== body.id);
      else if (body.op === "clear") next = [];
      else throw httpError(400, "Thao tác không hợp lệ");
      if (next.length) all[auth.me.id] = next;
      else delete all[auth.me.id];
      save(STORE.recent, all);
      return { items: next };
    }

    case "GET /api/recent/files":
      // the songs played lately, ready to play again (from every chat, like the favourites)
      requireReady();
      return describeScan(
        await favoritesScan(
          (load(STORE.recent, {})[auth.me.id] || []).map((h) => h.id),
          signal,
          { key: "recent", title: "Phát gần đây" },
        ),
      );

    case "GET /api/playlists":
      requireReady();
      return { playlists: sortPlaylists(load(STORE.playlists, {})[auth.me.id] || []) };

    case "POST /api/playlists": {
      // one change (core.js editPlaylists): create · rename · delete · add · remove · order
      requireReady();
      const all = load(STORE.playlists, {});
      let result;
      try {
        result = editPlaylists(all[auth.me.id] || [], body);
      } catch (err) {
        throw httpError(400, err.message);
      }
      if (result.playlists.length) all[auth.me.id] = result.playlists;
      else delete all[auth.me.id];
      save(STORE.playlists, all);
      return { playlists: sortPlaylists(result.playlists), id: result.id };
    }

    case "GET /api/playlists/files": {
      // a playlist's songs, in its order, from every chat (like the favourites)
      requireReady();
      const p = (load(STORE.playlists, {})[auth.me.id] || []).find((x) => x.id === url.searchParams.get("id"));
      if (!p) throw httpError(404, "Không tìm thấy playlist");
      return describeScan(await favoritesScan(p.songs, signal, { key: `pl:${p.id}`, title: p.name }));
    }

    case "GET /api/favorites/files":
      requireReady();
      return describeScan(await favoritesScan(load(STORE.favorites, {})[auth.me.id] || [], signal));

    case "POST /api/favorites": {
      requireReady();
      const { id, on } = body;
      if (!isFavoriteId(id) || typeof on !== "boolean") throw httpError(400, "Yêu thích không hợp lệ");
      const all = load(STORE.favorites, {});
      const list = (all[auth.me.id] || []).filter((x) => x !== id);
      if (on) {
        if (list.length >= FAVORITES_LIMIT) throw httpError(400, `Tối đa ${FAVORITES_LIMIT} file yêu thích`);
        list.unshift(id);
      }
      if (list.length) all[auth.me.id] = list;
      else delete all[auth.me.id];
      save(STORE.favorites, all);
      return { ids: list };
    }

    case "GET /api/files": {
      requireReady();
      const chat = (url.searchParams.get("chat") || "").trim();
      const type = url.searchParams.get("type") || "all";
      if (!chat) throw httpError(400, "Thiếu kênh");
      if (!(type in FILTERS)) throw httpError(400, "Loại file không hợp lệ");
      const scanId = /^[\w-]{1,40}$/.test(url.searchParams.get("scan") || "") ? url.searchParams.get("scan") : null;
      const { scan, page } = await scanChat(chat, type, signal, scanId);
      return describeScan(scan, page);
    }

    case "GET /api/files/more": {
      // the next page of a scan (infinite scroll); only the new files are sent
      requireReady();
      const scan = getScan(url.searchParams.get("key"));
      const scanId = /^[\w-]{1,40}$/.test(url.searchParams.get("scan") || "") ? url.searchParams.get("scan") : null;
      return describeScan(scan, await scanPage(scan, signal, scanId));
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
      return {
        added: enqueue(scan, ids, { mode: "fs", base }),
        outDir: scan.fav || scan.playlist || scan.search ? base.name : folderLabel(base, scan.title),
      };
    }

    case "GET /api/cloud":
      return { ...cloudSync.status };

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

    case "POST /api/cancel": {
      // { keys: [scan key…] } stops the downloads of those scans (queued and running); no keys = all of them.
      const keys = cancelKeys(body.keys);
      if (keys === null) throw httpError(400, "Danh sách không hợp lệ");
      return { cancelled: keys ? cancelScans(keys) : cancelAll() };
    }

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
/** Same contract as fetch() to the local server; `signal` aborts a long request (a chat scan). */
async function request(method, path, body, { signal } = {}) {
  try {
    const data = await route(method, new URL(path, location.origin), body || {}, signal);
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
  emit("cloud", { ...cloudSync.status });
  startServiceWorker();
  await cloudSync.restoreSession();
  runAuth();
}

// ---------- playing like the app (mobile/src/player): read a song on to its end, keep its data centre connected ----------

const AHEAD_MAX = 64 * 1024 * 1024; // what may wait for the player (a long mix is read on as it plays)

/**
 * `it`, read ahead of whoever pulls from it (up to AHEAD_MAX bytes waiting): the song keeps coming while the page
 * can use the network — a locked phone may stall it later, and the player then still has the song.
 */
function readAhead(it, max = AHEAD_MAX, onBytes = null) {
  const queue = [];
  let queued = 0;
  let finished = false;
  let failure = null;
  let stopped = false;
  let wake = null; // the reader waits for a piece
  let room = null; // the fetch waits for the reader to take some
  let fetched = 0; // bytes read from `it` so far
  (async () => {
    try {
      while (!stopped) {
        if (queued >= max) {
          await new Promise((r) => (room = r));
          continue;
        }
        const { value, done } = await it.next();
        if (done) break;
        queue.push(value);
        queued += value.length;
        onBytes?.((fetched += value.length));
        wake?.();
      }
    } catch (err) {
      failure = err;
    }
    finished = true;
    wake?.();
  })();
  return {
    async next() {
      while (!queue.length && !finished) await new Promise((r) => (wake = r));
      if (queue.length) {
        const value = queue.shift();
        queued -= value.length;
        room?.();
        return { value, done: false };
      }
      if (failure) throw failure;
      return { value: undefined, done: true };
    },
    async return() {
      stopped = true;
      room?.();
      await it.return?.();
      return { value: undefined, done: true };
    },
  };
}

// GramJS lets go of an idle data centre after ~30 s; the next song from it would wait for a new connection
// and its authorisation (and may not get one with the screen locked). Borrowed again every 20 s, as the app does.
const warmDcs = new Map(); // dc id -> last time a song came from it
let keepAliveTimer = null;
function keepDc(dcId) {
  if (!dcId || !client) return;
  warmDcs.set(dcId, Date.now());
  keepAliveTimer ??= setInterval(() => {
    for (const [dc, at] of warmDcs) {
      if (Date.now() - at > 30 * 60_000)
        warmDcs.delete(dc); // nothing played from it for a while
      else client?.getSender(dc).catch(() => warmDcs.delete(dc));
    }
    if (!warmDcs.size) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  }, 20_000);
}

// ---------- the next songs, fetched ahead into the worker's cache (web/sw.js serves them from there) ----------
// With the screen locked, a phone may stall this page's Telegram connection; the song that comes next then
// never loads. Fetched while the current one plays, it starts (and plays to its end) without the network.
const NEXT_CACHE = "tdl-next-songs";
const NEXT_KEEP = 4; // songs kept in that cache (the playing one, the next two…)
const NEXT_MAX = 40 * 1024 * 1024; // a song up to this size is fetched whole, once; longer mixes stream
const wholes = new Map(); // media URL -> { got, size, done, failed, stop, waiters, job, read(from, to), long? }
// A longer mix playing is fetched whole too, start to end, in parts of PART bytes kept in the browser's cache (not
// in memory: a mix can be hundreds of MB): sought back or ahead within what is there, it plays at once and the
// fetch goes on — the grey bar is not started again. The last LONG_KEEP mixes are kept.
const LONG_CACHE = "tdl-long-songs";
const PART = 8 * 1024 * 1024; // a multiple of CHUNK
const LONG_KEEP = 2;
const FAR_JUMP = 4 * 1024 * 1024; // a position this far past what is fetched is streamed meanwhile
const mediaUrl = (key, id) => `/api/media?key=${encodeURIComponent(key)}&id=${id}`;

/** How far a song is fetched (the player's grey bar), at most every 300 ms per song. */
const fetchSent = new Map();
function fetchProgress(url, got, size) {
  const now = Date.now();
  if (got < size && now - (fetchSent.get(url) || 0) < 300) return;
  fetchSent.set(url, now);
  emit("fetch", { url, got, size });
}

/**
 * A song (up to NEXT_MAX) fetched whole, start to end, whether it plays, is paused or comes next — like the app.
 * The player reads it as it comes (wholeRange), and once whole it goes to the worker's cache: played again,
 * sought, or reached with the screen locked, it needs no network. A longer mix: the same while it plays (not ahead:
 * `ahead`), kept in parts (fetchLong). null when it is not fetched this way.
 */
function fetchWhole(key, id, { ahead = false } = {}) {
  const url = mediaUrl(key, id);
  if (wholes.has(url)) {
    const w = wholes.get(url);
    w.stop = false; // stopped but not yet let go (it does at its next chunk): it goes on
    return w;
  }
  const item = scans.get(key)?.items.get(Number(id));
  const size = item?.info.size;
  if (!item || !size) return null;
  keepDc(item.msg.media?.document?.dcId);
  if (!("caches" in self)) return null;
  if (size > NEXT_MAX) return ahead ? null : fetchLong(url, item, size);
  const w = { buf: new Uint8Array(size), got: 0, size, done: false, failed: null, stop: false, waiters: new Set() };
  w.read = async (from, to) => w.buf.slice(from, to);
  const wake = () => {
    for (const fn of w.waiters) fn();
    w.waiters.clear();
  };
  w.job = (async () => {
    const cache = await caches.open(NEXT_CACHE);
    const cached = await cache.match(url);
    if (cached) {
      w.buf = new Uint8Array(await cached.arrayBuffer());
      w.got = w.size = w.buf.length;
    } else {
      for await (const chunk of telegramRange(item, 0, size - 1)) {
        if (w.stop) throw new Error("stopped");
        w.buf.set(chunk.subarray(0, size - w.got), w.got);
        w.got = Math.min(size, w.got + chunk.length);
        fetchProgress(url, w.got, size);
        wake();
      }
      const mime = safeMediaType(item.msg.media?.document?.mimeType);
      await cache.put(url, new Response(new Blob([w.buf], { type: mime }), { headers: { "Content-Type": mime } }));
      const keys = await cache.keys();
      for (const old of keys.slice(0, Math.max(0, keys.length - NEXT_KEEP))) await cache.delete(old);
    }
    w.done = true;
    fetchProgress(url, w.size, w.size);
    wake();
  })()
    .catch((err) => {
      w.failed = err;
      wake();
      wholes.delete(url); // asked again next time
    })
    .finally(() => {
      // the worker serves it from its cache now; keep the bytes only while a player still reads them
      setTimeout(() => wholes.get(url) === w && w.done && wholes.delete(url), 60_000);
    });
  wholes.set(url, w);
  return w;
}

/** A long mix fetched whole while it plays (see LONG_CACHE): its parts kept in the cache, the one filling in memory. */
function fetchLong(url, item, size) {
  const parts = []; // part index -> Blob (from the cache once it is there)
  const w = { got: 0, size, done: false, failed: null, stop: false, waiters: new Set(), long: true };
  let cur = new Uint8Array(Math.min(PART, size)); // the part being filled
  w.read = async (from, to) => {
    const i = Math.floor(from / PART);
    const end = Math.min(to, (i + 1) * PART) - i * PART;
    if (parts[i]) return new Uint8Array(await parts[i].slice(from - i * PART, end).arrayBuffer());
    return cur.slice(from - i * PART, end);
  };
  const wake = () => {
    for (const fn of w.waiters) fn();
    w.waiters.clear();
  };
  const partKey = (i) => `${url}&part=${i}`;
  w.job = (async () => {
    const cache = await caches.open(LONG_CACHE);
    // only the last LONG_KEEP mixes keep their parts (the cache's keys are full addresses, oldest first)
    const full = (u) => new URL(u, location.href).href;
    const keys = (await cache.keys()).map((r) => r.url);
    const others = [...new Set(keys.map((k) => k.replace(/&part=\d+$/, "")))].filter((u) => u !== full(url));
    const gone = others.slice(0, Math.max(0, others.length - (LONG_KEEP - 1)));
    for (const k of keys) if (gone.some((u) => k.startsWith(u + "&part="))) await cache.delete(k);
    for (const [u, x] of wholes) if (x.long && x !== w && gone.includes(full(u))) wholes.delete(u);
    // fetched before (in part): from where it stopped
    for (let i = 0; w.got < size; i++) {
      const hit = await cache.match(partKey(i));
      if (!hit) break;
      parts[i] = await hit.blob();
      w.got = Math.min(size, w.got + parts[i].size);
    }
    fetchProgress(url, w.got, size);
    wake();
    cur = new Uint8Array(Math.min(PART, size - w.got));
    let fill = 0;
    if (w.got < size)
      for await (const chunk of telegramRange(item, w.got, size - 1)) {
        if (w.stop) throw new Error("stopped");
        let c = chunk.subarray(0, size - w.got);
        while (c.length) {
          const n = Math.min(c.length, cur.length - fill);
          cur.set(c.subarray(0, n), fill);
          fill += n;
          w.got += n;
          c = c.subarray(n);
          if (fill === cur.length) {
            // a part full: kept (in memory until the cache has it), the next one starts
            const i = Math.floor((w.got - 1) / PART);
            parts[i] = new Blob([cur]);
            const blob = parts[i];
            cache
              .put(partKey(i), new Response(blob))
              .then(() => cache.match(partKey(i)))
              .then((r) => r?.blob())
              .then((b) => b && parts[i] === blob && (parts[i] = b))
              .catch(() => {}); // storage full: it stays in memory
            cur = new Uint8Array(Math.min(PART, size - w.got));
            fill = 0;
          }
        }
        fetchProgress(url, w.got, size);
        wake();
      }
    w.done = true;
    fetchProgress(url, size, size);
    wake();
  })().catch((err) => {
    w.failed = err;
    wake();
    if (wholes.get(url) === w) wholes.delete(url); // asked again next time (from the parts kept)
  });
  wholes.set(url, w);
  return w;
}

/** Bytes start..end of a song being fetched whole, as they arrive (the player does not wait for the end). */
async function* wholeRange(w, start, end) {
  let pos = start;
  while (pos <= end) {
    if (w.got > pos) {
      const piece = await w.read(pos, Math.min(w.got, end + 1, pos + 512 * 1024));
      yield piece;
      pos += piece.length;
    } else if (w.failed) throw w.failed;
    else if (w.done) return;
    else await new Promise((r) => w.waiters.add(r));
  }
}

/** The songs of the play now (the playing one and the next ones, ui.js asks for them in turn). */
let wanted = new Set();

/** A song picked to play that was not fetched ahead: it gets the whole line (the songs of before stop). */
function playingNow(url) {
  if (wanted.has(url)) return;
  wanted = new Set([url]);
  for (const [u, w] of wholes) if (u !== url && !w.done) w.stop = true;
}

/** The next songs, fetched ahead (see fetchWhole); resolves when there (false: streamed when it plays). */
async function prefetch(key, id) {
  wanted.add(mediaUrl(key, id));
  const w = fetchWhole(key, id, { ahead: true });
  if (!w) return false;
  await w.job;
  return !w.failed;
}

window.TDL_BACKEND = { caps, request, on, start, pickDirectory, prefetch };
