#!/usr/bin/env node
// Local web UI for the Telegram downloader.
//
//   node server.js            # then open http://127.0.0.1:3000
//   PORT=8080 node server.js
//   DOWNLOAD_DIR=~/Music CONCURRENCY=5 node server.js   # DOWNLOAD_DIR = default until one is set in the UI
//
// The Telegram session, access token, settings and download history live in a private folder outside the
// project (~/.config/tele-downloader on Linux; override with TDL_DATA_DIR, or SETTINGS_FILE / HISTORY_FILE).
//
// The server only listens on 127.0.0.1, so it is reachable from this machine only.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import bigInt from "big-integer";
import { Api } from "telegram";
import {
  FILTERS,
  SESSION_FILE,
  DATA_DIR,
  dataFile,
  createClient,
  envCreds,
  envValue,
  saveSession,
  sanitize,
  fileInfo,
  mediaKind,
  displayName,
  resolveTarget,
  safeMediaType,
  claimTarget,
  downloadFile,
  dialogType,
  resolveChat,
  entityTitle,
} from "./lib.js";

const PORT = Number(process.env.PORT) || 3000;
const HOST = "127.0.0.1";
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY) || 3);
const ROOT_DIR = path.dirname(new URL(import.meta.url).pathname);
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const SETTINGS_FILE = path.resolve(process.env.SETTINGS_FILE || dataFile("settings.json"));
const HISTORY_FILE = path.resolve(process.env.HISTORY_FILE || dataFile("history.json"));
const HISTORY_LIMIT = 2000;

const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFile(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file); // atomic replace, never leaves a half-written file; result is owner-only (600)
}

/** Settings, history, session and token are private to the account running the server. */
for (const file of [SETTINGS_FILE, HISTORY_FILE, SESSION_FILE]) {
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // not created yet
  }
}

// ---------- access token ----------
// Other OS users and other local programs can reach 127.0.0.1 too, so every request must carry a
// secret: opening the link printed in the terminal (?token=...) stores it in an HttpOnly, SameSite=Strict
// cookie. The token is kept in .ui-token (600) so the link and the cookie survive restarts.

const TOKEN_FILE = path.resolve(process.env.TOKEN_FILE || dataFile(".ui-token"));
const COOKIE = "tdl_token";

function loadToken() {
  if (process.env.UI_TOKEN) return process.env.UI_TOKEN;
  try {
    const saved = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (saved.length >= 32) {
      fs.chmodSync(TOKEN_FILE, 0o600);
      return saved;
    }
  } catch {
    // first run
  }
  const fresh = crypto.randomBytes(32).toString("base64url");
  fs.writeFileSync(TOKEN_FILE, fresh, { mode: 0o600 });
  return fresh;
}

const UI_TOKEN = loadToken();

function tokenMatches(value) {
  if (typeof value !== "string") return false;
  const a = crypto.createHash("sha256").update(value).digest();
  const b = crypto.createHash("sha256").update(UI_TOKEN).digest();
  return crypto.timingSafeEqual(a, b); // constant time, also for different lengths
}

// One-time codes for opening the UI from `npm run web`: the browser is launched with ?once=<code>
// instead of the real token, because a command line can be read by other users of the machine.
// A code works once, for 60 seconds, and only exchanges itself for the normal cookie.
const onceCodes = new Map(); // code -> expiry time

function issueOnceCode() {
  const code = crypto.randomBytes(24).toString("base64url");
  onceCodes.set(code, Date.now() + 60_000);
  return code;
}

function consumeOnceCode(code) {
  const expiry = onceCodes.get(code);
  onceCodes.delete(code);
  for (const [c, t] of onceCodes) if (t < Date.now()) onceCodes.delete(c);
  return typeof code === "string" && expiry !== undefined && expiry >= Date.now();
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// ---------- security headers ----------

const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin", // other sites cannot embed our media / API responses
};

/** CSP for the page: only our own inline scripts (by hash) and the pinned CDN files may run. */
function pageCsp(html) {
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (m) => `'sha256-${crypto.createHash("sha256").update(m[1]).digest("base64")}'`
  );
  return [
    "default-src 'none'",
    `script-src 'self' https://cdn.jsdelivr.net ${hashes.join(" ")}`,
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    "font-src https://cdn.jsdelivr.net",
    "img-src 'self' data: blob: https://cdn.jsdelivr.net",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

const LOCKED_PAGE = `<!doctype html><meta charset="utf-8"><title>Tele Downloader</title>
<body style="font:15px system-ui;max-width:560px;margin:15vh auto;padding:0 16px;line-height:1.5">
<h2>🔒 Cần mở bằng link có token</h2>
<p>Để người khác trên máy này không dùng được tài khoản Telegram của bạn, giao diện chỉ mở được bằng
link có token mà server in ra trong terminal khi chạy <code>npm run web</code>, dạng:</p>
<pre style="background:#eee;padding:8px;white-space:pre-wrap">http://127.0.0.1:PORT/?token=…</pre>
<p>Mở link đó một lần, trình duyệt sẽ ghi nhớ.</p></body>`;

// ---------- server-sent events ----------

const sseClients = new Set();

function safeWrite(res, payload) {
  try {
    if (!res.writableEnded) res.write(payload);
  } catch {
    sseClients.delete(res); // socket already gone
  }
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) safeWrite(res, payload);
}

// ---------- settings ----------

const settings = { downloadDir: null, subfolderPerChat: true, ...readJsonFile(SETTINGS_FILE, {}) };
if (!settings.downloadDir && process.env.DOWNLOAD_DIR) settings.downloadDir = path.resolve(process.env.DOWNLOAD_DIR);

const expandHome = (p) => (p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);

/** Validate a folder chosen in the UI: must exist and be writable. Returns the absolute path. */
function checkDir(dir) {
  if (typeof dir !== "string" || !dir.trim()) throw httpError(400, "Thư mục không hợp lệ");
  const abs = path.resolve(expandHome(dir.trim()));
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw httpError(400, `Thư mục không tồn tại: ${abs}`);
  }
  if (!stat.isDirectory()) throw httpError(400, `Không phải thư mục: ${abs}`);
  try {
    fs.accessSync(abs, fs.constants.W_OK);
  } catch {
    throw httpError(400, `Không có quyền ghi vào thư mục: ${abs}`);
  }
  return abs;
}

function saveSettings(patch) {
  Object.assign(settings, patch);
  writeJsonFile(SETTINGS_FILE, settings);
  broadcast("settings", settings);
}

/** Where files of a chat go inside a base folder. */
function chatDir(baseDir, title) {
  return settings.subfolderPerChat ? path.join(baseDir, sanitize(title)) : baseDir;
}

// ---------- download history (persisted; removing entries never touches the files) ----------

let history = readJsonFile(HISTORY_FILE, []);
let historySeq = history.reduce((max, h) => Math.max(max, h.id || 0), 0);

function addHistory(job, status) {
  const entry = {
    id: ++historySeq,
    at: Date.now(),
    status, // done | skipped | failed
    chat: job.chat,
    scanKey: job.scanKey,
    msgId: job.msgId,
    name: job.name,
    display: job.display,
    size: job.size,
    path: job.filePath || null,
    error: job.error || null,
  };
  history.unshift(entry);
  if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
  writeJsonFile(HISTORY_FILE, history);
  broadcast("history-add", entry);
}

function removeHistory(ids) {
  const drop = new Set(ids.map(Number));
  const before = history.length;
  history = history.filter((h) => !drop.has(h.id));
  writeJsonFile(HISTORY_FILE, history);
  broadcast("history", history);
  return before - history.length;
}

// ---------- folder browser (the browser cannot hand us a real path, so the server lists folders) ----------

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listFolder(requested) {
  const fallback = settings.downloadDir || (isDir(path.join(ROOT_DIR, "downloads")) ? path.join(ROOT_DIR, "downloads") : os.homedir());
  let dir = path.resolve(expandHome(requested || fallback));
  while (!isDir(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir); // nearest existing parent

  let dirs = [];
  try {
    dirs = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => !d.name.startsWith(".") && (d.isDirectory() || (d.isSymbolicLink() && isDir(path.join(dir, d.name)))))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, "vi"));
  } catch {
    // unreadable folder: show it empty
  }
  let writable = true;
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    writable = false;
  }

  const home = os.homedir();
  const shortcuts = [
    { label: "Home", icon: "house", path: home },
    { label: "Music", icon: "music-note-beamed", path: path.join(home, "Music") },
    { label: "Downloads", icon: "download", path: path.join(home, "Downloads") },
    { label: "Desktop", icon: "display", path: path.join(home, "Desktop") },
    { label: "Thư mục tool", icon: "folder", path: path.join(ROOT_DIR, "downloads") },
  ].filter((s) => isDir(s.path));

  return { path: dir, parent: path.dirname(dir) === dir ? null : path.dirname(dir), sep: path.sep, dirs, writable, shortcuts };
}

function makeFolder(parent, name) {
  const base = checkDir(parent);
  const clean = String(name ?? "").trim();
  if (!clean || clean === "." || clean === ".." || /[\\/\x00]/.test(clean) || clean.length > 200) {
    throw httpError(400, "Tên thư mục không hợp lệ");
  }
  const dir = path.join(base, clean);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------- auth ----------

let client = null;
const auth = { step: "connecting", error: null, me: null, phone: "", apiChoice: false };
let pendingInput = null; // { kind, resolve, reject } while waiting for the user (API, phone, code, password)
let earlyPhone = null; // phone typed on the login screen before the fresh client asked for it (right after logout)

// Which Telegram app (API ID / hash) to use: the built-in one from .env, or the user's own, chosen on the
// login screen like in the browser build. The choice / own credentials live in the private data folder.
const API_FILE = path.resolve(process.env.API_FILE || dataFile("api.json"));
const BACK = "__back__"; // "← choose again" on the login screen

function waitInput(kind) {
  if (kind === "phone" && earlyPhone) {
    const value = earlyPhone;
    earlyPhone = null;
    return Promise.resolve(value);
  }
  auth.step = kind;
  broadcast("auth", auth);
  return new Promise((resolve, reject) => (pendingInput = { kind, resolve, reject }));
}

/** Credentials chosen earlier, or null when the user has to choose / enter them. */
function chosenCreds() {
  const saved = readJsonFile(API_FILE, null);
  if (saved?.mode === "builtin") return envCreds(); // null if .env lost them: ask again
  if (saved?.id && saved?.hash) return { id: saved.id, hash: saved.hash };
  // Signed in with the .env app before this choice existed: keep using it without asking.
  if (!saved && envCreds() && fs.existsSync(SESSION_FILE)) return envCreds();
  return null;
}

/** Ask how to connect: the built-in app from .env (when it has one) or the user's own API ID/hash. */
async function chooseCreds() {
  for (;;) {
    const mode = envCreds() ? await waitInput("api_choice") : "own";
    if (mode === "builtin" && envCreds()) {
      writeJsonFile(API_FILE, { mode: "builtin" });
      return envCreds();
    }
    const own = await askApiCreds();
    if (own) return own;
  }
}

/** The user's own API ID + hash; null when they go back to the choice screen. */
async function askApiCreds() {
  for (;;) {
    const id = String(await waitInput("api_id")).trim();
    if (id === BACK && envCreds()) return (auth.error = null);
    if (!/^\d{3,12}$/.test(id)) {
      auth.error = "API ID là một dãy số (lấy ở my.telegram.org)";
      continue;
    }
    auth.error = null;
    const hash = String(await waitInput("api_hash")).trim().toLowerCase();
    if (hash === BACK && envCreds()) return (auth.error = null);
    if (!/^[0-9a-f]{32}$/.test(hash)) {
      auth.error = "API hash gồm 32 ký tự 0-9, a-f";
      continue;
    }
    auth.error = null;
    const creds = { id: Number(id), hash };
    writeJsonFile(API_FILE, creds);
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
  auth.apiChoice = !!envCreds();
  auth.phone = envValue("PHONE") || "";

  const creds = chosenCreds() || (await chooseCreds());
  if (run !== authRun) return;
  client = createClient(creds);
  await client.connect();

  if (!(await client.checkAuthorization())) {
    await client.start({
      phoneNumber: () => waitInput("phone"),
      phoneCode: () => waitInput("code"),
      password: () => waitInput("password"),
      onError: (err) => {
        if (run !== authRun) return true; // abandoned attempt: stop quietly
        auth.error = err.message;
        broadcast("auth", auth);
        return /API_ID/.test(err.message); // wrong API ID/hash: stop and ask for them again
      },
    });
    if (run !== authRun) return;
    saveSession(client);
  }

  const me = await client.getMe();
  if (run !== authRun) return;
  auth.me = { name: entityTitle(me), username: me.username || null };
  auth.step = "ready";
  auth.error = null;
  broadcast("auth", auth);
}

function runAuth(options) {
  const run = ++authRun;
  startAuth(options, run).catch((err) => {
    if (run !== authRun) return; // replaced by a newer attempt (e.g. back to the API choice)
    if (/API_ID/.test(err.message || "")) {
      const wasBuiltin = readJsonFile(API_FILE, null)?.mode === "builtin";
      fs.rmSync(API_FILE, { force: true }); // ask again how to connect
      auth.error = wasBuiltin
        ? "API trong .env đang không dùng được, hãy tự tạo API ID của bạn"
        : "API ID / API hash không đúng, hãy nhập lại";
      return runAuth();
    }
    auth.step = "error";
    auth.error = err.message;
    broadcast("auth", auth);
  });
}

/** "← Choose again" on the phone step: forget the chosen API and start over at the choice screen. */
function backToChoice() {
  const old = client;
  const waiting = pendingInput;
  client = null;
  pendingInput = null;
  earlyPhone = null;
  fs.rmSync(API_FILE, { force: true });
  Object.assign(auth, { error: null, me: null });
  runAuth(); // new attempt first, so the old one's rejection below is ignored
  waiting?.reject(new Error("back to API choice"));
  old?.destroy().catch(() => {});
}

/**
 * Sign out without making the user wait: the login screen (phone step) is shown immediately, the old
 * session is revoked in the background, and a fresh client connects in parallel (~2 s). A phone number
 * typed before that client is ready is kept and used as soon as it asks for one.
 */
function logout() {
  const old = client;
  fs.rmSync(SESSION_FILE, { force: true });
  scans.clear();
  photoCache.clear();
  cancelQueued();
  pendingInput = null;
  earlyPhone = null;
  Object.assign(auth, { step: "phone", error: null, me: null, phone: envValue("PHONE") || "", apiChoice: !!envCreds() });
  broadcast("auth", auth);

  (async () => {
    try {
      await Promise.race([old.invoke(new Api.auth.LogOut()), new Promise((r) => setTimeout(r, 5000))]);
    } catch {
      // session may already be invalid
    }
    await old.destroy().catch(() => {});
  })();

  runAuth({ keepStep: true });
}

// ---------- scanning ----------

// key -> { key, chat, type, title, items: Map<msgId, { msg, info }> }
const scans = new Map();

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
    if (items.size % 50 === 0) broadcast("scan", { chat, count: items.size });
  }

  const scan = { key, chat, type, title, items };
  scans.set(key, scan);
  return scan;
}


/** Paths of finished downloads recorded in the history for one scan: msgId -> path. */
function historyPaths(scanKey) {
  const map = new Map();
  for (const h of history) {
    if (h.scanKey === scanKey && h.path && ["done", "skipped"].includes(h.status) && !map.has(h.msgId)) map.set(h.msgId, h.path);
  }
  return map;
}

/** Path of a complete local copy of an item (default folder first, then the history), or null. */
function localCopy(scan, item, fromHistory = historyPaths(scan.key)) {
  if (settings.downloadDir) {
    const t = resolveTarget(chatDir(settings.downloadDir, scan.title), item.info.name, item.info.size, item.msg.id);
    if (t.skip) return t.filePath;
  }
  const p = fromHistory.get(item.msg.id);
  try {
    if (p && fs.statSync(p).size === item.info.size) return p;
  } catch {
    // moved or deleted outside the tool
  }
  return null;
}

function describeScan(scan) {
  const fromHistory = historyPaths(scan.key);
  return {
    key: scan.key,
    title: scan.title,
    outDir: settings.downloadDir ? chatDir(settings.downloadDir, scan.title) : null,
    files: [...scan.items.values()].map((item) => ({
      id: item.msg.id,
      name: item.info.name,
      kind: mediaKind(item.msg),
      title: item.info.title || null,
      performer: item.info.performer || null,
      duration: item.info.duration || null,
      size: item.info.size,
      date: item.msg.date,
      downloaded: !!localCopy(scan, item, fromHistory),
    })),
  };
}

// ---------- download queue ----------

const jobs = new Map(); // jobId -> public job state
const queue = []; // jobIds waiting to start
let active = 0;

function publicJob(job) {
  const { msg, scan, filePath, ...rest } = job;
  return rest;
}

function updateJob(job, patch) {
  Object.assign(job, patch);
  broadcast("job", publicJob(job));
}

function enqueue(scan, ids, baseDir) {
  const outDir = chatDir(baseDir, scan.title);
  fs.mkdirSync(outDir, { recursive: true });
  let added = 0;
  for (const id of ids) {
    const item = scan.items.get(Number(id));
    if (!item) continue;
    const jobId = `${scan.key}|${id}`;
    const existing = jobs.get(jobId);
    if (existing && ["queued", "downloading"].includes(existing.status)) continue;

    const job = {
      id: jobId,
      scanKey: scan.key,
      msgId: item.msg.id,
      name: item.info.name,
      display: displayName(item.info),
      chat: scan.title,
      outDir,
      size: item.info.size,
      received: 0,
      status: "queued",
      error: null,
      msg: item.msg,
      scan,
    };
    jobs.set(jobId, job);
    queue.push(jobId);
    broadcast("job", publicJob(job));
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
      .catch((err) => updateJob(job, { status: "failed", error: err.message }))
      .finally(() => {
      active--;
      pump();
    });
  }
}

async function runJob(job) {
  const { filePath, skip, release } = await claimTarget(job.outDir, job.name, job.size, job.msgId);
  job.filePath = filePath;
  if (skip) {
    updateJob(job, { status: "skipped", received: job.size, file: path.basename(filePath) });
    return addHistory(job, "skipped");
  }

  updateJob(job, { status: "downloading", error: null });
  let lastSent = 0;
  try {
    const size = await downloadFile(client, job.msg, filePath, (received, total) => {
      job.received = received;
      if (total) job.size = total;
      const now = Date.now();
      if (now - lastSent > 300) {
        lastSent = now;
        broadcast("job", publicJob(job));
      }
    });
    updateJob(job, { status: "done", received: size, size, file: path.basename(filePath) });
    addHistory(job, "done");
  } catch (err) {
    if (err.seconds) {
      // FLOOD_WAIT: Telegram wants us to slow down; retry after the wait.
      updateJob(job, { status: "queued", received: 0, error: `Flood wait ${err.seconds}s` });
      await new Promise((r) => setTimeout(r, err.seconds * 1000));
      queue.push(job.id);
    } else {
      updateJob(job, { status: "failed", error: err.message });
      addHistory(job, "failed");
    }
  } finally {
    release();
  }
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

function clearFinished() {
  for (const [id, job] of jobs) {
    if (!["queued", "downloading"].includes(job.status)) jobs.delete(id);
  }
  broadcast("jobs", [...jobs.values()].map(publicJob));
}

// ---------- http helpers ----------

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  if (!(req.headers["content-type"] || "").startsWith("application/json")) {
    throw Object.assign(new Error("Content-Type must be application/json"), { status: 415 });
  }
  // Read to the end so the response isn't sent mid-upload (that resets the socket), but keep only 1 MB.
  let body = "";
  let tooBig = false;
  for await (const chunk of req) {
    if (tooBig) continue; // drain and discard the rest
    body += chunk;
    if (body.length > 1e6) tooBig = true;
  }
  if (tooBig) throw httpError(413, "Dữ liệu gửi lên quá lớn");
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw httpError(400, "JSON không hợp lệ");
  }
}

function requireReady() {
  if (auth.step !== "ready") throw Object.assign(new Error("Not logged in"), { status: 401 });
}

function getScan(key) {
  const scan = scans.get(key);
  if (!scan) throw Object.assign(new Error("Chat not scanned yet, please reload the file list"), { status: 404 });
  return scan;
}

/** Stream a downloaded file with HTTP Range support so the audio player can seek. */
function streamFile(req, res, filePath) {
  const { size } = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".flac": "audio/flac", ".ogg": "audio/ogg", ".wav": "audio/wav",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mkv": "video/x-matroska",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif",
  };
  const headers = {
    "Content-Type": types[ext] || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Content-Security-Policy": "sandbox; default-src 'none'",
  };

  const range = parseRange(req.headers.range, size);
  if (!range) {
    res.writeHead(416, { "Content-Range": `bytes */${size}` });
    return res.end();
  }
  const { start, end, partial } = range;
  res.writeHead(partial ? 206 : 200, {
    ...headers,
    "Content-Length": end - start + 1,
    ...(partial && { "Content-Range": `bytes ${start}-${end}/${size}` }),
  });
  const stream = fs.createReadStream(filePath, { start, end });
  stream.on("error", () => res.destroy()); // e.g. file deleted while playing: drop this response, keep the server up
  stream.pipe(res);
}

/** Parse a Range header against size; returns { start, end, partial } or null if unsatisfiable. */
function parseRange(header, size) {
  const m = /bytes=(\d*)-(\d*)/.exec(header || "");
  if (!m || (!m[1] && !m[2])) return { start: 0, end: size - 1, partial: false };
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  return start <= end && start < size ? { start, end, partial: true } : null;
}

// Photos have no single byte size to stream by Range, so they are downloaded into memory (they are small).
const photoCache = new Map(); // "scanKey|msgId" -> Buffer, most recent last
const PHOTO_CACHE_MAX = 40;

async function sendPhoto(res, scan, item) {
  const key = `${scan.key}|${item.msg.id}`;
  let buf = photoCache.get(key);
  if (!buf) {
    buf = await client.downloadMedia(item.msg);
    if (!buf?.length) throw httpError(404, "Không tải được ảnh");
    photoCache.set(key, buf);
    if (photoCache.size > PHOTO_CACHE_MAX) photoCache.delete(photoCache.keys().next().value);
  }
  res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": buf.length, "Cache-Control": "private, max-age=3600" });
  res.end(buf);
}

const PREVIEW_REQUEST = 512 * 1024; // divides 1 MB, so aligned requests never cross a Telegram 1 MB block

/**
 * Stream a file straight from Telegram (no download to disk) so it can be played before downloading.
 * Honours Range so the player can seek, and back-pressure so we only fetch as fast as the browser plays.
 */
async function streamFromTelegram(req, res, item) {
  const size = item.info.size;
  if (!size) return sendJson(res, 404, { error: "Unknown file size" });
  const range = parseRange(req.headers.range, size);
  if (!range) {
    res.writeHead(416, { "Content-Range": `bytes */${size}` });
    return res.end();
  }

  const doc = item.msg.media?.document;
  res.writeHead(range.partial ? 206 : 200, {
    "Content-Type": safeMediaType(doc?.mimeType),
    "Content-Security-Policy": "sandbox; default-src 'none'", // even if opened directly, nothing can run
    "Accept-Ranges": "bytes",
    "Content-Length": range.end - range.start + 1,
    ...(range.partial && { "Content-Range": `bytes ${range.start}-${range.end}/${size}` }),
  });

  let closed = false;
  res.on("close", () => (closed = true));
  const aligned = range.start - (range.start % PREVIEW_REQUEST);
  let skip = range.start - aligned;
  let remaining = range.end - range.start + 1;

  try {
    for await (const chunk of client.iterDownload({
      file: item.msg.media,
      offset: bigInt(aligned),
      requestSize: PREVIEW_REQUEST,
      fileSize: bigInt(size),
    })) {
      if (closed) break;
      let buf = skip ? chunk.subarray(skip) : chunk;
      skip = 0;
      if (buf.length > remaining) buf = buf.subarray(0, remaining);
      remaining -= buf.length;
      if (!res.write(buf)) await new Promise((r) => (res.once("drain", r), res.once("close", r)));
      if (remaining <= 0) break;
    }
    res.end();
  } catch (err) {
    if (!closed) console.error("preview:", err.message);
    res.destroy();
  }
}

function openFolder(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  const child = spawn(cmd, [dir], { detached: true, stdio: "ignore" });
  child.on("error", (err) => console.error(`open-folder: ${err.message}`)); // no file manager installed
  child.unref();
}

// ---------- routes ----------

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  switch (route) {
    case "GET /api/events": {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(`event: auth\ndata: ${JSON.stringify(auth)}\n\n`);
      res.write(`event: jobs\ndata: ${JSON.stringify([...jobs.values()].map(publicJob))}\n\n`);
      res.write(`event: settings\ndata: ${JSON.stringify(settings)}\n\n`);
      res.write(`event: history\ndata: ${JSON.stringify(history)}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    case "GET /api/status":
      return sendJson(res, 200, auth);

    case "POST /api/login": {
      const { kind, value } = await readJson(req);
      if (!String(value ?? "").trim()) return sendJson(res, 400, { error: "Vui lòng nhập giá trị" });
      if (value === BACK && kind === "phone" && envCreds() && auth.step === "phone") {
        backToChoice();
        return sendJson(res, 200, { ok: true });
      }
      if (!pendingInput && kind === "phone" && auth.step === "phone") {
        // Typed while the fresh client is still connecting (just after logout): keep it for later.
        earlyPhone = String(value).trim();
        auth.step = "waiting";
        auth.error = null;
        broadcast("auth", auth);
        return sendJson(res, 200, { ok: true });
      }
      if (!pendingInput || pendingInput.kind !== kind) return sendJson(res, 409, { error: "Not waiting for this input" });
      const { resolve } = pendingInput;
      pendingInput = null;
      auth.step = "waiting";
      auth.error = null;
      broadcast("auth", auth);
      resolve(String(value).trim());
      return sendJson(res, 200, { ok: true });
    }

    case "POST /api/logout":
      requireReady();
      logout();
      return sendJson(res, 200, { ok: true });

    case "GET /api/dialogs": {
      requireReady();
      const dialogs = await client.getDialogs({});
      return sendJson(
        res,
        200,
        dialogs.map((d) => ({
          id: String(d.id),
          title: d.title || entityTitle(d.entity),
          type: dialogType(d),
          username: d.entity?.username || null,
        }))
      );
    }

    case "GET /api/files": {
      requireReady();
      const chat = (url.searchParams.get("chat") || "").trim();
      const type = url.searchParams.get("type") || "music";
      if (!chat) return sendJson(res, 400, { error: "chat is required" });
      if (!(type in FILTERS)) return sendJson(res, 400, { error: `Invalid type "${type}"` });
      const scan = await scanChat(chat, type);
      return sendJson(res, 200, describeScan(scan));
    }

    case "POST /api/download": {
      requireReady();
      const { key, ids, dir, remember } = await readJson(req);
      if (!Array.isArray(ids) || !ids.length) return sendJson(res, 400, { error: "No files selected" });
      const scan = getScan(key);
      // A folder chosen for this download wins; otherwise the saved default; otherwise ask the user.
      let base = dir ? checkDir(dir) : settings.downloadDir;
      if (!base) throw httpError(409, "Chưa chọn thư mục tải xuống", { code: "NEED_DIR" });
      if (!dir) base = checkDir(base); // the saved folder may have been removed since
      if (dir && remember) saveSettings({ downloadDir: base });
      return sendJson(res, 200, { added: enqueue(scan, ids, base), outDir: chatDir(base, scan.title) });
    }

    case "GET /api/scan":
      // Re-check which files are on disk (after settings / history changes) without rescanning Telegram.
      return sendJson(res, 200, describeScan(getScan(url.searchParams.get("key"))));

    case "GET /api/settings":
      return sendJson(res, 200, settings);

    case "POST /api/settings": {
      const body = await readJson(req);
      const patch = {};
      if ("downloadDir" in body) patch.downloadDir = body.downloadDir === null ? null : checkDir(body.downloadDir);
      if ("subfolderPerChat" in body) patch.subfolderPerChat = !!body.subfolderPerChat;
      saveSettings(patch);
      return sendJson(res, 200, settings);
    }

    case "GET /api/fs":
      return sendJson(res, 200, listFolder(url.searchParams.get("path")));

    case "POST /api/fs/mkdir": {
      const { parent, name } = await readJson(req);
      return sendJson(res, 200, { path: makeFolder(parent, name) });
    }

    case "GET /api/history":
      return sendJson(res, 200, history);

    case "POST /api/history/delete": {
      const { ids } = await readJson(req);
      if (!Array.isArray(ids) || !ids.length) return sendJson(res, 400, { error: "No entries selected" });
      return sendJson(res, 200, { removed: removeHistory(ids) });
    }

    case "POST /api/history/clear":
      return sendJson(res, 200, { removed: removeHistory(history.map((h) => h.id)) });

    case "POST /api/cancel":
      return sendJson(res, 200, { cancelled: cancelQueued() });

    case "POST /api/clear":
      clearFinished();
      return sendJson(res, 200, { ok: true });

    case "POST /api/open-folder": {
      const { key, historyId } = await readJson(req);
      if (historyId !== undefined) {
        const h = history.find((x) => x.id === Number(historyId));
        if (!h?.path) throw httpError(404, "Không tìm thấy mục lịch sử");
        openFolder(path.dirname(h.path));
        return sendJson(res, 200, { ok: true });
      }
      if (!settings.downloadDir) throw httpError(409, "Chưa chọn thư mục tải xuống", { code: "NEED_DIR" });
      openFolder(key && scans.has(key) ? chatDir(settings.downloadDir, scans.get(key).title) : settings.downloadDir);
      return sendJson(res, 200, { ok: true });
    }

    case "GET /api/media": {
      const scan = getScan(url.searchParams.get("key"));
      const item = scan.items.get(Number(url.searchParams.get("id")));
      if (!item) return sendJson(res, 404, { error: "File not found" });
      // Already on disk -> play the local copy; otherwise stream it from Telegram for a preview.
      const local = localCopy(scan, item);
      if (local) return streamFile(req, res, local);
      requireReady();
      if (item.msg.media instanceof Api.MessageMediaPhoto) return sendPhoto(res, scan, item);
      return streamFromTelegram(req, res, item);
    }
  }

  sendJson(res, 404, { error: "Not found" });
}

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(BASE_HEADERS)) res.setHeader(k, v);

  // Only answer requests made from this UI: blocks DNS-rebinding and other sites posting to localhost.
  const allowed = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];
  const origin = req.headers.origin;
  if (!allowed.includes(req.headers.host) || (origin && !allowed.some((h) => origin === `http://${h}`))) {
    return sendJson(res, 403, { error: "Forbidden" });
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const isApi = url.pathname.startsWith("/api/");
  if (isApi) res.setHeader("Cache-Control", "no-store");

  // First visit with ?token=…: remember it in a cookie, then drop it from the address bar / history.
  const queryToken = url.searchParams.get("token");
  const onceCode = url.searchParams.get("once");
  if ((queryToken !== null || onceCode !== null) && !isApi) {
    if (!(queryToken !== null ? tokenMatches(queryToken) : consumeOnceCode(onceCode))) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(LOCKED_PAGE.replace("PORT", PORT));
    }
    res.writeHead(303, {
      "Set-Cookie": `${COOKIE}=${encodeURIComponent(UI_TOKEN)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
      Location: "/",
    });
    return res.end();
  }
  if (!tokenMatches(readCookie(req, COOKIE))) {
    if (isApi) return sendJson(res, 401, { error: "Cần mở giao diện bằng link có token in trong terminal", code: "NEED_TOKEN" });
    res.writeHead(url.pathname === "/" ? 401 : 404, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(LOCKED_PAGE.replace("PORT", PORT));
  }

  try {
    if (isApi) return await handleApi(req, res, url);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": pageCsp(html) });
      return res.end(html);
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message, ...(err.status && err.code && { code: err.code }) });
    else res.end();
  }
});

// A bug in one request or background task must not take the whole server (and running downloads) down.
process.on("unhandledRejection", (err) => console.error("unhandled rejection:", err?.message || err));
process.on("uncaughtException", (err) => console.error("uncaught exception:", err?.message || err));

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Cổng ${PORT} đang bị chương trình khác dùng. Tắt chương trình đó, hoặc chạy với cổng khác: PORT=3001 npm run web`);
  } else {
    console.error(`Không khởi động được server: ${err.message}`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Telegram downloader UI: http://127.0.0.1:${PORT}/?token=${UI_TOKEN}`);
  console.log("(Link chứa token bí mật — chỉ mở trên máy này, đừng chia sẻ. Ctrl+click để mở; mỗi trình duyệt chỉ cần mở 1 lần.)");
  // --open: open the UI in the default browser, already signed in, with a one-time code (never the token).
  if (process.argv.includes("--open")) {
    const cmd = process.env.TDL_OPEN_CMD || (process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open");
    const child = spawn(cmd, [`http://127.0.0.1:${PORT}/?once=${issueOnceCode()}`], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  }
  runAuth();
});

// Keep the SSE connections alive through proxies / idle timeouts.
setInterval(() => {
  for (const res of sseClients) safeWrite(res, ": ping\n\n");
}, 25000).unref();
