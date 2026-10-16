// Getting a song to sound within a second of the tap:
// - the data centre (DC) holding a chat's files is connected to as soon as the list shows, and kept open (GramJS
//   drops an idle one after 30 s), so the first piece does not wait for a new connection and its authorisation;
// - the first piece of a song (HEAD_BYTES) is fetched ahead: when a finger touches its row, and for the next song
//   while one plays. Kept for a few songs only.
import bigInt from "big-integer";
import type { Api } from "telegram";

import { MOCK } from "../mock";
import { getClient } from "../telegram/client";

export const HEAD_BYTES = 128 * 1024; // the first piece: one small request (fast on a slow network too); the
// player starts on it (a few seconds of an mp3)
const KEEP_HEADS = 8;
const KEEP_ALIVE_MS = 20_000;

const heads = new Map<string, Promise<Uint8Array | null>>(); // song key -> its first piece

/** The DC of a message's file (undefined: the account's own DC). */
function dcOf(media: Api.TypeMessageMedia | undefined) {
  const doc = (media as { document?: { dcId?: number } } | undefined)?.document;
  return doc?.dcId;
}

const warm = new Set<number>();
let keepAlive: ReturnType<typeof setInterval> | null = null;

/** Connect now to the DCs holding these files, and keep them connected. */
export function warmUp(medias: (Api.TypeMessageMedia | undefined)[]) {
  if (MOCK) return;
  const dcs = new Set(medias.map(dcOf).filter((d): d is number => !!d));
  if (!dcs.size) return;
  getClient()
    .then((client) => {
      for (const dc of dcs) {
        warm.add(dc);
        client.getSender(dc).catch(() => warm.delete(dc));
      }
      // borrowing a sender again resets GramJS' 30 s release timer
      keepAlive ??= setInterval(() => {
        for (const dc of warm) client.getSender(dc).catch(() => warm.delete(dc));
      }, KEEP_ALIVE_MS);
    })
    .catch(() => {});
}

/** Start fetching a song's first piece (no-op if it is on its way or was fetched). */
export function prefetchHead(key: string, media: Api.TypeMessageMedia | undefined, size: number) {
  if (MOCK || !media || heads.has(key)) return;
  heads.set(
    key,
    fetchHead(media, size).catch(() => {
      heads.delete(key);
      return null;
    }),
  );
  // a few songs only
  while (heads.size > KEEP_HEADS) heads.delete(heads.keys().next().value!);
}

/** A song's first HEAD_BYTES. */
export async function fetchHead(media: Api.TypeMessageMedia, size: number) {
  const client = await getClient();
  for await (const chunk of client.iterDownload({
    file: media as never,
    requestSize: HEAD_BYTES,
    fileSize: bigInt(size),
  })) {
    return new Uint8Array(chunk);
  }
  return null;
}

/** The first piece fetched ahead for this song, if any (waits for it when it is on its way). */
export function takeHead(key: string) {
  const head = heads.get(key);
  heads.delete(key);
  return head ?? null;
}
