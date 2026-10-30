// Shared playlists: a copy of a playlist's songs in Cloudflare R2 (cloud/r2.js), listened to through a secret
// link (/s/<code>) without signing in. Routes of /api/cloud/* (cloud/api.js):
//
//   POST share-create   { playlistId, name, days, songs: [{ title, performer, duration, size, type, ref }] }
//                                                   -> { share }          (owner; the link works at once)
//   POST share-put?code=&i=&k=   piece k of song i (application/octet-stream, SHARE_CHUNK bytes but the last)
//                                                   -> { ok }             (owner; the last piece makes the song playable)
//   POST share-pending  { code }                    -> { songs: [{ i, ref }] }   (owner; songs not uploaded yet)
//   GET  share-list                                 -> { shares }         (owner; links still open)
//   POST share-revoke   { code }                    -> { ok }             (owner; songs removed from R2)
//   GET  share-open?code=                           -> { name, expiresAt, songs: [{ title, performer, duration, size,
//                                                         ready, url? }] }   (url: as share-play's, for the songs ready)
//   GET  share-play?code=&i=                        -> { url, expiresIn } (a signed /api/cloud/share-audio URL, 10 min)
//   GET  share-audio?code=&i=&n=&t=&exp=&sig=   the song's bytes, one piece at most per Range request (206)
//
// share-audio is what plays, piece after piece: it reads nothing in MongoDB (the signed URL says which song, its size
// and type) and passes R2's bytes on as they come, so the music starts quickly; the browser may keep a piece for
// the URL's 10 minutes (seeking back). A revoked link's songs are gone from R2 at once, so its URLs stop too.
//
// The link is open as soon as it is made: the owner's browser uploads the songs one after another (in the
// playlist's order) and the listener plays those already there. Everything goes through this function — the
// browsers never talk to R2 (some networks block it, and no CORS is needed). Knowing the code is the permission
// to listen; there is no download button, and the audio URL lives 10 minutes (anyone determined can still record
// what plays).
//
// MongoDB collection "shares": { _id: code, accountId, playlistId, name, songs: [{ title, performer, duration,
// size, type, ref, ok }], createdAt, expiresAt }. ref: the song's "<chat>|<message>" (only the owner sees it, to
// upload again later). R2 objects: "s/<code>/<i>/<k>". Expired links are removed by the next owner requests; an R2
// lifecycle rule ("s/", 31 days) is the safety net.

import crypto from "node:crypto";
import { r2Config, createBucket } from "./r2.js";
import { SHARE_DAYS, SHARE_SONGS_MAX, SHARE_FILE_MAX, SHARE_CHUNK, isFavoriteId } from "../core.js";

export const SHARES_PER_ACCOUNT = 20;
/** Routes whose body is raw bytes, not JSON. */
export const RAW_BODY = new Set(["share-put"]);
/** A route's answer that is not JSON: { [RAW]: { status, headers, body } }. */
export const RAW = Symbol("raw response");

const PLAY_URL_TTL = 10 * 60;
const SWEEP_MAX = 3;

const isCode = (c) => typeof c === "string" && /^[\w-]{16}$/.test(c);
const pieces = (size) => Math.ceil(size / SHARE_CHUNK);
const pieceKey = (code, i, k) => `s/${code}/${i}/${k}`;
const text = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** A song's details as sent by the owner's browser, or null. */
function cleanSong(s) {
  if (!s || typeof s !== "object" || !isFavoriteId(s.ref)) return null;
  const size = Number(s.size);
  if (!Number.isSafeInteger(size) || size < 1 || size > SHARE_FILE_MAX) return null;
  const duration = Number(s.duration);
  return {
    title: text(s.title, 300) || "?",
    performer: text(s.performer, 300) || null,
    duration: Number.isFinite(duration) && duration > 0 && duration < 86400 ? Math.round(duration) : null,
    size,
    type: typeof s.type === "string" && /^audio\/[\w.+-]{1,60}$/.test(s.type) ? s.type : "audio/mpeg",
    ref: s.ref,
    ok: false,
  };
}

/**
 * The routes, merged into cloud/api.js's.
 * @param db       () => connected database
 * @param account  async (req) => { acc } of the device token, throws 401
 * @param fail     (status, message, code?) => Error
 * @param key      32-byte secret (signs the audio URLs)
 */
export function shareRoutes({ env, db, account, fail, key, fetchFn, now = () => new Date() }) {
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

  /** The owner's share (open or not), or 404. */
  async function own(acc, code) {
    const s = isCode(code) && (await (await shares()).findOne({ _id: code, accountId: acc }));
    if (!s) throw fail(404, "Không tìm thấy link chia sẻ");
    return s;
  }

  /**
   * A link anyone may open, else why not (the page tells the listener): 410 SHARE_EXPIRED (with the playlist's name
   * and when, until the next sweep removes it), 410 SHARE_REVOKED, 404 SHARE_GONE (never was, or removed since).
   */
  async function open(code) {
    const s = isCode(code) && (await (await shares()).findOne({ _id: code }));
    if (!s) throw fail(404, "Link chia sẻ không tồn tại hoặc đã hết hạn", "SHARE_GONE");
    if (s.expiresAt.getTime() === 0) throw fail(410, "Link chia sẻ đã bị thu hồi", "SHARE_REVOKED");
    if (s.expiresAt <= now())
      throw Object.assign(fail(410, "Link chia sẻ đã hết hạn", "SHARE_EXPIRED"), {
        data: { name: s.name, expiredAt: s.expiresAt.getTime() },
      });
    return s;
  }

  /** Remove a share's songs from R2, then the share (kept, expired, when R2 fails: tried again by a later sweep). */
  async function remove(s) {
    const col = await shares();
    const keys = s.songs.flatMap((song, i) =>
      Array.from({ length: pieces(song.size) }, (_, k) => pieceKey(s._id, i, k)),
    );
    try {
      await bucket.removeMany(keys);
    } catch (err) {
      console.error("share: R2 delete:", err?.message || err);
      await col.updateOne({ _id: s._id }, { $set: { expiresAt: new Date(0) } });
      return false;
    }
    await col.deleteOne({ _id: s._id });
    return true;
  }

  /** Expired links: a few at a time, on the owners' requests. */
  async function sweep() {
    const old = await (
      await shares()
    )
      .find({ expiresAt: { $lte: now() } })
      .limit(SWEEP_MAX)
      .toArray();
    for (const s of old) await remove(s).catch(() => {});
  }

  const summary = (s) => ({
    code: s._id,
    playlistId: s.playlistId,
    name: s.name,
    count: s.songs.length,
    ready: s.songs.filter((x) => x.ok).length,
    expiresAt: s.expiresAt.getTime(),
  });

  // the audio URL: signed with the server's secret, for one song (its size and type too), for a few minutes
  const signAudio = (code, i, size, type, exp) =>
    crypto
      .createHmac("sha256", key)
      .update(`share-audio|${code}|${i}|${size}|${type}|${exp}`)
      .digest("base64url")
      .slice(0, 32);
  function audioUrl(code, i, song) {
    const exp = Math.floor(now().getTime() / 1000) + PLAY_URL_TTL;
    const params = new URLSearchParams({
      code,
      i: String(i),
      n: String(song.size),
      t: song.type,
      exp: String(exp),
      sig: signAudio(code, i, song.size, song.type, exp),
    });
    return `/api/cloud/share-audio?${params}`;
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
        throw fail(400, "Playlist không có bài nhạc nào chia sẻ được");
      const songs = body.songs.map(cleanSong);
      if (!songs.every(Boolean)) throw fail(400, "Bài hát không hợp lệ");
      await storage(sweep).catch(() => {});
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
      };
      await col.insertOne(share);
      return { share: summary(share) };
    },

    "POST share-put": async (req, body) => {
      need();
      const { acc } = await account(req);
      const q = query(req);
      const s = await own(acc, q.get("code"));
      if (s.expiresAt <= now()) throw fail(404, "Link chia sẻ không tồn tại hoặc đã hết hạn", "SHARE_GONE");
      const i = Number(q.get("i"));
      const k = Number(q.get("k"));
      const song = Number.isInteger(i) && s.songs[i];
      const n = song ? pieces(song.size) : 0;
      if (!song || !Number.isInteger(k) || k < 0 || k >= n) throw fail(400, "Bài hát không hợp lệ");
      const expected = k < n - 1 ? SHARE_CHUNK : song.size - (n - 1) * SHARE_CHUNK;
      if (body.length !== expected) throw fail(400, "Dữ liệu bài hát không đúng kích thước");
      await storage(() => bucket.put(pieceKey(s._id, i, k), body, song.type));
      // pieces of a song come one after another: the last one makes it playable
      if (k === n - 1) await (await shares()).updateOne({ _id: s._id }, { $set: { [`songs.${i}.ok`]: true } });
      return { ok: true };
    },

    "POST share-pending": async (req, body) => {
      need();
      const { acc } = await account(req);
      const s = await own(acc, body.code);
      return { songs: s.songs.flatMap((song, i) => (song.ok ? [] : [{ i, ref: song.ref }])) };
    },

    "GET share-list": async (req) => {
      need();
      const { acc } = await account(req);
      await storage(sweep).catch(() => {});
      const list = await (
        await shares()
      )
        .find({ accountId: acc, expiresAt: { $gt: now() } })
        .sort({ createdAt: -1 })
        .toArray();
      return { shares: list.map(summary) };
    },

    "POST share-revoke": async (req, body) => {
      need();
      const { acc } = await account(req);
      const s = await own(acc, body.code);
      // closed at once; the songs go now, or with a later sweep
      await (await shares()).updateOne({ _id: s._id }, { $set: { expiresAt: new Date(0) } });
      await remove(s);
      return { ok: true };
    },

    "GET share-open": async (req) => {
      need();
      const s = await open(query(req).get("code"));
      return {
        name: s.name,
        expiresAt: s.expiresAt.getTime(),
        songs: s.songs.map(({ title, performer, duration, size, ok }, i) => ({
          title,
          performer,
          duration,
          size,
          ready: ok,
          ...(ok && { url: audioUrl(s._id, i, s.songs[i]) }),
        })),
        expiresIn: PLAY_URL_TTL,
      };
    },

    "GET share-play": async (req) => {
      need();
      const q = query(req);
      const s = await open(q.get("code"));
      const i = Number(q.get("i"));
      const song = Number.isInteger(i) && s.songs[i];
      if (!song) throw fail(404, "Không tìm thấy bài hát");
      if (!song.ok) throw fail(409, "Bài này đang được tải lên, hãy thử lại sau ít phút", "SHARE_PENDING");
      return { url: audioUrl(s._id, i, song), expiresIn: PLAY_URL_TTL };
    },

    "GET share-audio": async (req) => {
      need();
      const q = query(req);
      const code = q.get("code");
      const i = Number(q.get("i"));
      const size = Number(q.get("n"));
      const type = String(q.get("t") || "");
      const exp = Number(q.get("exp"));
      const sig = Buffer.from(String(q.get("sig") || ""));
      const want =
        isCode(code) && Number.isInteger(i) && Number.isSafeInteger(size) && size > 0 && Number.isInteger(exp)
          ? Buffer.from(signAudio(code, i, size, type, exp))
          : null;
      if (!want || sig.length !== want.length || !crypto.timingSafeEqual(sig, want) || exp * 1000 < now().getTime())
        throw fail(403, "Link phát nhạc đã hết hạn", "SHARE_URL_EXPIRED");
      // bytes=a-b, bytes=a- or bytes=-n; answered one piece at most (the player asks again for the rest)
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "bytes=0-");
      let start = m?.[1] ? Number(m[1]) : null;
      let end = m?.[2] ? Number(m[2]) : null;
      if (start === null) [start, end] = [Math.max(0, size - (end ?? 0)), size - 1];
      if (!m || start >= size || (end !== null && end < start))
        return { [RAW]: { status: 416, headers: { "Content-Range": `bytes */${size}` }, body: "" } };
      const k = Math.floor(start / SHARE_CHUNK);
      end = Math.min(end ?? Infinity, (k + 1) * SHARE_CHUNK - 1, size - 1);
      const body = await storage(() =>
        bucket.stream(pieceKey(code, i, k), start - k * SHARE_CHUNK, end - k * SHARE_CHUNK),
      );
      if (!body) throw fail(404, "Không tìm thấy bài hát", "SHARE_GONE");
      return {
        [RAW]: {
          status: 206,
          headers: {
            "Content-Type": type,
            "Content-Range": `bytes ${start}-${end}/${size}`,
            "Content-Length": String(end - start + 1),
            "Accept-Ranges": "bytes",
            "Content-Disposition": "inline",
            "Cache-Control": "private, max-age=600",
          },
          body,
        },
      };
    },
  };
}
