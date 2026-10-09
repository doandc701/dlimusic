// Node-only Telegram helpers used by the CLI (index.js) and the local web server (server.js).
// Everything that also runs in the browser lives in core.js and is re-exported here.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

export {
  FILTERS,
  extname,
  splitName,
  displayName,
  sanitize,
  safeMediaType,
  formatBytes,
  MIME_EXT,
  fileInfo,
  mediaKind,
  dialogType,
  resolveChat,
  entityTitle,
  normalizeChatIds,
  isFavoriteId,
  FAVORITES_LIMIT,
} from "./core.js";

// ---------- private data folder ----------
// The Telegram session (full account access), the UI token, settings and history live OUTSIDE the
// project folder, so serving or sharing the project (VS Code Live Server, `npx serve`, git, uploads)
// can never expose them.

function defaultDataDir() {
  if (process.platform === "win32") return path.join(process.env.APPDATA || os.homedir(), "tele-downloader");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "tele-downloader");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "tele-downloader");
}

export const DATA_DIR = path.resolve(process.env.TDL_DATA_DIR || defaultDataDir());
export const dataFile = (name) => path.join(DATA_DIR, name);
const PROJECT_DIR = path.dirname(new URL(import.meta.url).pathname);
const PRIVATE_FILES = ["session.txt", "settings.json", "history.json", ".ui-token"];

function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== "EXDEV") throw err;
    fs.copyFileSync(from, to); // different disk
    fs.rmSync(from);
  }
  fs.chmodSync(to, 0o600);
}

/** Create the private folder (700) and move files left in the project folder by older versions. */
function prepareDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(DATA_DIR, 0o700);
  for (const dir of new Set([PROJECT_DIR, process.cwd()])) {
    if (path.resolve(dir) === DATA_DIR) continue;
    for (const name of PRIVATE_FILES) {
      const legacy = path.join(dir, name);
      if (!fs.existsSync(legacy)) continue;
      const target = dataFile(name);
      // Never leave a copy behind in the project; keep both if the private folder already has one.
      moveFile(legacy, fs.existsSync(target) ? `${target}.old-${Date.now()}` : target);
    }
  }
}

prepareDataDir();

export const SESSION_FILE = dataFile("session.txt");

/** Values from the .env file (re-read on every call, so edits apply without restarting), or {}. */
export function readEnvFile() {
  const file = process.env.TDL_ENV_FILE || [path.resolve(".env"), path.join(PROJECT_DIR, ".env")].find((f) => fs.existsSync(f));
  try {
    return Object.fromEntries(
      fs.readFileSync(file, "utf8").split(/\r?\n/)
        .map((line) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line))
        .filter(Boolean)
        .map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")])
    );
  } catch {
    return {};
  }
}

/** A value from .env, falling back to the real environment. */
export function envValue(name) {
  const fromFile = readEnvFile()[name];
  return fromFile !== undefined ? fromFile : process.env[name];
}

/** API ID / hash of the built-in app (.env API_ID + API_HASH), or null when missing or malformed. */
export function envCreds() {
  const id = Number(envValue("API_ID"));
  const hash = String(envValue("API_HASH") || "").trim();
  return Number.isInteger(id) && id > 0 && /^[0-9a-f]{32}$/i.test(hash) ? { id, hash } : null;
}

/** A client for the given API ID / hash and the saved session (not yet connected). */
export function createClient(creds = envCreds()) {
  if (!creds) {
    throw new Error("Thiếu API_ID / API_HASH trong .env. Tạo ở https://my.telegram.org → API development tools rồi điền vào .env.");
  }
  const saved = fs.existsSync(SESSION_FILE) ? fs.readFileSync(SESSION_FILE, "utf8").trim() : "";
  const client = new TelegramClient(new StringSession(saved), creds.id, creds.hash, { connectionRetries: 5 });
  client.setLogLevel("error");
  return client;
}

export function saveSession(client) {
  fs.writeFileSync(SESSION_FILE, client.session.save(), { mode: 0o600 });
  fs.chmodSync(SESSION_FILE, 0o600); // mode above only applies when the file is created
}

/** Pick a path that does not clash with a different file; returns { filePath, skip }. */
export function resolveTarget(dir, name, size, msgId) {
  const filePath = path.join(dir, name);
  if (!fs.existsSync(filePath)) return { filePath, skip: false };

  const existing = fs.statSync(filePath).size;
  if (size && existing === size) return { filePath, skip: true };

  const { name: base, ext } = path.parse(name);
  const alt = path.join(dir, `${base}_${msgId}${ext}`);
  if (fs.existsSync(alt) && (!size || fs.statSync(alt).size === size)) return { filePath: alt, skip: true };
  return { filePath: alt, skip: false };
}

const inFlight = new Map(); // target path -> promise settled when that download finishes

/**
 * Reserve the target file for one download. Channels often re-post the same track (same name and
 * size), so several jobs can resolve to the same path; only one may write it at a time, the others
 * wait and are then reported as already downloaded (or take over if the first one failed).
 * Returns { filePath, skip, release }; call release() when the download is finished (skip=false only).
 */
export async function claimTarget(dir, name, size, msgId) {
  for (;;) {
    const target = resolveTarget(dir, name, size, msgId);
    if (target.skip) return { ...target, release: () => {} };
    const busy = inFlight.get(target.filePath);
    if (!busy) {
      let done;
      inFlight.set(target.filePath, new Promise((r) => (done = r)));
      return {
        ...target,
        release: () => {
          inFlight.delete(target.filePath);
          done();
        },
      };
    }
    await busy;
  }
}

/** Download one message's media to filePath via a .part file; returns the final size in bytes. */
export async function downloadFile(client, msg, filePath, onProgress) {
  const tmp = `${filePath}.part`;
  try {
    await client.downloadMedia(msg, {
      outputFile: tmp,
      progressCallback: (received, total) => onProgress?.(Number(received), Number(total)),
    });
    fs.renameSync(tmp, filePath);
    return fs.statSync(filePath).size;
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
