// Every song at one loudness, as on the web: the web version measures each song once (core.js measureLoudness) and
// keeps it on the sync server by Telegram document id (cloud/loudness.js); the app reads it there. A player's volume
// goes up to 1 only, so here loud songs are turned down to the target, quieter ones play as they are; a song nobody
// played on the web yet has no measure: as it is too.
import type { Api } from "telegram";

import { isDocId, isLoudness, levelGain } from "../../../core.js";
import { CLOUD_URL } from "../store/cloud";

const gains = new Map<string, number>(); // doc id -> gain (dB) of the songs measured
const asking = new Map<string, Promise<number | null>>();

const docOf = (media: Api.TypeMessageMedia | undefined) =>
  (media as Api.MessageMediaDocument | undefined)?.document?.id?.toString() ?? null;

/** The gain (dB) to play this song's file at, or null (not measured yet, no network). */
export function gainOf(media: Api.TypeMessageMedia | undefined): Promise<number | null> {
  const doc = docOf(media);
  if (!doc || !isDocId(doc)) return Promise.resolve(null);
  if (gains.has(doc)) return Promise.resolve(gains.get(doc)!);
  if (!asking.has(doc))
    asking.set(
      doc,
      fetch(`${CLOUD_URL}/api/cloud/loudness?ids=${doc}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          const m = data?.items?.[doc];
          if (!isLoudness(m)) return null;
          gains.set(doc, levelGain(m));
          return gains.get(doc)!;
        })
        .catch(() => null)
        .finally(() => asking.delete(doc)),
    );
  return asking.get(doc)!;
}

/** A player's volume for that gain: down for a loud song, never above 1. */
export const volumeOf = (gain: number | null) => (gain === null ? 1 : Math.min(1, 10 ** (gain / 20)));
