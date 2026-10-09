// Pure helpers shared by the Node version (lib.js, server.js, index.js) and the browser build (web/).
// No Node built-ins here: this file is bundled for the browser too.

import { Api } from "telegram";

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
  const m = String(mime ?? "").trim().toLowerCase();
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

  const username = chat.replace(/^https?:\/\/t\.me\//, "").replace(/^@/, "").split(/[/?]/)[0];
  return client.getEntity(username);
}

export function entityTitle(entity) {
  return entity.title || [entity.firstName, entity.lastName].filter(Boolean).join(" ") || entity.username || String(entity.id);
}
