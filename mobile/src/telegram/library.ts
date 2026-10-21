// Chats and their files, read the same way as the web version (core.js: dialogType, fileInfo, mediaKind,
// readPage — pages of 500 files, newest first), and the favourites gathered from every chat.
import { Api } from "telegram";

import { FILTERS, PAGE_SIZE, dialogType, entityTitle, fileInfo, mediaKind, photoId, readPage } from "../../../core.js";
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
  };
}

export interface FileList {
  kind: "chat" | "fav" | "recent" | "search"; // a chat's files, "Bài hát yêu thích", "Phát gần đây", "Tìm: “…”"
  songs: Song[];
  more: boolean;
  message(id: number): Api.Message | undefined;
  next(onProgress?: (count: number) => void): Promise<void>;
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

/** Files of any chats by their keys, in that order: "Bài hát yêu thích" (newest heart first) and "Phát gần đây". */
export class FavoritesScan implements FileList {
  songs: Song[] = [];
  more = true;
  private messages = new Map<string, Api.Message>();

  constructor(
    readonly keys: string[],
    readonly kind: "fav" | "recent" = "fav",
  ) {}

  message(id: number) {
    const song = this.songs.find((s) => s.id === id);
    return song ? this.messages.get(song.key) : undefined;
  }
  messageOf(song: Song) {
    return this.messages.get(song.key);
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
