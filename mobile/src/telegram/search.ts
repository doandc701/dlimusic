// Telegram's search box, like the web version's (core.js: searchChats, joinChat, songSearchScan / songSearchPage):
// public chats and people found by Telegram, joining them, a chat's subscriber / member count, and the songs
// of every chat of the account as a list the player can play ("Tìm: “…”").
import { Api, utils } from "telegram";

import {
  SONG_SEARCHES_MAX,
  chatResult,
  inviteHash,
  joinChat,
  joinRequest,
  resolveChat,
  searchChats,
  songSearchKey,
  songSearchPage,
  songSearchScan,
} from "../../../core.js";
import { MOCK, MOCK_SONGS } from "../mock";
import { getClient } from "./client";
import { songKey } from "./ids";
import { entityOf, rememberChat, type Chat, type ChatType, type FileList, type Song } from "./library";

/** A chat found by Telegram's global search (core.js chatResult). */
export type FoundChat = {
  id: string | null; // null: a private chat of an invite link, not known until joined
  title: string;
  username: string | null;
  type: ChatType | "bot";
  members: number | null;
  joined: boolean;
  verified?: boolean;
  invite?: string; // the invite link's hash
  request?: boolean; // an admin must approve
};

/** What the search box asks Telegram: 2–64 characters (core.js searchQuery allows 1–64). */
export const SEARCH_MIN = 2;
export const SEARCH_MAX = 64;

/** A link or @username the search box opens on Enter (t.me/…, telegram.me/…, tg://…, @name). */
export const isChatLink = (text: string) =>
  /^(https?:\/\/)?(t|telegram)\.me\/\S+|^tg:\/\/\S+|^@[a-z]\w{3,31}$/i.test(text.trim());

export { inviteHash };

/** Public chats and people matching `q`, the account's own first (or the chat of an invite link). */
export async function searchGlobal(q: string): Promise<FoundChat[]> {
  if (MOCK) return [];
  const client = await getClient();
  const { chats } = (await searchChats(client, q)) as { chats: FoundChat[] };
  return chats;
}

const asChat = (r: { id: string; title: string; type: string; username: string | null }): Chat => {
  const c = {
    id: r.id,
    title: r.title,
    type: (r.type === "bot" ? "user" : r.type) as ChatType,
    username: r.username ?? null,
  };
  rememberChat(c);
  return { ...c, rawId: r.id.replace(/^-(100)?/, "") };
};

/** A found chat as one the chat screen can open (remembered, so its title / username are known there). */
export const openableChat = (r: FoundChat): Chat | null => (r.id ? asChat({ ...r, id: r.id }) : null);

/**
 * Join a found channel / group (or an invite link's chat). `pending`: an admin must approve. Throws an Error
 * with a Vietnamese message (core.js JOIN_ERRORS), shown through t().
 */
export async function joinFound(r: FoundChat): Promise<{ pending?: boolean; chat: Chat | null }> {
  const client = await getClient();
  const res = (await joinChat(
    client,
    (r.invite ? { invite: r.invite } : { chat: r.username || r.id || "" }) as never,
  )) as {
    pending?: boolean;
    dialog?: { id: string; title: string; type: string; username: string | null } | null;
  };
  if (res.pending) return { pending: true, chat: null };
  const d = res.dialog?.id
    ? res.dialog
    : r.id
      ? { id: r.id, title: r.title, type: r.type, username: r.username }
      : null;
  return { chat: d ? asChat(d) : null };
}

/**
 * The chat a link / @username names (t.me/name, t.me/name/123, telegram.me/name, tg://resolve?domain=name,
 * @name), to open it. Invite links are not opened here: the search shows their chat with "Tham gia".
 */
export async function chatOfLink(text: string): Promise<Chat> {
  const domain = /^tg:\/\/resolve\?(?:.*&)?domain=([A-Za-z]\w{3,31})/i.exec(text.trim())?.[1];
  const { chat } = joinRequest({ chat: domain ?? text }) as { chat?: string; invite?: string };
  if (!chat) throw new Error("Kênh hoặc link mời không hợp lệ");
  const client = await getClient();
  let entity;
  try {
    entity = await resolveChat(client, chat);
  } catch {
    throw new Error("Không tìm thấy kênh hoặc nhóm này.");
  }
  const row = chatResult(entity) as FoundChat | null;
  if (!row?.id) throw new Error("Không tìm thấy kênh hoặc nhóm này.");
  return asChat({ ...row, id: row.id });
}

// ---------- the line under a chat's title: its subscribers / members ----------

type Members = { members: number | null; type: string; at: number };
const membersCache = new Map<string, Members>();
const MEMBERS_TTL = 10 * 60_000;

/** The count known (asked less than 10 minutes ago), or undefined. */
export function knownMembers(chatId: string) {
  const m = membersCache.get(chatId);
  return m && Date.now() - m.at < MEMBERS_TTL ? m : undefined;
}

/**
 * How many subscribers (channel) / members (group) a chat has, exactly (like core.js chatInfo, but with the
 * entity the app already has: chatInfo would read every dialog again for a numeric id).
 */
export async function chatMembers(chatId: string): Promise<Members> {
  const known = knownMembers(chatId);
  if (known) return known;
  const client = await getClient();
  const entity = await entityOf(chatId);
  const row = chatResult(entity) as FoundChat | null;
  let members = row?.members ?? null;
  if (entity instanceof Api.Channel) {
    const full = (await client.invoke(new Api.channels.GetFullChannel({ channel: entity }))) as Api.messages.ChatFull;
    members = (full.fullChat as Api.ChannelFull).participantsCount ?? members;
  } else if (entity instanceof Api.Chat) {
    const full = (await client.invoke(new Api.messages.GetFullChat({ chatId: entity.id }))) as Api.messages.ChatFull;
    const parts = (full.fullChat as Api.ChatFull).participants;
    members = (parts instanceof Api.ChatParticipants ? parts.participants.length : null) ?? members;
  }
  const m = {
    members: members != null && Number.isFinite(members) && members > 0 ? members : null,
    type: row?.type ?? "user",
    at: Date.now(),
  };
  membersCache.set(chatId, m);
  return m;
}

// ---------- songs of every chat (Telegram's "messages found") ----------

type SearchItem = { msg: Api.Message; info: Omit<Song, "id" | "key" | "chatId" | "date" | "kind">; chatTitle: string };
type SearchScan = { key: string; items: Map<number, SearchItem>; more: boolean; total?: number };

/** The songs matching some words in every chat of the account, 50 per page, newest first. */
export class SongSearch implements FileList {
  kind = "search" as const;
  songs: Song[] = [];
  more = true;
  readonly scan: SearchScan;
  private reading: Promise<void> | null = null;
  private ctrl = new AbortController();

  constructor(
    readonly query: string,
    prev?: SongSearch,
  ) {
    this.scan = songSearchScan(query, (prev?.scan as never) ?? null) as SearchScan;
  }

  /** How many songs Telegram counted, if it said. */
  get total() {
    return this.scan.total;
  }

  message(id: number) {
    return this.scan.items.get(id)?.msg;
  }

  /** Stop the page being read (the search box changed). */
  abort() {
    this.ctrl.abort();
    this.ctrl = new AbortController(); // the list stays usable: the next page starts where this one would have
  }

  next() {
    if (MOCK) {
      const q = this.query.toLowerCase();
      this.songs = MOCK_SONGS.filter((s) =>
        `${s.title ?? ""} ${s.performer ?? ""} ${s.name}`.toLowerCase().includes(q),
      );
      this.more = false;
      return Promise.resolve();
    }
    if (!this.more) return Promise.resolve();
    this.reading ??= (async () => {
      const client = await getClient();
      const ids = (await songSearchPage(client, this.scan as never, { signal: this.ctrl.signal } as never)) as number[];
      for (const id of ids) {
        const it = this.scan.items.get(id)!;
        let chatId: string;
        try {
          chatId = String(utils.getPeerId(it.msg.peerId));
        } catch {
          continue;
        }
        this.songs.push({
          id,
          key: songKey(chatId, it.msg.id),
          chatId,
          chat: it.chatTitle,
          date: it.msg.date ?? 0,
          kind: "audio",
          ...it.info,
        });
      }
      this.more = this.scan.more;
    })().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }
}

// the search lists in memory: the chat list's results and "Xem tất cả" are the same list (no second search)
const searches = new Map<string, SongSearch>();

/** The list of a search: the one in memory, or (`fresh`, or none yet) a new one. */
export function songSearch(q: string, { fresh = false } = {}) {
  const key = songSearchKey(q) as string;
  const known = searches.get(key);
  if (known && !fresh) return known;
  const list = new SongSearch(q.trim(), known);
  searches.delete(key);
  searches.set(key, list);
  while (searches.size > SONG_SEARCHES_MAX) searches.delete(searches.keys().next().value!);
  return list;
}
