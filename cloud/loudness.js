// Songs' loudness (core.js measureLoudness), kept by Telegram document id: a song is measured once, by the first
// browser that plays it, and every device (and every shared link) plays it at the same level after that.
// Routes of /api/cloud/* (cloud/api.js):
//
//   GET  loudness?ids=<doc>,<doc>…          -> { items: { <doc>: { lufs, peak } } }   (no token: only numbers)
//   POST loudness { items: [{ doc, lufs, peak }] } -> { ok }                         (a signed-in device)
//
// MongoDB collection "loudness": { _id: doc, lufs, peak, at }. The first measure stays (a file does not change; a
// later one cannot overwrite it).

import { isLoudness, isDocId, levelGain } from "../core.js";

const IDS_MAX = 100;
const PUT_MAX = 50;

const loudness = async (db) => (await db()).collection("loudness");

/** doc id -> gain (dB, core.js levelGain) of the songs measured. */
export async function gainsOf(db, docs) {
  const ids = [...new Set(docs.filter(isDocId))];
  if (!ids.length) return new Map();
  const found = await (await loudness(db)).find({ _id: { $in: ids } }).toArray();
  return new Map(found.filter(isLoudness).map((x) => [x._id, levelGain(x)]));
}

export function loudnessRoutes({ db, account, fail }) {
  return {
    "GET loudness": async (req) => {
      const ids = (new URL(req.url || "/", "http://x").searchParams.get("ids") || "").split(",").filter(isDocId);
      if (ids.length > IDS_MAX) throw fail(400, "Quá nhiều bài");
      const found = ids.length ? await (await loudness(db)).find({ _id: { $in: ids } }).toArray() : [];
      return {
        items: Object.fromEntries(found.filter(isLoudness).map((x) => [x._id, { lufs: x.lufs, peak: x.peak }])),
      };
    },

    "POST loudness": async (req, body) => {
      await account(req);
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length || items.length > PUT_MAX || !items.every((x) => isDocId(x?.doc) && isLoudness(x)))
        throw fail(400, "Dữ liệu không hợp lệ");
      const at = new Date();
      await (
        await loudness(db)
      )
        .bulkWrite(
          items.map((x) => ({
            updateOne: {
              filter: { _id: x.doc },
              update: { $setOnInsert: { lufs: x.lufs, peak: x.peak, at } },
              upsert: true,
            },
          })),
          { ordered: false },
        )
        .catch((err) => {
          // two devices measuring the same song at once: the other one's measure is there, fine
          const dup = (e) => e?.code === 11000;
          if (!(dup(err) || (err?.writeErrors?.length && err.writeErrors.every(dup)))) throw err;
        });
      return { ok: true };
    },
  };
}
