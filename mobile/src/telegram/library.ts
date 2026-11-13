// Chats and their files, read the same way as the web version (core.js: dialogType, fileInfo, mediaKind,
// readPage — pages of 500 files, newest first), and the favourites gathered from every chat.
import { Api } from "telegram";

import {
  FILTERS,
  PAGE_SIZE,
  dialogType,
  entityTitle,
  fetchPostStats,
  fileInfo,
  fitsType,
  mediaKind,
  photoId,
  postStats,
  readPage,
} from "../../../core.js";
import { rememberDialogs } from "./avatars";
import { songKey } from "./ids";
import { MOCK, MOCK_CHATS, MOCK_SONGS } from "../mock";
import { getClient } from "./client";

export type ChatType = "channel" | "group" | "user";
export type Chat = {
  id: string;
  rawId: string;
  title: string;
  type: ChatType;
  username: string | null;
  photo?: string | null; // id of the chat's Telegram picture (core.js photoId), null without one
};
export type FileKind = "photo" | "image" | "video" | "audio" | "voice" | "document";
export type FileType = keyof typeof FILTERS; // all | music | video | photo | document | voice
export type Song = {
  id: number; // message id
  key: string; // "<chat id>|<message id>" (favourites, recent plays)
  chatId: string;
  chat?: string; // chat title (favourites list)
  name: string;
  title?: string;
  performer?: string;
  duration?: number;
  size: number;
  date: number;
  kind: FileKind | null;
  views?: number; // a channel post's, as Telegram shows them under it (core.js postStats)
  reactions?: { emoji: string; count: number }[];
};

/** A change pushed by Telegram, as core.js readUpdate reads it (chat: the bare id). */
export type LiveChange = {
  op: "new" | "edit" | "delete" | "reactions" | "views" | "chats";
  chat?: string | null;
  msg?: Api.Message;
  ids?: number[];
  id?: number;
  reactions?: Api.MessageReactions;
  views?: number;
};

const entities = new Map<string, Api.TypeEntityLike>();
let chatsCache: Chat[] = [];
// chats found by the global search (not joined, or joined a moment ago): their title, and their username to
// find them again once GramJS forgot them
const found = new Map<string, Chat>();
const rawOf = (id: string) => id.replace(/^-(100)?/, "");
export const chatById = (id: string) =>
  chatsCache.find((c) => c.id === id || c.rawId === id) ??
  found.get(id) ??
  [...found.values()].find((c) => c.rawId === id);

/** Remember a chat the search found (opened before / without joining it). */
export function rememberChat(c: { id: string; title: string; type: ChatType; username: string | null }) {
  found.set(c.id, { ...c, rawId: rawOf(c.id) });
}

export async function listChats(): Promise<Chat[]> {
  if (MOCK) return (chatsCache = MOCK_CHATS);
  const client = await getClient();
  const dialogs = await client.getDialogs({});
  rememberDialogs(dialogs);
  chatsCache = dialogs.map((d) => {
    const id = String(d.id);
    if (d.entity) entities.set(id, d.entity);
    return {
      id,
      rawId: String(d.entity?.id ?? id).replace(/^-(100)?/, ""),
      title: d.title || entityTitle(d.entity),
      type: dialogType(d),
      username: (d.entity as { username?: string } | undefined)?.username ?? null,
      photo: photoId(d.entity),
    };
  });
  return chatsCache;
}

export async function entityOf(chatId: string) {
  const client = await getClient();
  const known = entities.get(chatId);
  if (known) return known;
  try {
    return await client.getEntity(chatId);
  } catch (err) {
    // a public chat from the search: GramJS knows its id only while its answer is in memory, the username always
    const username = chatById(chatId)?.username;
    if (!username) throw err;
    return client.getEntity(username);
  }
}

export function toSong(msg: Api.Message, chatId: string, chat?: string): Song | null {
  const info = fileInfo(msg) as Omit<Song, "id" | "key" | "chatId" | "date" | "kind"> | null;
  if (!info) return null;
  return {
    id: msg.id,
    key: songKey(chatId, msg.id),
    chatId,
    chat,
    date: msg.date ?? 0,
    kind: mediaKind(msg) as FileKind | null,
    ...info,
    ...postStats(msg),
  };
}

/** The message a change is about, made as it is now (reactions / views taken in, or the edited one). */
function changed(msg: Api.Message, c: LiveChange): Api.Message {
  if (c.op === "edit" && c.msg) return c.msg;
  if (c.op === "reactions") msg.reactions = c.reactions;
  if (c.op === "views" && c.views !== undefined) msg.views = c.views;
  return msg;
}

export interface FileList {
  kind: "chat" | "fav" | "recent" | "search" | "playlist"; // a chat's files, "Bài hát yêu thích", "Phát gần đây", "Tìm: “…”", a playlist
  playlistId?: string; // a playlist: its id (what plays follows it as it is now)
  chatId?: string; // a chat's files: its id
  songs: Song[];
  more: boolean;
  message(id: number): Api.Message | undefined;
  next(onProgress?: (count: number) => void): Promise<void>;
  /** A change Telegram pushed, taken in: whether this list changed (its songs are a new array then). */
  apply(c: LiveChange): boolean;
  /** The reactions and views of these songs asked of Telegram again (taken into their songs). */
  refreshStats(keys: string[]): Promise<void>;
}

/** One chat's files of one type, page by page (`next()` reads 500 more). */
export class SongScan implements FileList {
  kind = "chat" as const;
  songs: Song[] = [];
  more = true;
  private scan = { more: true, cursor: 0, items: new Map<number, { msg: Api.Message }>() };
  private reading: Promise<void> | null = null;

  constructor(
    readonly chatId: string,
    readonly type: FileType = "all",
    readonly title?: string, // the chat's title, shown under the song in the player
  ) {}

  message(id: number) {
    return this.scan.items.get(id)?.msg;
  }

  apply(c: LiveChange) {
    if (MOCK || c.op === "chats") return false;
    const own = String(this.chatId).replace(/^-(100)?/, "");
    if (c.op === "new") {
      const msg = c.msg!;
      if (c.chat !== own || this.scan.items.has(msg.id) || !fitsType(this.type, msg)) return false;
      const song = toSong(msg, this.chatId, this.title ?? chatById(this.chatId)?.title);
      if (!song) return false;
      this.scan.items.set(msg.id, { msg });
      this.songs = [song, ...this.songs]; // newest first, like the chat
      return true;
    }
    // a deletion that does not say its chat is a group's or a person's: not a channel's list
    const mine = c.chat == null ? chatById(this.chatId)?.type !== "channel" : c.chat === own;
    const ids = new Set((c.ids ?? [c.id ?? c.msg?.id]).filter((id) => mine && this.scan.items.has(id!)));
    if (!ids.size) return false;
    if (c.op === "delete") {
      for (const id of ids) this.scan.items.delete(id!);
      this.songs = this.songs.filter((s) => !ids.has(s.id));
      return true;
    }
    this.songs = this.songs.map((s) => {
      if (!ids.has(s.id)) return s;
      const msg = changed(this.scan.items.get(s.id)!.msg, c);
      this.scan.items.set(s.id, { msg });
      return toSong(msg, this.chatId, s.chat) ?? s;
    });
    return true;
  }

  async refreshStats(keys: string[]) {
    if (MOCK) return;
    const ids = this.songs.filter((s) => keys.includes(s.key)).map((s) => s.id);
    if (!ids.length) return;
    const stats = await fetchPostStats(await getClient(), await entityOf(this.chatId), ids);
    this.songs = this.songs.map((s) => {
      const st = stats.get(s.id);
      const msg = this.scan.items.get(s.id)?.msg;
      if (!st || !msg) return s;
      Object.assign(msg, st);
      return toSong(msg, this.chatId, s.chat) ?? s;
    });
  }

  next(onProgress?: (count: number) => void) {
    if (MOCK) {
      this.songs = MOCK_SONGS.map((s) => ({ ...s, chat: this.title }));
      return Promise.resolve();
    }
    this.reading ??= (async () => {
      const client = await getClient();
      const entity = await entityOf(this.chatId);
      const Filter = FILTERS[this.type];
      const ids: number[] = await readPage(
        this.scan,
        (offsetId: number) => client.iterMessages(entity, { filter: Filter ? new Filter() : undefined, offsetId }),
        { pageSize: PAGE_SIZE, onProgress } as Parameters<typeof readPage>[2],
      );
      for (const id of ids) {
        const s = toSong(this.scan.items.get(id)!.msg, this.chatId, this.title ?? chatById(this.chatId)?.title);
        if (s) this.songs.push(s);
      }
      this.more = this.scan.more;
    })().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }
}

/**
 * Files of any chats by their keys, in that order: "Bài hát yêu thích" (newest heart first), "Phát gần đây", and a
 * playlist (in its own order).
 */
export class FavoritesScan implements FileList {
  songs: Song[] = [];
  more = true;
  private messages = new Map<string, Api.Message>();

  constructor(
    readonly keys: string[],
    readonly kind: "fav" | "recent" | "playlist" = "fav",
    readonly playlistId?: string,
  ) {}

  message(id: number) {
    const song = this.songs.find((s) => s.id === id);
    return song ? this.messages.get(song.key) : undefined;
  }
  messageOf(song: Song) {
    return this.messages.get(song.key);
  }

  apply(c: LiveChange) {
    // new posts do not join these lists; the songs of them that changed follow
    if (MOCK || c.op === "new" || c.op === "chats" || c.chat == null) return false;
    const keys = new Set((c.ids ?? [c.id ?? c.msg?.id]).map((id) => `${c.chat}|${id}`));
    if (!this.songs.some((s) => keys.has(s.key))) return false;
    if (c.op === "delete") {
      this.songs = this.songs.filter((s) => !keys.has(s.key));
      return true;
    }
    this.songs = this.songs.map((s) => {
      const msg = keys.has(s.key) && this.messages.get(s.key);
      if (!msg) return s;
      const now = changed(msg, c);
      this.messages.set(s.key, now);
      return toSong(now, s.chatId, s.chat) ?? s;
    });
    return true;
  }

  async refreshStats(keys: string[]) {
    if (MOCK) return;
    const client = await getClient();
    const byChat = new Map<string, Song[]>();
    for (const s of this.songs) if (keys.includes(s.key)) byChat.set(s.chatId, [...(byChat.get(s.chatId) ?? []), s]);
    for (const [chatId, songs] of byChat) {
      const stats = await fetchPostStats(
        client,
        await entityOf(chatId),
        songs.map((s) => s.id),
      );
      for (const s of songs) {
        const msg = this.messages.get(s.key);
        if (msg && stats.get(s.id)) Object.assign(msg, stats.get(s.id));
      }
    }
    this.songs = this.songs.map((s) => {
      const msg = byChat.has(s.chatId) && keys.includes(s.key) ? this.messages.get(s.key) : undefined;
      return msg ? (toSong(msg, s.chatId, s.chat) ?? s) : s;
    });
  }

  async next() {
    if (!this.more) return;
    if (MOCK) {
      this.songs = this.keys
        .map((k) => MOCK_SONGS.find((s) => s.key === k))
        .filter((s): s is Song => !!s)
        .map((s) => ({ ...s, chat: "mixtape house lak 420" }));
      this.more = false;
      return;
    }
    const client = await getClient();
    if (!chatsCache.length) await listChats();
    const byChat = new Map<string, number[]>();
    for (const key of this.keys) {
      const [raw, msg] = key.split("|");
      const list = byChat.get(raw) ?? [];
      list.push(Number(msg));
      byChat.set(raw, list);
    }
    const found = new Map<string, Song>();
    for (const [raw, ids] of byChat) {
      const chat = chatById(raw);
      if (!chat) continue; // a chat this account left
      try {
        const msgs = await client.getMessages(await entityOf(chat.id), { ids });
        for (const m of msgs) {
          if (!m) continue;
          const s = toSong(m, chat.id, chat.title);
          if (!s) continue;
          found.set(s.key, s);
          this.messages.set(s.key, m);
        }
      } catch {}
    }
    this.songs = this.keys.map((k) => found.get(k)).filter((s): s is Song => !!s);
    this.more = false;
  }
}

/** The id of a list's order of its own (core.js orders): "fav", a chat's own id; null for the other lists. */
export function orderIdOf(list: FileList) {
  if (list.kind === "fav") return "fav";
  return list.kind === "chat" && list.chatId ? songKey(list.chatId, 0).split("|")[0] : null;
}
