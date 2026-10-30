// Pure helpers shared by the Node version (lib.js, server.js, index.js) and the browser build (web/).
// No Node built-ins here: this file is bundled for the browser too.

import { Api, utils } from "telegram";
import qrcode from "qrcode-generator";
import bigInt from "big-integer";

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

// ---------- global search and joining chats (like Telegram's search box) ----------

/** Peer id as the dialogs list writes it ("-100…" channels, "-…" basic groups, users as is). */
function markedId(entity) {
  const id = String(entity.id);
  if (entity instanceof Api.Channel) return `-100${id}`;
  if (entity instanceof Api.Chat) return `-${id}`;
  return id;
}

/** A user / chat / channel from a Telegram answer as a search result row; null for what cannot be shown. */
export function chatResult(entity, extra = {}) {
  if (!entity) return null;
  let type;
  let joined;
  if (entity instanceof Api.User) {
    if (entity.deleted) return null;
    type = entity.bot ? "bot" : "user";
    joined = false;
  } else if (entity instanceof Api.Channel) {
    type = entity.broadcast && !entity.megagroup ? "channel" : "group";
    joined = !entity.left;
  } else if (entity instanceof Api.Chat) {
    if (entity.deactivated) return null; // upgraded to a supergroup: that one is shown instead
    type = "group";
    joined = !entity.left;
  } else return null; // ChatForbidden / ChannelForbidden / ChatEmpty / UserEmpty: banned or gone
  const members = Number(entity.participantsCount);
  return {
    id: markedId(entity),
    title: entityTitle(entity),
    username: entity.username || entity.usernames?.find((u) => u.active)?.username || null,
    type,
    members: Number.isFinite(members) && members > 0 ? members : null,
    joined,
    ...(entity.verified && { verified: true }),
    ...(photoId(entity) && { photo: photoId(entity) }),
    ...extra,
  };
}

/** The hash of an invite link (t.me/+HASH, t.me/joinchat/HASH, tg://join?invite=HASH), or null. */
export function inviteHash(text) {
  const s = String(text ?? "").trim();
  const m =
    /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\/(?:\+|joinchat\/)([\w-]{4,64})\/?(?:[?#].*)?$/i.exec(
      s,
    ) || /^tg:\/\/join\?invite=([\w-]{4,64})(?:&.*)?$/i.exec(s);
  return m ? m[1] : null;
}

const httpErr = (status, message) => Object.assign(new Error(message), { status });

/** The search box text, trimmed; throws a 400 error when it is empty or longer than 64 characters. */
export function searchQuery(value) {
  const q = typeof value === "string" ? value.trim() : "";
  if (!q || q.length > 64) throw httpErr(400, "Từ khoá tìm kiếm phải có từ 1 đến 64 ký tự");
  return q;
}

/**
 * What POST /api/join was asked to join: { invite: HASH } or { chat: username | numeric id }.
 * Throws a 400 error when the body is not one of these.
 */
export function joinRequest(body) {
  const bad = () => httpErr(400, "Kênh hoặc link mời không hợp lệ");
  if (body?.invite !== undefined) {
    if (typeof body.invite !== "string") throw bad();
    const hash = inviteHash(body.invite) || (/^[\w-]{4,64}$/.test(body.invite) ? body.invite : null);
    if (!hash) throw bad();
    return { invite: hash };
  }
  if (typeof body?.chat !== "string") throw bad();
  const chat = body.chat.trim();
  if (!chat || chat.length > 200) throw bad();
  const hash = inviteHash(chat);
  if (hash) return { invite: hash };
  if (/^-?\d{1,20}$/.test(chat)) return { chat };
  const name = chat
    .replace(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\//i, "")
    .replace(/^@/, "")
    .split(/[/?#]/)[0];
  if (!/^[A-Za-z][\w]{3,31}$/.test(name)) throw bad();
  return { chat: name };
}

const JOIN_ERRORS = {
  CHANNELS_TOO_MUCH: "Tài khoản đã tham gia quá nhiều kênh và nhóm (giới hạn của Telegram). Hãy rời bớt rồi thử lại.",
  INVITE_HASH_EXPIRED: "Link mời đã hết hạn hoặc đã bị thu hồi.",
  INVITE_HASH_INVALID: "Link mời không hợp lệ.",
  INVITE_HASH_EMPTY: "Link mời không hợp lệ.",
  CHANNEL_PRIVATE: "Kênh hoặc nhóm này là riêng tư, hoặc bạn đã bị chặn khỏi đó.",
  CHANNEL_INVALID: "Không tìm thấy kênh hoặc nhóm này.",
  USERNAME_NOT_OCCUPIED: "Không tìm thấy kênh hoặc nhóm này.",
  USERNAME_INVALID: "Không tìm thấy kênh hoặc nhóm này.",
  USERS_TOO_MUCH: "Nhóm đã đủ số thành viên tối đa.",
  INVITE_REQUEST_SENT: "Đã gửi yêu cầu tham gia, chờ quản trị viên duyệt.",
};

/** A Telegram error while searching / joining as an HTTP error with a readable Vietnamese message. */
function telegramError(err) {
  if (err?.status) return err;
  const raw = String(err?.errorMessage || err?.message || err || "");
  const code = err?.errorMessage || /\b([A-Z][A-Z0-9_]{3,})\b/.exec(raw)?.[1] || "";
  if (err?.seconds || /FLOOD/.test(code)) return httpErr(429, authErrorText(err));
  if (JOIN_ERRORS[code]) return httpErr(400, JOIN_ERRORS[code]);
  if (/No user has|Cannot find any entity|Could not find the input entity|not found in your dialogs/i.test(raw))
    return httpErr(404, JOIN_ERRORS.USERNAME_NOT_OCCUPIED);
  return httpErr(502, raw || "Telegram không trả lời. Vui lòng thử lại.");
}
const errCode = (err) => String(err?.errorMessage || err?.message || "");

/** The chats of an invite link (contacts.Search does not find private chats). */
async function inviteResult(client, hash, onEntity) {
  let inv;
  try {
    inv = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
  } catch (err) {
    if (/INVITE_HASH/.test(errCode(err))) return []; // expired / invalid link: nothing found
    throw telegramError(err);
  }
  if (inv.chat) onEntity?.(inv.chat);
  if (inv instanceof Api.ChatInviteAlready)
    return [chatResult(inv.chat, { joined: true, invite: hash })].filter(Boolean);
  if (inv instanceof Api.ChatInvitePeek) return [chatResult(inv.chat, { joined: false, invite: hash })].filter(Boolean);
  const members = Number(inv.participantsCount);
  return [
    {
      id: null, // not known until joined
      title: inv.title || hash,
      username: null,
      type: inv.broadcast && !inv.megagroup ? "channel" : "group",
      members: members > 0 ? members : null,
      joined: false,
      ...(inv.verified && { verified: true }),
      ...(inv.requestNeeded && { request: true }),
      invite: hash,
    },
  ];
}

/** The `chat` of GET /api/chat-info (a dialog id, username or t.me link, as for /api/files); throws 400. */
export function chatInfoQuery(value) {
  const chat = String(value ?? "").trim();
  if (!chat || chat.length > 200) throw httpErr(400, "Thiếu kênh");
  return chat;
}

/**
 * A chat's header line, like Telegram's: how many subscribers (channel) / members (group). The exact
 * number needs the chat's full info (the one in search answers is often missing or rounded).
 */
export async function chatInfo(client, chat) {
  const entity = await resolveChat(client, chat);
  const row = chatResult(entity);
  if (!row) return { members: null };
  let members = row.members;
  if (entity instanceof Api.Channel) {
    const full = await client.invoke(new Api.channels.GetFullChannel({ channel: entity }));
    members = full.fullChat.participantsCount ?? members;
  } else if (entity instanceof Api.Chat) {
    const full = await client.invoke(new Api.messages.GetFullChat({ chatId: entity.id }));
    members = full.fullChat.participants?.participants?.length ?? members;
  }
  return { ...row, members: Number.isFinite(members) && members > 0 ? members : null };
}

/**
 * GET /api/search: public chats and people matching `q` (Telegram's global search), mine first.
 * `onEntity` gets each found chat's entity (its picture can then be downloaded: createAvatars().remember).
 * @param {any} client
 * @param {string} q
 * @param {{ limit?: number, onEntity?: (entity: any) => void }} [options]
 */
export async function searchChats(client, q, { limit = 25, onEntity } = {}) {
  const hash = inviteHash(q);
  if (hash) return { chats: await inviteResult(client, hash, onEntity) };
  let found;
  try {
    found = await client.invoke(new Api.contacts.Search({ q, limit }));
  } catch (err) {
    if (/SEARCH_QUERY_EMPTY|QUERY_TOO_SHORT/.test(errCode(err))) return { chats: [] };
    throw telegramError(err);
  }
  const byKey = new Map();
  for (const u of found.users || []) byKey.set(`u${u.id}`, u);
  for (const c of found.chats || []) byKey.set(`c${c.id}`, c);
  const peerKey = (p) =>
    p instanceof Api.PeerUser ? `u${p.userId}` : p instanceof Api.PeerChannel ? `c${p.channelId}` : `c${p.chatId}`;
  const seen = new Set();
  const chats = [];
  for (const peer of [...(found.myResults || []), ...(found.results || [])]) {
    const key = peerKey(peer);
    if (seen.has(key)) continue;
    seen.add(key);
    const row = chatResult(byKey.get(key));
    if (!row) continue;
    chats.push(row);
    onEntity?.(byKey.get(key));
  }
  return { chats };
}

// ---------- chat profile photos (the small ~160 px picture of Telegram's chat list) ----------

/** Telegram's id of a chat's current profile photo (changes with the picture), or null when it has none. */
export function photoId(entity) {
  const p = entity?.photo;
  if (!(p instanceof Api.UserProfilePhoto || p instanceof Api.ChatPhoto) || p.photoId == null) return null;
  return String(p.photoId);
}

/** Chats per GET /api/avatars request. */
export const AVATARS_MAX = 40;

/** The `ids` of GET /api/avatars: 1–40 chat ids (as the dialogs list writes them), deduplicated; throws 400. */
export function avatarIdsQuery(value) {
  const ids = [
    ...new Set(
      String(value ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  if (!ids.length || ids.length > AVATARS_MAX || !ids.every((id) => /^-?\d{1,20}$/.test(id)))
    throw httpErr(400, `Danh sách ảnh đại diện không hợp lệ (1–${AVATARS_MAX} id)`);
  return ids;
}

/**
 * The small profile photos of chats, as data: URLs, for GET /api/avatars. Entities come from the
 * dialogs list (kept, refreshed at most once a minute when an id is unknown) and from search answers.
 * Photos are cached per chat + photo id; at most `concurrency` downloads run at once; a chat without
 * a photo, or one that fails (FLOOD_WAIT, network…), is null — never an error for the whole batch.
 */
export function createAvatars(getClient, { concurrency = 3, cacheMax = 1000, refreshMs = 60_000 } = {}) {
  const entities = new Map(); // chat id -> entity
  const cache = new Map(); // "id:photoId" -> data URL | null (no picture), most recent last
  const inflight = new Map(); // "id:photoId" -> Promise
  let dialogsAt = 0;
  let dialogsLoading = null;
  let pausedUntil = 0; // after FLOOD_WAIT: no downloads until then
  let running = 0;
  const waiting = [];

  const remember = (entity) => {
    if (entity?.id != null) entities.set(markedId(entity), entity);
  };
  /** The dialogs list was fetched anyway (GET /api/dialogs): keep its entities. */
  const rememberDialogs = (dialogs) => {
    for (const d of dialogs || []) if (d.entity) entities.set(String(d.id), d.entity);
    dialogsAt = Date.now();
  };
  const loadDialogs = () => {
    if (dialogsLoading || Date.now() - dialogsAt < refreshMs) return dialogsLoading;
    dialogsLoading = Promise.resolve(getClient())
      .then((client) => client.getDialogs({}))
      .then(rememberDialogs)
      .catch(() => {
        dialogsAt = Date.now(); // don't retry on every request
      })
      .finally(() => (dialogsLoading = null));
    return dialogsLoading;
  };

  const limited = async (fn) => {
    if (running >= concurrency) await new Promise((resolve) => waiting.push(resolve));
    running++;
    try {
      return await fn();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };

  const download = async (entity) => {
    if (Date.now() < pausedUntil) return undefined;
    try {
      const client = await getClient(); // the client, or a promise of it (the mobile app)
      const buf = await client.downloadProfilePhoto(entity, { isBig: false });
      return buf?.length ? `data:image/jpeg;base64,${buf.toString("base64")}` : null;
    } catch (err) {
      if (err?.seconds) pausedUntil = Date.now() + err.seconds * 1000;
      return undefined; // not cached: tried again on a later request
    }
  };

  async function one(id) {
    const entity = entities.get(id);
    const pid = photoId(entity);
    if (!pid) return null;
    const key = `${id}:${pid}`;
    if (cache.has(key)) return cache.get(key);
    if (!inflight.has(key))
      inflight.set(
        key,
        limited(() => download(entity))
          .then((url) => {
            if (url !== undefined) {
              cache.set(key, url);
              if (cache.size > cacheMax) cache.delete(cache.keys().next().value);
            }
            return url ?? null;
          })
          .finally(() => inflight.delete(key)),
      );
    return inflight.get(key);
  }

  return {
    remember,
    rememberDialogs,
    /** { "<id>": "data:image/jpeg;base64,…" | null } for the given chat ids. */
    async get(ids) {
      if (ids.some((id) => !entities.has(id))) await loadDialogs();
      const urls = await Promise.all(ids.map((id) => one(id).catch(() => null)));
      return Object.fromEntries(ids.map((id, i) => [id, urls[i]]));
    },
    /** Signed out: forget the account's chats and pictures. */
    clear() {
      entities.clear();
      cache.clear();
      dialogsAt = 0;
      pausedUntil = 0;
    },
  };
}

// ---------- searching songs in every chat of the account (Telegram's "messages found") ----------

/** Songs per request to Telegram (its own maximum for a global search is 100). */
export const SONG_PAGE = 50;
/** Search lists kept in memory at once (each holds its songs' messages); the oldest is dropped first. */
export const SONG_SEARCHES_MAX = 20;

/** Scan key of a song search: never "<chat id>|<type>", "fav" or "recent". Case and spaces don't matter. */
export const songSearchKey = (q) => `search:${q.trim().toLowerCase().replace(/\s+/g, " ")}`;

/**
 * A new song search as a scan (see readPage), filled by songSearchPage. Searching the same words again
 * keeps the ids its songs had (`prev`), so a song playing from the earlier list still finds its file.
 * Message ids repeat across chats: the list numbers its songs itself (1, 2, …), like the favourites.
 */
export function songSearchScan(q, prev = null) {
  const key = songSearchKey(q);
  return {
    key,
    chat: key,
    type: "music",
    title: `Tìm: “${q}”`,
    query: q,
    search: true,
    items: new Map(),
    more: true,
    ids: prev?.key === key ? prev.ids : new Map(), // "<chat id>|<message id>" -> list id
    nextId: prev?.key === key ? prev.nextId : 1,
    offset: { rate: 0, peer: null, id: 0 }, // where Telegram's next page starts
  };
}

/**
 * The next page of a song search: messages.SearchGlobal with the music filter, newest first, in every
 * chat the account is in. Moves the scan's offset, clears scan.more at the end. Returns the new list ids.
 */
export async function songSearchPage(
  client,
  scan,
  { signal, stopped = () => new Error("stopped"), limit = SONG_PAGE } = {},
) {
  const page = [];
  // a page can hold only non-songs (voice notes are filtered out): read on a little, so the list grows
  for (let tries = 0; scan.more && !page.length && tries < 4; tries++) {
    if (signal?.aborted) throw stopped();
    let res;
    try {
      res = await client.invoke(
        new Api.messages.SearchGlobal({
          q: scan.query,
          filter: new Api.InputMessagesFilterMusic(),
          minDate: 0,
          maxDate: 0,
          offsetRate: scan.offset.rate,
          offsetPeer: scan.offset.peer || new Api.InputPeerEmpty(),
          offsetId: scan.offset.id,
          limit,
        }),
      );
    } catch (err) {
      if (/SEARCH_QUERY_EMPTY|QUERY_TOO_SHORT/.test(errCode(err))) {
        scan.more = false;
        break;
      }
      throw telegramError(err); // FLOOD_WAIT -> 429 "… đợi N phút …"
    }
    if (signal?.aborted) throw stopped();
    const messages = (res.messages || []).filter((m) => m instanceof Api.Message);
    const chats = new Map();
    for (const u of res.users || []) chats.set(`u${u.id}`, u);
    for (const c of res.chats || []) chats.set(`c${c.id}`, c);
    const peerOf = (p) =>
      p instanceof Api.PeerUser
        ? [`u${p.userId}`, String(p.userId)]
        : p instanceof Api.PeerChannel
          ? [`c${p.channelId}`, String(p.channelId)]
          : [`c${p?.chatId}`, String(p?.chatId)];
    const entities = new Map(); // what GramJS's own search hands to its messages (sender, chat…)
    for (const e of chats.values()) {
      try {
        entities.set(utils.getPeerId(e), e);
      } catch {}
    }
    for (const msg of messages) {
      const [peerKey, chatId] = peerOf(msg.peerId);
      const entity = chats.get(peerKey);
      try {
        msg._finishInit?.(client, entities, undefined);
      } catch {}
      if (mediaKind(msg) !== "audio") continue; // voice notes and other files are not songs
      const info = fileInfo(msg);
      if (!info) continue;
      const fav = `${chatId}|${msg.id}`;
      let id = scan.ids.get(fav);
      if (id === undefined) scan.ids.set(fav, (id = scan.nextId++));
      if (scan.items.has(id)) continue;
      scan.items.set(id, { msg, info, chatTitle: entity ? entityTitle(entity) : chatId, fav });
      page.push(id);
    }
    // where the next page starts: Telegram's next_rate, or the last message (with its chat) of this one
    const last = res.messages?.[res.messages.length - 1];
    const lastEntity = last && chats.get(peerOf(last.peerId)[0]);
    let peer = null;
    try {
      peer = lastEntity ? utils.getInputPeer(lastEntity) : null;
    } catch {}
    const slice = res instanceof Api.messages.MessagesSlice || res instanceof Api.messages.ChannelMessages;
    const seen = (scan.seen = (scan.seen || 0) + (res.messages?.length || 0));
    if (res.count && !scan.total) scan.total = res.count; // Telegram's "72 messages found"
    scan.more = !!(
      slice &&
      last &&
      peer &&
      (res.messages.length >= limit || res.nextRate) &&
      (!res.count || seen < res.count) &&
      !(last.id === scan.offset.id && (res.nextRate || last.date) === scan.offset.rate) // no progress: stop
    );
    scan.offset = { rate: res.nextRate || last?.date || 0, peer, id: last?.id || 0 };
  }
  return page;
}

/** POST /api/join: join a public chat (username / id) or an invite link. Users and bots cannot be joined. */
export async function joinChat(client, { chat, invite }) {
  const dialogOf = (r) =>
    r && { id: r.id, title: r.title, type: r.type === "bot" ? "user" : r.type, username: r.username };
  const fromUpdates = (updates) => dialogOf((updates?.chats || []).map((c) => chatResult(c)).find(Boolean));
  if (invite) {
    try {
      return {
        ok: true,
        dialog: fromUpdates(await client.invoke(new Api.messages.ImportChatInvite({ hash: invite }))),
      };
    } catch (err) {
      const code = errCode(err);
      if (/INVITE_REQUEST_SENT/.test(code)) return { ok: true, pending: true };
      if (!/USER_ALREADY_PARTICIPANT/.test(code)) throw telegramError(err);
      const [row] = await inviteResult(client, invite);
      return { ok: true, already: true, dialog: dialogOf(row) };
    }
  }
  let entity;
  try {
    if (/^-?\d+$/.test(chat)) {
      // a search result without a username: Telegram's answer to the search is in GramJS's entity cache
      entity = await client.getEntity(bigInt(chat)).catch(() => resolveChat(client, chat));
    } else entity = await resolveChat(client, chat);
  } catch (err) {
    throw telegramError(err);
  }
  if (entity instanceof Api.User) throw httpErr(400, "Không thể tham gia người dùng hoặc bot, hãy mở để nhắn tin.");
  if (!(entity instanceof Api.Channel)) {
    // basic groups have no public link: being in it is the only way to see it
    if (entity instanceof Api.Chat && !entity.left)
      return { ok: true, already: true, dialog: dialogOf(chatResult(entity)) };
    throw httpErr(400, JOIN_ERRORS.CHANNEL_INVALID);
  }
  try {
    const updates = await client.invoke(new Api.channels.JoinChannel({ channel: entity }));
    return { ok: true, dialog: fromUpdates(updates) || dialogOf(chatResult(entity, { joined: true })) };
  } catch (err) {
    const code = errCode(err);
    if (/INVITE_REQUEST_SENT/.test(code)) return { ok: true, pending: true };
    if (/USER_ALREADY_PARTICIPANT/.test(code)) return { ok: true, already: true, dialog: dialogOf(chatResult(entity)) };
    throw telegramError(err);
  }
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
// recent: the songs played lately, { id: "<chat id>|<message id>", at, … }, newest first · playlists:
// { id, name, songs: ["<chat id>|<message id>"…] in their order, at (made), up (last changed) }.
// Devices send operations, not whole copies, so two devices changing things at once lose nothing.

export const ACCOUNT_NAMES = ["settings", "history", "visibleChats", "favorites", "recent", "playlists"];
export const HISTORY_MAX = 2000;
export const RECENT_MAX = 100;
const LISTS = new Set(["history", "favorites", "recent", "playlists"]);
/** Lists of entries with an id (history, recent plays) and how many are kept. */
const ENTRY_MAX = { history: HISTORY_MAX, recent: RECENT_MAX };

/** What an item is when nothing was saved yet. */
export const accountEmpty = (name) => (LISTS.has(name) ? [] : null);

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Operations turning `before` into `after`. */
export function accountOps(name, before, after) {
  if (name === "playlists") {
    // one playlist at a time: two devices editing different playlists both keep their changes
    const b = new Map((before || []).map((p) => [p.id, p]));
    const aIds = new Set((after || []).map((p) => p.id));
    const removed = [...b.keys()].filter((id) => !aIds.has(id));
    const ops = removed.length ? [{ op: "remove", ids: removed }] : [];
    for (const p of [...(after || [])].reverse()) if (!same(b.get(p.id), p)) ops.push({ op: "put", playlist: p });
    return ops;
  }
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
    else if (name === "playlists" && o.op === "put")
      v = [o.playlist, ...v.filter((p) => p.id !== o.playlist.id)].slice(0, PLAYLISTS_MAX);
    else if (name === "playlists" && o.op === "remove") v = v.filter((p) => !o.ids.includes(p.id));
    else if (name in ENTRY_MAX && o.op === "add") {
      const ids = new Set(o.entries.map((h) => h.id));
      v = [...o.entries, ...v.filter((h) => !ids.has(h.id))].slice(0, ENTRY_MAX[name]);
    } else if (name in ENTRY_MAX && o.op === "remove") v = v.filter((h) => !o.ids.includes(h.id));
  }
  return v;
}

// ---------- playlists (like Zing MP3's: made by the user, songs from any chat, in the order chosen) ----------

export const PLAYLISTS_MAX = 200;
export const PLAYLIST_SONGS_MAX = 1000;
export const PLAYLIST_NAME_MAX = 80;

// shared playlists (cloud/share.js): a link lives 1, 7 or 30 days, holds a whole playlist, songs of up to 100 MB.
// Songs go through the Vercel function in pieces (its requests and answers are 4.5 MB at most).
export const SHARE_DAYS = [1, 7, 30];
export const SHARE_SONGS_MAX = PLAYLIST_SONGS_MAX;
export const SHARE_FILE_MAX = 100 * 1024 * 1024;
export const SHARE_CHUNK = 3 * 1024 * 1024;
// a link may be extended, up to this many days after it was made (the R2 lifecycle rule keeps songs 91 days)
export const SHARE_MAX_DAYS = 90;

/** A new playlist id: no two devices pick the same one. */
export const newPlaylistId = () =>
  Date.now().toString(36) +
  Math.floor(Math.random() * 36 ** 6)
    .toString(36)
    .padStart(6, "0");

/** The newest first (made last). */
export const sortPlaylists = (list) => [...list].sort((a, b) => (b.at || 0) - (a.at || 0));

/** A playlist as stored, cleaned; null when it is not one. */
export function cleanPlaylist(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const id = typeof p.id === "string" && /^[a-z0-9]{4,24}$/.test(p.id) ? p.id : null;
  const name = typeof p.name === "string" ? p.name.trim().slice(0, PLAYLIST_NAME_MAX) : "";
  if (!id || !name || !Array.isArray(p.songs) || p.songs.length > PLAYLIST_SONGS_MAX) return null;
  if (!p.songs.every(isFavoriteId)) return null;
  const at = Number.isSafeInteger(p.at) ? p.at : 0;
  const up = Number.isSafeInteger(p.up) ? p.up : at;
  return { id, name, songs: [...new Set(p.songs)], at, up };
}

/**
 * A change to the account's playlists, the same everywhere (local server, browser version, app). Returns the new
 * list (and the id of a playlist made); throws an Error with a message to show when the change is not valid.
 *   { op: "create", name, songs? }   { op: "rename", id, name }   { op: "delete", id }
 *   { op: "add", id, songs }  (to the end, the ones already there stay where they are)
 *   { op: "remove", id, songs }   { op: "order", id, songs }  (the same songs in a new order)
 */
export function editPlaylists(list, change, now = Date.now()) {
  const playlists = list || [];
  const name = typeof change?.name === "string" ? change.name.trim().slice(0, PLAYLIST_NAME_MAX) : "";
  // another playlist already has this name (letters compared without case: "Chill" = "chill")
  const taken = (except) =>
    playlists.some((x) => x.id !== except && x.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase());
  const songs = Array.isArray(change?.songs) ? change.songs.filter(isFavoriteId) : [];
  if (change?.op === "create") {
    if (!name) throw new Error("Hãy đặt tên cho playlist");
    if (taken(null)) throw new Error("Đã có playlist trùng tên");
    if (playlists.length >= PLAYLISTS_MAX) throw new Error(`Tối đa ${PLAYLISTS_MAX} playlist`);
    const p = { id: newPlaylistId(), name, songs: [...new Set(songs)].slice(0, PLAYLIST_SONGS_MAX), at: now, up: now };
    return { playlists: [p, ...playlists], id: p.id };
  }
  const p = playlists.find((x) => x.id === change?.id);
  if (!p) throw new Error("Không tìm thấy playlist");
  const put = (q) => ({ playlists: playlists.map((x) => (x.id === p.id ? { ...q, up: now } : x)), id: p.id });
  switch (change.op) {
    case "rename":
      if (!name) throw new Error("Hãy đặt tên cho playlist");
      if (taken(p.id)) throw new Error("Đã có playlist trùng tên");
      return put({ ...p, name });
    case "delete":
      return { playlists: playlists.filter((x) => x.id !== p.id), id: p.id };
    case "add": {
      const more = [...new Set(songs)].filter((s) => !p.songs.includes(s));
      if (p.songs.length + more.length > PLAYLIST_SONGS_MAX)
        throw new Error(`Một playlist có tối đa ${PLAYLIST_SONGS_MAX} bài`);
      return put({ ...p, songs: [...p.songs, ...more] });
    }
    case "remove":
      return put({ ...p, songs: p.songs.filter((s) => !songs.includes(s)) });
    case "order":
      // only the same songs, each once (a device that missed a change sends an order without it: kept at the end)
      if (songs.some((s) => !p.songs.includes(s))) throw new Error("Thứ tự không khớp playlist");
      return put({ ...p, songs: [...new Set([...songs, ...p.songs])] });
    default:
      throw new Error("Thao tác không hợp lệ");
  }
}

// ---------- songs dragged to a new place in a chat / the favourites (for as long as the page is open) ----------

/**
 * A list (in its own order: the newest first) put in the order its songs were dragged to. The songs not in it keep
 * their place around it: the ones before all of it (posted since) on top, the ones after it (older pages read
 * later) at the end, the ones between right after the song they followed. keyOf: a file's "<chat id>|<message id>".
 */
export function orderFiles(files, songs, keyOf) {
  if (!songs?.length) return files;
  const rank = new Map(songs.map((k, i) => [k, i]));
  const ranked = files.map((f) => rank.get(keyOf(f)));
  const first = ranked.findIndex((r) => r !== undefined);
  if (first < 0) return files;
  const last = ranked.findLastIndex((r) => r !== undefined);
  const top = [];
  const bottom = [];
  const after = new Map(); // a song in the order -> the ones that followed it
  let prev = null;
  files.forEach((f, i) => {
    if (ranked[i] !== undefined) prev = f;
    else if (i < first) top.push(f);
    else if (i > last) bottom.push(f);
    else after.set(prev, [...(after.get(prev) || []), f]);
  });
  const known = files
    .filter((_, i) => ranked[i] !== undefined)
    .sort((a, b) => rank.get(keyOf(a)) - rank.get(keyOf(b)));
  return [...top, ...known.flatMap((f) => [f, ...(after.get(f) || [])]), ...bottom];
}

/** A history id that two devices will not both pick (the old ones were 1, 2, 3… on every device). */
export const newHistoryId = () => Date.now() * 1000 + Math.floor(Math.random() * 1000);

/**
 * First time a device joins (or after being offline): one copy out of this device's and MongoDB's,
 * losing nothing. Lists are united; for settings / visible chats MongoDB's choice wins when it has one.
 */
export function mergeAccount(name, mine, theirs) {
  if (name === "favorites") return [...new Set([...(theirs || []), ...(mine || [])])];
  if (name === "playlists") {
    // the same playlist changed on two devices: the one changed last
    const byId = new Map();
    for (const p of [...(theirs || []), ...(mine || [])])
      if (!byId.has(p.id) || (p.up || 0) > (byId.get(p.id).up || 0)) byId.set(p.id, p);
    return sortPlaylists([...byId.values()]).slice(0, PLAYLISTS_MAX);
  }
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
