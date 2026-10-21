// The chats' Telegram pictures (the small ~160 px profile photo of Telegram's chat list), like the web's
// GET /api/avatars (core.js createAvatars: ~3 downloads at a time, a failure = no picture for that chat).
// Asked only for the avatars on screen (FlashList renders rows on demand), ~150 ms of them at once, kept in
// memory and in AsyncStorage (one entry per picture, the newest AVATARS_KEPT) so the list shows them at once
// on the next launch. Keyed by chat id + photo id: a chat that changes its picture gets the new one.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useSyncExternalStore } from "react";

import { AVATARS_MAX, createAvatars } from "../../../core.js";
import { MOCK, MOCK_PHOTOS } from "../mock";
import { getClient } from "./client";

type Entity = object;
const loader = createAvatars(getClient) as {
  remember: (entity: Entity) => void;
  rememberDialogs: (dialogs: { id?: unknown; entity?: Entity }[]) => void;
  get: (ids: string[]) => Promise<Record<string, string | null>>;
  clear: () => void;
};

/** The dialogs list was read anyway: its chats' pictures can be downloaded without asking for it again. */
export const rememberDialogs = loader.rememberDialogs;
/** A chat from a search answer (not in the dialogs list). */
export const rememberEntity = loader.remember;

const INDEX_KEY = "avatars:index"; // ["id:photoId", …], oldest first
const entryKey = (k: string) => `avatar:${k}`;
const AVATARS_KEPT = 200; // ~10 KB each

const photos = new Map<string, string>(); // "id:photoId" -> data: URI
const missing = new Map<string, number>(); // "id:photoId" -> when it had no picture (asked again later)
const RETRY_MS = 5 * 60_000;
const pending = new Map<string, string>(); // "id:photoId" -> id, waiting for the next batch
const asked = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let index: string[] = [];
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

// what the last launches kept
const loaded = AsyncStorage.getItem(INDEX_KEY)
  .then(async (raw) => {
    const keys: string[] = JSON.parse(raw || "[]");
    if (!Array.isArray(keys) || !keys.length) return;
    const rows = await AsyncStorage.multiGet(keys.map(entryKey));
    rows.forEach(([, url], i) => url?.startsWith("data:image/") && photos.set(keys[i], url));
    index = keys.filter((k) => photos.has(k));
    changed();
  })
  .catch(() => {});

function persist(k: string, url: string) {
  const id = k.split(":")[0];
  const drop = index.filter((o) => o !== k && o.split(":")[0] === id); // a chat that changed its picture: the old one goes
  index = [...index.filter((o) => !drop.includes(o)), k];
  while (index.length > AVATARS_KEPT) drop.push(index.shift()!);
  AsyncStorage.setItem(entryKey(k), url)
    .then(() => AsyncStorage.setItem(INDEX_KEY, JSON.stringify(index)))
    .then(() => (drop.length ? AsyncStorage.multiRemove(drop.map(entryKey)) : undefined))
    .catch(() => {});
}

async function flush() {
  timer = null;
  await loaded; // what an earlier launch kept is not asked again
  const batch = [...pending].slice(0, AVATARS_MAX);
  batch.forEach(([k]) => pending.delete(k));
  if (pending.size) timer = setTimeout(flush, 50);
  const todo = batch.filter(([k]) => !photos.has(k));
  let got: Record<string, string | null> = {};
  if (todo.length)
    try {
      got = MOCK
        ? Object.fromEntries(todo.map(([, id]) => [id, MOCK_PHOTOS[id] ?? null]))
        : await loader.get(todo.map(([, id]) => id));
    } catch {
      // offline / signed out: the letters stay
    }
  for (const [k, id] of batch) {
    asked.delete(k);
    const url = got[id];
    if (typeof url === "string" && url.startsWith("data:image/")) {
      photos.set(k, url);
      persist(k, url);
    } else if (!photos.has(k)) missing.set(k, Date.now());
  }
  changed();
}

function want(id: string, photo: string) {
  const k = `${id}:${photo}`;
  if (photos.has(k) || asked.has(k) || Date.now() - (missing.get(k) ?? 0) < RETRY_MS) return;
  asked.add(k);
  pending.set(k, id);
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, 150);
}

/** A picture could not be shown: the letter, and asked again later. */
export function avatarFailed(id: string, photo: string) {
  const k = `${id}:${photo}`;
  photos.delete(k);
  missing.set(k, Date.now());
  changed();
}

/** The data: URI of chat `id`'s picture `photo` (asked for when not known yet), or null. */
export function useAvatar(id: string, photo: string | null | undefined) {
  const ok = !!photo && /^-?\d{1,20}$/.test(id);
  // the picture itself is the snapshot (the React Compiler would keep a value read from the map otherwise)
  const uri = useSyncExternalStore(subscribe, () => (ok ? (photos.get(`${id}:${photo}`) ?? null) : null));
  useEffect(() => {
    if (ok) want(id, photo!);
  }, [ok, id, photo]);
  return uri;
}

/** Signed out: the next account's chats are not this one's. */
export function forgetAvatars() {
  loader.clear();
  photos.clear();
  missing.clear();
  pending.clear();
  const keys = index.map(entryKey);
  index = [];
  AsyncStorage.multiRemove([INDEX_KEY, ...keys]).catch(() => {});
  changed();
}
