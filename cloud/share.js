// Shared playlists: a copy of a playlist's songs in Cloudflare R2 (cloud/r2.js), listened to through a secret
// link (/s/<code>) without signing in. Routes of /api/cloud/* (cloud/api.js):
//
//   POST share-create   { playlistId, name, days, songs: [{ title, performer, duration, size, type, ref }], skipped }
//                                                   -> { share }          (owner; the link works at once)
//   POST share-put?code=&id=&k=  piece k of song id (application/octet-stream, SHARE_CHUNK bytes but the last)
//                                                   -> { ok }             (owner; the last piece makes the song playable)
//   POST share-pending  { code }                    -> { songs: [{ id, ref }] }  (owner; songs not uploaded yet)
//   POST share-sync     { code, songs, skipped }    -> { share, added, removed, pending: [{ id, ref }] }
//                       (owner; the link follows its playlist again: new songs to upload, those taken out removed
//                       from R2, the order of the playlist; the songs already there stay)
//   POST share-extend   { code, days }              -> { share, capped }  (owner; days more, SHARE_MAX_DAYS at most)
//   GET  share-list                                 -> { shares }         (owner; links still open)
//   POST share-revoke   { code }                    -> { ok }             (owner; songs removed from R2)
//   GET  share-open?code=                           -> { name, expiresAt, songs: [{ id, title, performer, duration,
//                                                         size, ready, url? }] }   (url: as share-play's, songs ready)
//   GET  share-play?code=&i=                        -> { url, expiresIn } (a signed /api/cloud/share-audio URL, 10 min)
//   GET  share-audio?code=&id=&n=&t=&exp=&sig=   the song's bytes, one piece at most per Range request (206)
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
// MongoDB collection "shares": { _id: code, accountId, playlistId, name, songs: [{ id, title, performer, duration,
// size, type, ref, ok }], nextId, skipped, createdAt, expiresAt }. ref: the song's "<chat>|<message>" (only the owner
// sees it: to upload again later, to sync). id: the song's place in R2, kept when the list changes (links made before
// ids: their index, given on the owner's next request). skipped: the playlist's songs that are not shared (not music,
// too big), so a sync does not count them as new. R2 objects: "s/<code>/<id>/<k>". Expired links are removed by the
// next owner requests; an R2 lifecycle rule ("s/", 91 days: a link lives SHARE_MAX_DAYS at most) is the safety net.
// "shareLocks" { _id: accountId, until, by }: one create / sync at a time; "shareQuota" { _id: "<account>:<day>",
// bytes, at }: the uploads of a day (removed after 2 days).

import crypto from "node:crypto";
import { r2Config, createBucket } from "./r2.js";
import { SHARE_DAYS, SHARE_SONGS_MAX, SHARE_FILE_MAX, SHARE_CHUNK, SHARE_MAX_DAYS, isFavoriteId } from "../core.js";

// An owner is anyone with a Telegram account, and R2 is paid by the GB kept and by the write: what one account may
// keep shared at once (the songs of all its open links), and send in a day (UTC; a piece may be sent again and again).
export const SHARES_PER_ACCOUNT = 20;
export const SHARE_ACCOUNT_BYTES = 20 * 1024 ** 3;
export const SHARE_DAY_BYTES = 2 * SHARE_ACCOUNT_BYTES;
/** Routes whose body is raw bytes, not JSON. */
export const RAW_BODY = new Set(["share-put"]);
/** A route's answer that is not JSON: { [RAW]: { status, headers, body } }. */
export const RAW = Symbol("raw response");

const PLAY_URL_TTL = 10 * 60;
const SWEEP_MAX = 3;
const LOCK_MS = 15_000; // a create / sync holds the account's links this long at most (a function's time is short)

const isCode = (c) => typeof c === "string" && /^[\w-]{16}$/.test(c);
const isAudioType = (t) => typeof t === "string" && /^audio\/[\w.+-]{1,60}$/.test(t);
const bytesOf = (songs) => songs.reduce((n, x) => n + x.size, 0);
const pieces = (size) => Math.ceil(size / SHARE_CHUNK);
const pieceKey = (code, id, k) => `s/${code}/${id}/${k}`;
/** A song's id (a link made before ids: its index). */
const songId = (song, i) => (Number.isInteger(song.id) ? song.id : i);
const songKeys = (code, song, i) =>
  Array.from({ length: pieces(song.size) }, (_, k) => pieceKey(code, songId(song, i), k));
/** The refs of the playlist's songs that are not shared, as sent (at most what a playlist holds). */
const cleanSkipped = (v) => (Array.isArray(v) ? [...new Set(v.filter(isFavoriteId))].slice(0, SHARE_SONGS_MAX) : []);
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
    type: isAudioType(s.type) ? s.type : "audio/mpeg",
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
 * @param limits   { accountBytes, dayBytes } (tests)
 */
export function shareRoutes({ env, db, account, fail, key, fetchFn, now = () => new Date(), limits = {} }) {
  const { accountBytes = SHARE_ACCOUNT_BYTES, dayBytes = SHARE_DAY_BYTES } = limits;
  const config = r2Config(env);
  const bucket = config && createBucket(config, { fetchFn, now });
  const shares = async () => (await db()).collection("shares");

  /**
   * One create / sync of an account's links at a time: requests sent all at once would each see room under the
   * limits (links, bytes) and all go in; two syncs of a link would each write their own list.
   */
  async function locked(acc, fn) {
    const col = (await db()).collection("shareLocks");
    const by = crypto.randomBytes(8).toString("hex");
    const t = now();
    try {
      await col.updateOne(
        { _id: acc, until: { $lte: t } },
        { $set: { until: new Date(t.getTime() + LOCK_MS), by } },
        { upsert: true },
      );
    } catch (err) {
      // held: the upsert finds no free lock and cannot insert a second one
      if (err?.code === 11000)
        throw fail(429, "Đang có thay đổi link chia sẻ khác, hãy thử lại sau giây lát", "SHARE_BUSY");
      throw err;
    }
    try {
      return await fn();
    } finally {
      await col.updateOne({ _id: acc, by }, { $set: { until: new Date(0) } }).catch(() => {});
    }
  }

  /** The bytes of an account's open links (but `except`'s), against SHARE_ACCOUNT_BYTES. */
  async function room(acc, wanted, except) {
    const [used] = await (
      await shares()
    )
      .aggregate([
        { $match: { accountId: acc, expiresAt: { $gt: now() }, ...(except && { _id: { $ne: except } }) } },
        { $unwind: "$songs" },
        { $group: { _id: null, bytes: { $sum: "$songs.size" } } },
      ])
      .toArray();
    if ((used?.bytes || 0) + wanted > accountBytes)
      throw fail(
        400,
        `Các link chia sẻ của bạn chứa tối đa ${Math.round(accountBytes / 1024 ** 3)} GB nhạc, hãy bớt bài hoặc thu hồi link cũ`,
        "SHARE_QUOTA",
      );
  }

  /** `n` bytes counted against the account's uploads of today (UTC); past SHARE_DAY_BYTES: 429 until tomorrow. */
  async function spend(acc, n) {
    const t = now();
    const day = await (
      await db()
    )
      .collection("shareQuota")
      .findOneAndUpdate(
        { _id: `${acc}:${t.toISOString().slice(0, 10)}` },
        { $inc: { bytes: n }, $setOnInsert: { at: t } },
        { upsert: true, returnDocument: "after" },
      );
    if (day.bytes > dayBytes)
      throw fail(429, "Hôm nay bạn đã tải lên quá nhiều, link sẽ được tải tiếp vào ngày mai", "SHARE_DAY_LIMIT");
  }

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

  /** The owner's share (open or not), or 404. A link made before ids gets them (its index: its songs stay put). */
  async function own(acc, code) {
    const s = isCode(code) && (await (await shares()).findOne({ _id: code, accountId: acc }));
    if (!s) throw fail(404, "Không tìm thấy link chia sẻ");
    if (s.songs.some((x) => !Number.isInteger(x.id))) {
      s.songs = s.songs.map((x, i) => ({ ...x, id: songId(x, i) }));
      s.nextId = Math.max(s.songs.length, ...s.songs.map((x) => x.id + 1));
      await (await shares()).updateOne({ _id: s._id }, { $set: { songs: s.songs, nextId: s.nextId } });
    }
    return s;
  }
  /** The owner's share, still open (else what share-open would say). */
  async function ownOpen(acc, code) {
    const s = await own(acc, code);
    if (s.expiresAt <= now()) throw fail(404, "Link chia sẻ không tồn tại hoặc đã hết hạn", "SHARE_GONE");
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
    const keys = s.songs.flatMap((song, i) => songKeys(s._id, song, i));
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

  const maxExpiry = (s) => s.createdAt.getTime() + SHARE_MAX_DAYS * 86400_000;
  /** What the owner's dialog shows (refs / skipped: to tell whether the playlist changed since). */
  const summary = (s) => ({
    code: s._id,
    playlistId: s.playlistId,
    name: s.name,
    count: s.songs.length,
    ready: s.songs.filter((x) => x.ok).length,
    expiresAt: s.expiresAt.getTime(),
    maxExpiresAt: maxExpiry(s),
    refs: s.songs.map((x) => x.ref),
    skipped: s.skipped || [],
  });

  // the audio URL: signed with the server's secret, for one song (its size and type too), for a few minutes
  const signAudio = (code, id, size, type, exp) =>
    crypto
      .createHmac("sha256", key)
      .update(`share-audio|${code}|${id}|${size}|${type}|${exp}`)
      .digest("base64url")
      .slice(0, 32);
  function audioUrl(code, id, song) {
    const exp = Math.floor(now().getTime() / 1000) + PLAY_URL_TTL;
    const params = new URLSearchParams({
      code,
      id: String(id),
      n: String(song.size),
      t: song.type,
      exp: String(exp),
      sig: signAudio(code, id, song.size, song.type, exp),
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
      songs.forEach((x, i) => (x.id = i));
      await storage(sweep).catch(() => {});
      return locked(acc, async () => {
        const col = await shares();
        if ((await col.countDocuments({ accountId: acc, expiresAt: { $gt: now() } })) >= SHARES_PER_ACCOUNT)
          throw fail(400, `Tối đa ${SHARES_PER_ACCOUNT} link chia sẻ cùng lúc, hãy thu hồi bớt`);
        await room(acc, bytesOf(songs));
        const t = now();
        const share = {
          _id: crypto.randomBytes(12).toString("base64url"),
          accountId: acc,
          playlistId,
          name,
          songs,
          nextId: songs.length,
          skipped: cleanSkipped(body.skipped),
          createdAt: t,
          expiresAt: new Date(t.getTime() + days * 86400_000),
        };
        await col.insertOne(share);
        return { share: summary(share) };
      });
    },

    "POST share-put": async (req, body) => {
      need();
      const { acc } = await account(req);
      const q = query(req);
      const s = await ownOpen(acc, q.get("code"));
      // by id (a page loaded before ids sends i, the index: the same then)
      const id = Number(q.get("id") ?? q.get("i"));
      const k = Number(q.get("k"));
      const song = Number.isInteger(id) && s.songs.find((x) => x.id === id);
      const n = song ? pieces(song.size) : 0;
      // a song taken out by a sync meanwhile: 404, its upload stops
      if (!song) throw fail(404, "Bài này không còn trong link chia sẻ", "SHARE_SONG_GONE");
      if (!Number.isInteger(k) || k < 0 || k >= n) throw fail(400, "Bài hát không hợp lệ");
      const expected = k < n - 1 ? SHARE_CHUNK : song.size - (n - 1) * SHARE_CHUNK;
      if (body.length !== expected) throw fail(400, "Dữ liệu bài hát không đúng kích thước");
      // already playable: not written again (each write is paid; what the listeners hear stays what was shared)
      if (song.ok) return { ok: true };
      await spend(acc, body.length);
      await storage(() => bucket.put(pieceKey(s._id, id, k), body, song.type));
      // pieces of a song come one after another: the last one makes it playable (found by id: a sync may have
      // moved it meanwhile)
      if (k === n - 1)
        await (
          await shares()
        ).updateOne({ _id: s._id }, { $set: { "songs.$[x].ok": true } }, { arrayFilters: [{ "x.id": id }] });
      return { ok: true };
    },

    "POST share-pending": async (req, body) => {
      need();
      const { acc } = await account(req);
      const s = await own(acc, body.code);
      return { songs: s.songs.flatMap((song) => (song.ok ? [] : [{ id: song.id, ref: song.ref }])) };
    },

    "POST share-sync": async (req, body) => {
      need();
      const { acc } = await account(req);
      return locked(acc, async () => {
        const s = await ownOpen(acc, body.code);
        if (!Array.isArray(body.songs) || !body.songs.length || body.songs.length > SHARE_SONGS_MAX)
          throw fail(400, "Playlist không có bài nhạc nào chia sẻ được");
        const incoming = body.songs.map(cleanSong);
        if (!incoming.every(Boolean)) throw fail(400, "Bài hát không hợp lệ");
        const had = new Map(s.songs.map((x) => [x.ref, x]));
        const seen = new Set();
        let nextId = s.nextId ?? s.songs.length;
        const songs = [];
        let added = 0;
        for (const x of incoming) {
          if (seen.has(x.ref)) continue;
          seen.add(x.ref);
          const old = had.get(x.ref);
          // already in the link: kept (uploaded or not), its details refreshed; new: to upload
          if (old) songs.push({ ...old, title: x.title, performer: x.performer, duration: x.duration ?? old.duration });
          else {
            songs.push({ ...x, id: nextId++ });
            added++;
          }
        }
        const gone = s.songs.filter((x) => !seen.has(x.ref));
        // a link made smaller is fine, even with the account past its bytes (links made before the limit)
        if (bytesOf(songs) > bytesOf(s.songs)) await room(acc, bytesOf(songs), s._id);
        await (
          await shares()
        ).updateOne({ _id: s._id }, { $set: { songs, nextId, skipped: cleanSkipped(body.skipped) } });
        // the songs taken out leave R2 (what fails now is left to the lifecycle rule: the link no longer points at them)
        if (gone.length)
          await bucket
            .removeMany(gone.flatMap((x) => songKeys(s._id, x, x.id)))
            .catch((err) => console.error("share: R2 delete (sync):", err?.message || err));
        const share = { ...s, songs, skipped: cleanSkipped(body.skipped) };
        return {
          share: summary(share),
          added,
          removed: gone.length,
          pending: songs.flatMap((x) => (x.ok ? [] : [{ id: x.id, ref: x.ref }])),
        };
      });
    },

    "POST share-extend": async (req, body) => {
      need();
      const { acc } = await account(req);
      const s = await ownOpen(acc, body.code);
      const days = Number(body.days);
      if (!SHARE_DAYS.includes(days)) throw fail(400, "Thời hạn link không hợp lệ");
      const max = maxExpiry(s);
      if (s.expiresAt.getTime() >= max)
        throw fail(400, `Link đã đạt thời hạn tối đa ${SHARE_MAX_DAYS} ngày, hãy tạo link mới`, "SHARE_MAX");
      const wanted = Math.max(now().getTime(), s.expiresAt.getTime()) + days * 86400_000;
      const expiresAt = new Date(Math.min(wanted, max));
      await (await shares()).updateOne({ _id: s._id }, { $set: { expiresAt } });
      return { share: summary({ ...s, expiresAt }), capped: wanted > max };
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
        songs: s.songs.map((x, i) => ({
          id: songId(x, i),
          title: x.title,
          performer: x.performer,
          duration: x.duration,
          size: x.size,
          ready: x.ok,
          ...(x.ok && { url: audioUrl(s._id, songId(x, i), x) }),
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
      return { url: audioUrl(s._id, songId(song, i), song), expiresIn: PLAY_URL_TTL };
    },

    "GET share-audio": async (req) => {
      need();
      const q = query(req);
      const code = q.get("code");
      const id = Number(q.get("id"));
      const size = Number(q.get("n"));
      const type = String(q.get("t") || "");
      const exp = Number(q.get("exp"));
      const sig = Buffer.from(String(q.get("sig") || ""));
      const want =
        isCode(code) &&
        Number.isInteger(id) &&
        Number.isSafeInteger(size) &&
        size > 0 &&
        isAudioType(type) &&
        Number.isInteger(exp)
          ? Buffer.from(signAudio(code, id, size, type, exp))
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
        bucket.stream(pieceKey(code, id, k), start - k * SHARE_CHUNK, end - k * SHARE_CHUNK),
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
