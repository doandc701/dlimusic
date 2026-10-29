// Shared playlists: a copy of a playlist's songs in Cloudflare R2 (cloud/r2.js), listened to through a secret
// link (/s/<code>) without signing in. Routes of /api/cloud/* (cloud/api.js):
//
//   POST share-create  { playlistId, name, days, songs: [{ title, performer, duration, size, type }] }
//                                                  -> { code, expiresAt }    (owner; songs not uploaded yet)
//   POST share-upload  { code, i }                 -> { url }                (owner; PUT URL of song i, 15 min)
//   POST share-done    { code }                    -> { share }              (owner; songs checked in R2, link opens)
//   GET  share-list                                -> { shares }             (owner; links still open)
//   POST share-revoke  { code }                    -> { ok }                 (owner; songs removed from R2)
//   GET  share-open?code=                          -> { name, expiresAt, songs: [{ title, performer, duration }] }
//   GET  share-play?code=&i=                       -> { url, expiresIn }     (GET URL of song i, 10 min)
//
// The two last ones need no sign-in: knowing the code is the permission. There is no download link: songs
// are played from short-lived signed URLs only (anyone determined can still record what plays).
//
// MongoDB collection "shares": { _id: code, accountId, playlistId, name, songs: [{ title, performer, duration,
// size, type }], at?: [R2 place of each song], createdAt, expiresAt, ready }. R2 objects: "s/<code>/<i>". Expired links (and uploads never
// finished) are removed by the next owner request; an R2 lifecycle rule ("s/", 31 days) is the safety net.

import crypto from "node:crypto";
import { r2Config, createBucket } from "./r2.js";
import { SHARE_DAYS, SHARE_SONGS_MAX, SHARE_FILE_MAX } from "../core.js";

export const SHARES_PER_ACCOUNT = 20;
const UPLOAD_URL_TTL = 15 * 60;
const PLAY_URL_TTL = 10 * 60;
const UNFINISHED_MS = 24 * 3600_000; // a share never marked done is dropped after a day
const SWEEP_MAX = 10;

const isCode = (c) => typeof c === "string" && /^[\w-]{16}$/.test(c);
const objectKey = (code, i) => `s/${code}/${i}`;
const text = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** A song's details as sent by the owner's browser, or null. */
function cleanSong(s) {
  if (!s || typeof s !== "object") return null;
  const size = Number(s.size);
  if (!Number.isSafeInteger(size) || size < 1 || size > SHARE_FILE_MAX) return null;
  const duration = Number(s.duration);
  return {
    title: text(s.title, 300) || "?",
    performer: text(s.performer, 300) || null,
    duration: Number.isFinite(duration) && duration > 0 && duration < 86400 ? Math.round(duration) : null,
    size,
    type: typeof s.type === "string" && /^audio\/[\w.+-]{1,60}$/.test(s.type) ? s.type : "audio/mpeg",
  };
}

/**
 * The routes, merged into cloud/api.js's.
 * @param db       () => connected database
 * @param account  async (req) => { acc } of the device token, throws 401
 * @param fail     (status, message, code?) => Error
 */
export function shareRoutes({ env, db, account, fail, fetchFn, now = () => new Date() }) {
  const config = r2Config(env);
  const bucket = config && createBucket(config, { fetchFn, now });
  const shares = async () => (await db()).collection("shares");

  function need() {
    if (!bucket) throw fail(503, "Máy chủ chưa cấu hình kho nhạc chia sẻ", "SHARE_OFF");
  }
  const storage = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      if (err.status) throw err;
      console.error("share: R2:", err?.message || err);
      throw fail(502, "Không kết nối được kho nhạc chia sẻ", "SHARE_DOWN");
    }
  };

  /** The owner's share, or 404. */
  async function own(acc, code) {
    const s = isCode(code) && (await (await shares()).findOne({ _id: code, accountId: acc }));
    if (!s) throw fail(404, "Không tìm thấy link chia sẻ");
    return s;
  }

  /** Remove a share's songs from R2, then the share (kept, expired, when R2 cannot be reached: tried again later). */
  async function remove(s) {
    const col = await shares();
    const places = s.at || s.songs.map((_, i) => i);
    try {
      for (let i = 0; i < places.length; i += 10)
        await Promise.all(places.slice(i, i + 10).map((p) => bucket.remove(objectKey(s._id, p))));
    } catch (err) {
      console.error("share: R2 delete:", err?.message || err);
      await col.updateOne({ _id: s._id }, { $set: { expiresAt: new Date(0), ready: false } });
      return false;
    }
    await col.deleteOne({ _id: s._id });
    return true;
  }

  /** Expired links and uploads never finished: a few at a time, on the owners' requests. */
  async function sweep() {
    const t = now();
    const old = await (
      await shares()
    )
      .find({
        $or: [{ expiresAt: { $lte: t } }, { ready: false, createdAt: { $lte: new Date(t - UNFINISHED_MS) } }],
      })
      .limit(SWEEP_MAX)
      .toArray();
    for (const s of old) await remove(s).catch(() => {});
  }

  const summary = (s) => ({
    code: s._id,
    playlistId: s.playlistId,
    name: s.name,
    count: s.songs.length,
    expiresAt: s.expiresAt.getTime(),
  });

  /** A link anyone may open: ready and not expired, else 404. */
  async function open(code) {
    const s = isCode(code) && (await (await shares()).findOne({ _id: code }));
    if (!s || !s.ready || s.expiresAt <= now())
      throw fail(404, "Link chia sẻ không tồn tại hoặc đã hết hạn", "SHARE_GONE");
    return s;
  }

  const query = (req) => new URL(req.url || "/", "http://x").searchParams;

  return {
    "GET share-status": async () => ({ enabled: !!bucket }),

    "POST share-create": async (req, body) => {
      need();
      const { acc } = await account(req);
      const days = Number(body.days);
      if (!SHARE_DAYS.includes(days)) throw fail(400, "Thời hạn link không hợp lệ");
      const name = text(body.name, 80);
      const playlistId = text(body.playlistId, 24);
      if (!name || !playlistId) throw fail(400, "Playlist không hợp lệ");
      if (!Array.isArray(body.songs) || !body.songs.length || body.songs.length > SHARE_SONGS_MAX)
        throw fail(400, `Mỗi link chia sẻ tối đa ${SHARE_SONGS_MAX} bài`);
      const songs = body.songs.map(cleanSong);
      if (!songs.every(Boolean)) throw fail(400, "Bài hát không hợp lệ");
      await storage(sweep);
      const col = await shares();
      if ((await col.countDocuments({ accountId: acc, expiresAt: { $gt: now() } })) >= SHARES_PER_ACCOUNT)
        throw fail(400, `Tối đa ${SHARES_PER_ACCOUNT} link chia sẻ cùng lúc, hãy thu hồi bớt`);
      const t = now();
      const share = {
        _id: crypto.randomBytes(12).toString("base64url"),
        accountId: acc,
        playlistId,
        name,
        songs,
        createdAt: t,
        expiresAt: new Date(t.getTime() + days * 86400_000),
        ready: false,
      };
      await col.insertOne(share);
      return { code: share._id, expiresAt: share.expiresAt.getTime() };
    },

    "POST share-upload": async (req, body) => {
      need();
      const { acc } = await account(req);
      const s = await own(acc, body.code);
      const i = Number(body.i);
      if (s.ready || !Number.isInteger(i) || !s.songs[i]) throw fail(400, "Bài hát không hợp lệ");
      return { url: bucket.putUrl(objectKey(s._id, i), UPLOAD_URL_TTL) };
    },

    "POST share-done": async (req, body) => {
      need();
      const { acc } = await account(req);
      const s = await own(acc, body.code);
      if (s.ready) return { share: summary(s) };
      // what really reached R2: songs missing or bigger than allowed are left out (and removed)
      const sizes = await storage(() => Promise.all(s.songs.map((_, i) => bucket.size(objectKey(s._id, i)))));
      const songs = [];
      const moves = [];
      for (const [i, song] of s.songs.entries()) {
        const size = sizes[i];
        if (size && size <= SHARE_FILE_MAX) {
          moves.push([i, songs.length]);
          songs.push({ ...song, size });
        } else if (size) await storage(() => bucket.remove(objectKey(s._id, i)));
      }
      if (!songs.length) {
        await remove(s);
        throw fail(400, "Không bài nào tải lên được");
      }
      // R2 cannot rename: songs keep their place, the list remembers where each one is
      const at = moves.map(([from]) => from);
      await (await shares()).updateOne({ _id: s._id }, { $set: { songs, at, ready: true } });
      return { share: summary({ ...s, songs }) };
    },

    "GET share-list": async (req) => {
      need();
      const { acc } = await account(req);
      await storage(sweep).catch(() => {});
      const list = await (
        await shares()
      )
        .find({ accountId: acc, ready: true, expiresAt: { $gt: now() } })
        .sort({ createdAt: -1 })
        .toArray();
      return { shares: list.map(summary) };
    },

    "POST share-revoke": async (req, body) => {
      need();
      const { acc } = await account(req);
      const s = await own(acc, body.code);
      // closed at once; the songs go now, or with a later sweep
      await (await shares()).updateOne({ _id: s._id }, { $set: { expiresAt: new Date(0), ready: false } });
      await remove(s);
      return { ok: true };
    },

    "GET share-open": async (req) => {
      need();
      const s = await open(query(req).get("code"));
      return {
        name: s.name,
        expiresAt: s.expiresAt.getTime(),
        songs: s.songs.map(({ title, performer, duration }) => ({ title, performer, duration })),
      };
    },

    "GET share-play": async (req) => {
      need();
      const q = query(req);
      const s = await open(q.get("code"));
      const i = Number(q.get("i"));
      const song = Number.isInteger(i) && s.songs[i];
      if (!song) throw fail(404, "Không tìm thấy bài hát");
      const url = bucket.getUrl(objectKey(s._id, s.at ? s.at[i] : i), PLAY_URL_TTL, {
        "response-content-type": song.type,
        "response-content-disposition": "inline",
        "response-cache-control": "private, no-store",
      });
      return { url, expiresIn: PLAY_URL_TTL };
    },
  };
}
