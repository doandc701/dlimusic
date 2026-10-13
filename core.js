// Pure helpers shared by the Node version (lib.js, server.js, index.js) and the browser build (web/).
// No Node built-ins here: this file is bundled for the browser too.

import { Api } from "telegram";
import qrcode from "qrcode-generator";

export const FILTERS = {
  all: null,
  music: Api.InputMessagesFilterMusic,
  video: Api.InputMessagesFilterVideo,
  photo: Api.InputMessagesFilterPhotos,
  document: Api.InputMessagesFilterDocument,
  voice: Api.InputMessagesFilterVoice,
};

/** Like path.extname, without depending on Node's path module. */
export function extname(name) {
  const base = String(name).split(/[\\/]/).pop();
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i) : "";
}

/** "name.mp3" -> { base: "name", ext: ".mp3" } */
export function splitName(name) {
  const ext = extname(name);
  return { base: ext ? name.slice(0, -ext.length) : name, ext };
}

/** The name Telegram apps show: "Performer – Title" from the audio tags, else the file name. */
export function displayName(info) {
  return info.title ? (info.performer ? `${info.performer} – ${info.title}` : info.title) : info.name;
}

// Invisible / direction-changing characters (e.g. U+202E) can disguise a file's real extension.
const BIDI_AND_INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/**
 * Turn a name that comes from Telegram (file, chat title) into a safe single path segment:
 * never "." / ".." (which would escape the download folder), no separators or control characters.
 */
export function sanitize(name) {
  let clean = String(name ?? "")
    .replace(BIDI_AND_INVISIBLE, "")
    .replace(/\s+/g, " ")
    .replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, "_")
    .trim()
    .slice(0, 200)
    .replace(/[. ]+$/, ""); // trailing dots/spaces are stripped by Windows and turn "a.." into "a"
  if (!clean || /^\.+$/.test(clean)) return "file";
  if (clean.startsWith(".")) clean = `_${clean}`; // no hidden files
  if (WINDOWS_RESERVED.test(clean)) clean = `_${clean}`;
  return clean;
}

const SAFE_MEDIA = /^(audio\/[\w.+-]+|video\/[\w.+-]+|image\/(jpeg|png|gif|webp|bmp|avif))$/i;

/**
 * Content-Type to serve a Telegram file with. The MIME type is chosen by whoever uploaded the file,
 * so anything that a browser could execute (text/html, image/svg+xml, ...) becomes a plain download.
 */
export function safeMediaType(mime) {
  const m = String(mime ?? "")
    .trim()
    .toLowerCase();
  return SAFE_MEDIA.test(m) ? m : "application/octet-stream";
}

export function formatBytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(1)} ${units[i]}`;
}

export const MIME_EXT = {
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/flac": ".flac",
  "audio/x-flac": ".flac",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/x-matroska": ".mkv",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
};

/** Build a readable file name for the media in a message. Returns null if it has nothing downloadable. */
export function fileInfo(msg) {
  const media = msg.media;
  if (!media) return null;

  if (media instanceof Api.MessageMediaPhoto && media.photo) {
    return { name: `photo_${msg.id}.jpg`, size: 0 };
  }

  if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
    const doc = media.document;
    const size = Number(doc.size ?? 0);
    let fileName = null;
    let audio = null;
    for (const attr of doc.attributes ?? []) {
      if (attr instanceof Api.DocumentAttributeFilename) fileName = attr.fileName;
      if (attr instanceof Api.DocumentAttributeAudio) audio = attr;
      if (attr instanceof Api.DocumentAttributeSticker) return null; // skip stickers
    }

    const ext = (fileName && extname(fileName)) || MIME_EXT[doc.mimeType] || "";

    if (!fileName && audio && (audio.title || audio.performer)) {
      fileName = [audio.performer, audio.title].filter(Boolean).join(" - ") + ext;
    }
    if (!fileName) {
      const kind = audio ? (audio.voice ? "voice" : "audio") : (doc.mimeType || "file").split("/")[0];
      fileName = `${kind}_${msg.id}${ext}`;
    }
    const info = { name: sanitize(fileName), size };
    // Telegram apps show the audio tags ("Performer – Title"), which often differ from the file name.
    if (audio?.title) info.title = audio.title;
    if (audio?.performer) info.performer = audio.performer;
    if (audio?.duration) info.duration = audio.duration;
    for (const attr of doc.attributes ?? []) {
      if (attr instanceof Api.DocumentAttributeVideo && attr.duration) info.duration = Math.round(attr.duration);
    }
    return info;
  }

  return null; // web pages, polls, geo, contacts... are not files
}

/** What a message's file is, for choosing how to preview it: photo | image | video | audio | voice | document. */
export function mediaKind(msg) {
  const media = msg.media;
  if (media instanceof Api.MessageMediaPhoto) return "photo";
  const doc = media?.document;
  if (!(doc instanceof Api.Document)) return null;
  const mime = doc.mimeType || "";
  for (const attr of doc.attributes ?? []) {
    if (attr instanceof Api.DocumentAttributeVideo) return "video";
    if (attr instanceof Api.DocumentAttributeAudio) return attr.voice ? "voice" : "audio";
  }
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("image/")) return "image";
  return "document";
}

export function dialogType(d) {
  return d.isChannel && !d.isGroup ? "channel" : d.isGroup ? "group" : "user";
}

export async function resolveChat(client, chat) {
  if (chat === "me") return client.getEntity("me");

  if (/^-?\d+$/.test(chat)) {
    // Numeric ids need to be in the entity cache, so look them up among the dialogs.
    const dialogs = await client.getDialogs({});
    const found = dialogs.find((d) => String(d.id) === chat);
    if (!found) throw new Error(`Chat id ${chat} not found in your dialogs. Run with --list to see ids.`);
    return found.entity;
  }

  const username = chat
    .replace(/^https?:\/\/t\.me\//, "")
    .replace(/^@/, "")
    .split(/[/?]/)[0];
  return client.getEntity(username);
}

export function entityTitle(entity) {
  return (
    entity.title ||
    [entity.firstName, entity.lastName].filter(Boolean).join(" ") ||
    entity.username ||
    String(entity.id)
  );
}

/**
 * The list of chats an account chose to show, as sent by the UI: null = show every chat, otherwise
 * Telegram chat ids (as strings, deduplicated). Returns undefined when the value is not valid.
 */
export function normalizeChatIds(value) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 10000) return undefined;
  const ids = value.map((v) => (typeof v === "number" && Number.isSafeInteger(v) ? String(v) : v));
  if (!ids.every((v) => typeof v === "string" && /^-?\d{1,20}$/.test(v))) return undefined;
  return [...new Set(ids)];
}

/** Id of a favourite file: "<chat id>|<message id>" (stays the same across rescans and file types). */
export function isFavoriteId(value) {
  return typeof value === "string" && /^-?\d{1,20}\|\d{1,12}$/.test(value);
}
export const FAVORITES_LIMIT = 20000;

// ---------- sign-in with a QR code (scanned with the Telegram app: Settings → Devices) ----------

/** Value sent instead of a phone number to switch the sign-in to a QR code. */
export const QR_LOGIN = "__qr__";

/** The tg://login link of a login token (bytes from auth.ExportLoginToken) and an SVG QR code of it. */
export function loginQr(token) {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(token)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const url = `tg://login?token=${b64}`;
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  return { url, svg: qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }) };
}

// ---------- Telegram sign-in errors in plain Vietnamese ----------

const AUTH_ERRORS = {
  PHONE_CODE_INVALID: "Mã xác nhận không đúng. Kiểm tra lại mã trong app Telegram rồi nhập lại.",
  PHONE_CODE_EXPIRED: "Mã xác nhận đã hết hạn. Hãy quay lại bước số điện thoại để nhận mã mới.",
  PHONE_CODE_EMPTY: "Vui lòng nhập mã xác nhận.",
  PHONE_NUMBER_INVALID: "Số điện thoại không hợp lệ. Kiểm tra lại mã quốc gia và số điện thoại.",
  PHONE_NUMBER_BANNED: "Số điện thoại này đã bị Telegram khoá.",
  PHONE_NUMBER_UNOCCUPIED: "Số điện thoại này chưa đăng ký Telegram.",
  PHONE_NUMBER_FLOOD: "Số này đã yêu cầu mã quá nhiều lần. Vui lòng thử lại sau.",
  PASSWORD_HASH_INVALID: "Mật khẩu xác minh 2 bước không đúng.",
  PASSWORD_EMPTY: "Vui lòng nhập mật khẩu xác minh 2 bước.",
  AUTH_RESTART: "Phiên đăng nhập bị gián đoạn. Vui lòng thử lại.",
  AUTH_TOKEN_EXPIRED: "Mã QR đã hết hạn. Hãy quét mã mới.",
  API_ID_INVALID: "API ID / API hash không đúng.",
  API_ID_PUBLISHED_FLOOD: "API có sẵn đang bị Telegram giới hạn. Hãy tự tạo API ID của bạn.",
};

/** Message of a GramJS / Telegram error for the login screen ("400: PHONE_CODE_INVALID (…)" -> Vietnamese). */
export function authErrorText(err) {
  const raw = String(err?.errorMessage || err?.message || err || "");
  const code = err?.errorMessage || /\b([A-Z][A-Z0-9_]{3,})\b/.exec(raw)?.[1] || "";
  const wait = Number(err?.seconds) || Number(/FLOOD_WAIT_(\d+)/.exec(raw)?.[1]) || 0;
  if (wait || /FLOOD/.test(code)) {
    if (!wait) return AUTH_ERRORS[code] || "Bạn thử quá nhiều lần. Vui lòng đợi một lúc rồi thử lại.";
    const left =
      wait >= 3600 ? `${Math.ceil(wait / 3600)} giờ` : wait >= 60 ? `${Math.ceil(wait / 60)} phút` : `${wait} giây`;
    return `Bạn thử quá nhiều lần. Telegram yêu cầu đợi ${left} rồi thử lại.`;
  }
  if (AUTH_ERRORS[code]) return AUTH_ERRORS[code];
  if (/Code is empty/i.test(raw)) return AUTH_ERRORS.PHONE_CODE_EMPTY;
  if (/timeout|timed out|ECONN|ENOTFOUND|ETIMEDOUT|network|websocket|socket|Not connected/i.test(raw)) {
    return "Không kết nối được tới Telegram. Kiểm tra mạng rồi thử lại.";
  }
  if (/^[A-Z][A-Z0-9_]+$/.test(code) && /^\d{3}:/.test(raw))
    return `Telegram từ chối đăng nhập (${code}). Vui lòng thử lại.`;
  return raw || "Đăng nhập không thành công. Vui lòng thử lại.";
}

// ---------- scanning a chat page by page ----------

/** Files per page: shown at once, the next page loads when the list is scrolled to the end. */
export const PAGE_SIZE = 500;

/**
 * Read the next page of a scan: files of messages older than scan.cursor (the last message read), until
 * `pageSize` new files or the oldest message. Fills scan.items, moves scan.cursor, clears scan.more at the
 * end. `messages(offsetId)` iterates messages newest first (client.iterMessages); leaving it early also
 * stops the requests. Returns the ids of the new files, in order.
 */
export async function readPage(
  scan,
  messages,
  { pageSize = PAGE_SIZE, signal, stopped = () => new Error("stopped"), onProgress } = {},
) {
  const page = [];
  if (!scan.more) return page;
  let full = false;
  for await (const msg of messages(scan.cursor)) {
    if (signal?.aborted) throw stopped();
    scan.cursor = msg.id;
    const info = fileInfo(msg);
    if (!info || scan.items.has(msg.id)) continue;
    scan.items.set(msg.id, { msg, info });
    page.push(msg.id);
    if (page.length % 50 === 0) onProgress?.(scan.items.size);
    if (page.length >= pageSize) {
      full = true;
      break;
    }
  }
  if (!full) scan.more = false; // reached the oldest message
  return page;
}

// ---------- data shared by every device of an account (kept in MongoDB) ----------
// settings: { subfolderPerChat } (the download folder belongs to each device) · history: entries, newest
// first · visibleChats: chat ids or null (= all) · favorites: "<chat id>|<message id>", newest first ·
// recent: the songs played lately, { id: "<chat id>|<message id>", at, … }, newest first.
// Devices send operations, not whole copies, so two devices changing things at once lose nothing.

export const ACCOUNT_NAMES = ["settings", "history", "visibleChats", "favorites", "recent"];
export const HISTORY_MAX = 2000;
export const RECENT_MAX = 100;
const LISTS = new Set(["history", "favorites", "recent"]);
/** Lists of entries with an id (history, recent plays) and how many are kept. */
const ENTRY_MAX = { history: HISTORY_MAX, recent: RECENT_MAX };

/** What an item is when nothing was saved yet. */
export const accountEmpty = (name) => (LISTS.has(name) ? [] : null);

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Operations turning `before` into `after`. */
export function accountOps(name, before, after) {
  if (name === "favorites") {
    const b = new Set(before || []);
    const a = new Set(after || []);
    const ops = [...b].filter((id) => !a.has(id)).map((id) => ({ op: "remove", id }));
    // added ones are put in front one by one: the oldest first, so the newest ends up on top
    return ops.concat(
      (after || [])
        .filter((id) => !b.has(id))
        .reverse()
        .map((id) => ({ op: "add", id })),
    );
  }
  if (name in ENTRY_MAX) {
    const b = before || [];
    const a = after || [];
    if (!a.length && b.length) return [{ op: "clear" }];
    const aIds = new Set(a.map((h) => h.id));
    const bAt = new Map(b.map((h) => [h.id, h.at]));
    const ops = [];
    const removed = b.filter((h) => !aIds.has(h.id)).map((h) => h.id);
    if (removed.length) ops.push({ op: "remove", ids: removed });
    // new entries, and ones seen again (a song played again moves to the top: its time changed)
    const added = a.filter((h) => !bAt.has(h.id) || bAt.get(h.id) !== h.at);
    if (added.length) ops.push({ op: "add", entries: added });
    return ops;
  }
  return same(before, after) ? [] : [{ op: "set", value: after ?? null }];
}

/** The same operations applied to a copy (MongoDB applies them the same way). */
export function applyAccountOps(name, value, ops) {
  let v = value ?? accountEmpty(name);
  for (const o of ops) {
    if (o.op === "set") v = o.value;
    else if (o.op === "clear") v = [];
    else if (name === "favorites" && o.op === "add") v = [o.id, ...v.filter((x) => x !== o.id)];
    else if (name === "favorites" && o.op === "remove") v = v.filter((x) => x !== o.id);
    else if (name in ENTRY_MAX && o.op === "add") {
      const ids = new Set(o.entries.map((h) => h.id));
      v = [...o.entries, ...v.filter((h) => !ids.has(h.id))].slice(0, ENTRY_MAX[name]);
    } else if (name in ENTRY_MAX && o.op === "remove") v = v.filter((h) => !o.ids.includes(h.id));
  }
  return v;
}

/** A history id that two devices will not both pick (the old ones were 1, 2, 3… on every device). */
export const newHistoryId = () => Date.now() * 1000 + Math.floor(Math.random() * 1000);

/**
 * First time a device joins (or after being offline): one copy out of this device's and MongoDB's,
 * losing nothing. Lists are united; for settings / visible chats MongoDB's choice wins when it has one.
 */
export function mergeAccount(name, mine, theirs) {
  if (name === "favorites") return [...new Set([...(theirs || []), ...(mine || [])])];
  if (name === "history") {
    const byId = new Map((theirs || []).map((h) => [h.id, h]));
    for (const h of mine || []) {
      const other = byId.get(h.id);
      if (!other) byId.set(h.id, h);
      else if (!same(other, h)) {
        const id = newHistoryId(); // same old number on two devices, different downloads: keep both
        byId.set(id, { ...h, id });
      }
    }
    return [...byId.values()].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, HISTORY_MAX);
  }
  if (name === "recent") {
    // the same song played on two devices: keep the latest play
    const byId = new Map();
    for (const h of [...(theirs || []), ...(mine || [])])
      if (!byId.has(h.id) || (h.at || 0) > (byId.get(h.id).at || 0)) byId.set(h.id, h);
    return [...byId.values()].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, RECENT_MAX);
  }
  return theirs ?? mine ?? null;
}
