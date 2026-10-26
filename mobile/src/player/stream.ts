// Play a song while it is fetched from Telegram, piece by piece the way YouTube fetches a video, with only what
// Expo Go has (so iPhone and Android alike):
// - the song is fetched around the play position, not from start to end: play starts once its first START_SECONDS
//   of music are there (after the ID3 tag; QUICK_START on a fast network), then the rest comes STEP_SECONDS of
//   music at a time while it plays; a jump fetches from there;
// - always fetching ahead, playing or paused, to the end of the song, then any part skipped by a jump: the song
//   ends up whole in the cache;
// - two pieces on their way at a time; after a wait, play goes on sooner on a fast network than on a slow one;
// - the pieces are written in place into the cache file, with a map of the ones there (`<file>.map`): a song
//   played again goes on from what it has; once whole, the map goes and it plays from the cache.
// A player reads a local file only as it was when it opened it, so the longer file is opened again before the part
// it has runs out — on a second player, in the background, which takes over at the very position the first one is
// playing (no silence while it opens).
import bigInt from "big-integer";
import type { AudioPlayer } from "expo-audio";
import { File, FileMode, type FileHandle } from "expo-file-system";
import type { Api } from "telegram";

import { getClient } from "../telegram/client";
import { fetchHead, warmUp } from "./prefetch";

const UNIT = 16 * 1024; // the smallest piece, and the map's unit
const MAX_PIECE = 512 * 1024; // the largest piece GramJS asks Telegram for
const START_SECONDS = 10; // play once this much music is there…
const QUICK_START = 4; // …or this much on a network well faster than the music (it keeps ahead after)
const STEP_SECONDS = 5; // …then fetch this much at a time
const GUESS_BITRATE = 40 * 1024; // bytes / second of music when Telegram does not give the length (320 kbps)
const PARALLEL = 2; // pieces fetched at the same time (a slow network's round trips overlap)…
const FAR_AHEAD = 120; // …while less than this much music (seconds) is ahead of the position; past it, one at a
const FAR_PAUSE_MS = 400; // time with this rest between pieces: decoding Telegram's pieces runs on the JS thread,
// which also scrolls the lists and answers the buttons (a song fetched flat out made them lag)
const SAVE_MS = 2000; // the map of the pieces there is saved at most this often
const SKIP_TAG = 256 * 1024; // a tag larger than this (a big cover art) is not fetched: blanked, the music first
const RETRY_BYTES = 1024 * 1024; // a part the player could not open (big cover art first…): try again this much later
const RETRIES = 3; // …this many times, then fetch the whole song first
const MIN_STEP = 256 * 1024; // re-open once this much more is there — doubling with what the player has (256 KB,
const MAX_STEP = 2 * 1024 * 1024; // 512 KB, 1 MB, then 2 MB): few re-opens…
const LEAD_SECONDS = 12; // …started this long before the part the player has runs out
const SEEK_MARGIN = 64 * 1024; // a position needs this much past it fetched (positions are estimated from the size)
const RESUME_FAST = START_SECONDS; // after a wait, go on once this much music is ahead (seconds) when the network is fast…
const RESUME_SLOW = 15; // …or this much when it is barely faster than the music (fewer stops)

/** The network's speed (bytes / second) as the last songs were fetched: a song starts sooner on a fast one. */
let lastSpeed = 0;

// what the stream does, in the dev server's terminal (npm run dev): to see why a song does not start on a phone
const log = (...args: unknown[]) => __DEV__ && console.log("[stream]", ...args);

/** Where the ID3v2 tag at the start of a file ends (0: none). */
export function id3End(b: Uint8Array) {
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return 0; // "ID3"
  if (b[3] < 2 || b[3] > 4 || (b[6] | b[7] | b[8] | b[9]) & 0x80) return 0;
  const size = (b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9]; // 7 bits a byte
  return 10 + size + (b[5] & 0x10 ? 10 : 0); // + its footer
}

export type StreamState = "fetching" | "playing" | "waiting" | "error";

type Options = {
  players: [AudioPlayer, AudioPlayer]; // the one playing and the one opening the longer file
  active: () => number; // which of the two is playing
  setActive: (i: number) => void;
  file: File;
  size: number; // bytes of the whole song
  duration?: number; // seconds (Telegram's), to place positions in the file
  media: Api.TypeMessageMedia;
  head?: Promise<Uint8Array | null> | null; // the first piece, fetched ahead
  rate: () => number;
  onProgress: (fraction: number) => void; // how far the song is fetched from the play position on (YouTube's grey bar)
  onState: (state: StreamState, error?: unknown) => void;
};

export class SongStream {
  private units: Uint8Array; // 1: that 128 KB of the song is in the file
  private asked: Uint8Array; // 1: on its way
  private count = 0;
  private done = false; // whole song fetched
  private handle: FileHandle | null = null;
  private parts: File;
  private view = { start: 0, end: 0 }; // the bytes the playing player had (in one run) when it opened the file
  private speed = 0; // bytes / second, measured
  private wakeUp: (() => void)[] = [];
  private failed = false;
  private started = false;
  private opening = false;
  private pendingSeek: number | null = null; // a jump made while a player was opening
  private needWhole = false; // the player cannot open a part of this file (e.g. m4a with its index at the end)
  private failures = 0; // parts the player could not open
  private retryAt = 0; // bytes to have before trying again
  private musicAt = 0; // where the music starts (after the ID3 tag)
  private waitAt: number | null = null; // a position to go on from once enough has come in
  private cancelled = false;
  private paused = false; // play / pause asked by the user
  private seekingTo: number | null = null; // a jump on its way (the player still says where it was)
  private savedAt = 0;
  private shown = -1; // the progress last reported

  constructor(private o: Options) {
    this.units = new Uint8Array(Math.ceil(o.size / UNIT));
    this.asked = new Uint8Array(this.units.length);
    this.parts = new File(o.file.uri + ".map");
  }

  /** The player playing now. */
  private get player() {
    return this.o.players[this.o.active()];
  }

  async start() {
    const { file, size, media } = this.o;
    const old = new File(file.uri + ".parts"); // a map of 128 KB pieces (before): fetched again
    if (old.exists) {
      old.delete();
      if (file.exists) file.delete();
    }
    if (file.exists && !this.parts.exists && file.size === size) {
      // fetched before: play at once
      this.units.fill(1);
      this.count = this.units.length;
      this.done = true;
      this.o.onProgress(1);
      return this.open(0, true);
    }
    this.o.onState("fetching");
    warmUp([media]); // kept connected while the fetch rests
    try {
      this.handle = this.openFile();
      if (!this.units[0]) {
        // the first piece (fetched ahead when a finger touched the row / for the next song, else now)
        const head = (await this.o.head) ?? (await fetchHead(media, size));
        if (this.cancelled) throw new Error("cancelled");
        if (!head?.length) throw new Error("Không tải được bài này");
        this.write(0, head);
        this.afterTag(head);
      } else {
        // fetched in part before: where its music starts
        const h = this.handle!;
        h.offset = 0;
        const end = id3End(h.readBytes(10));
        this.musicAt = end;
      }
      this.grow();
      const client = await getClient();
      await Promise.all(Array.from({ length: PARALLEL }, (_, i) => this.fetcher(client, i)));
    } catch (err) {
      this.failed = true;
      this.wake();
      if (!this.cancelled) this.o.onState("error", err);
    } finally {
      this.handle?.close();
      this.handle = null;
      if (!this.done) this.save(); // what came in since the last save
    }
  }

  /**
   * The cache file, opened for writing: the pieces fetched before (its map) are kept, else a new empty one. Made
   * again if it went missing in between (its folder emptied by the system…: "The file … doesn't exist" on iOS).
   */
  private openFile() {
    const { file } = this.o;
    if (file.exists && this.parts.exists) {
      // fetched in part before: go on from there
      this.parts
        .textSync()
        .split("")
        .forEach((c, i) => {
          if (c === "1" && i < this.units.length) this.units[i] = 1;
        });
      this.count = this.units.reduce((n, u) => n + u, 0);
    } else this.fresh();
    try {
      return file.open(FileMode.ReadWrite);
    } catch (err) {
      log("open for writing failed, made again:", String(err));
      this.fresh();
      return file.open(FileMode.ReadWrite);
    }
  }

  /** A new empty cache file and map (nothing of the song there). */
  private fresh() {
    const { file } = this.o;
    const dir = file.parentDirectory;
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    file.create({ overwrite: true });
    this.parts.create({ overwrite: true });
    this.units.fill(0);
    this.count = 0;
  }

  /** Save the map of the pieces there (a song played again goes on from them). */
  private save() {
    this.savedAt = Date.now();
    try {
      if (this.parts.exists) this.parts.write(this.units.join(""));
    } catch {}
  }

  /** Whether the music fetched ahead of the position is plenty. */
  private farAhead() {
    if (!this.started || !this.duration || this.waitAt !== null) return false;
    const at = this.player.currentTime;
    return this.secondsAt(this.runEnd(this.bytesAt(at))) - at > FAR_AHEAD * this.o.rate();
  }

  /** Fetch the pieces the play position needs, one after another (PARALLEL of these run). */
  private async fetcher(client: Awaited<ReturnType<typeof getClient>>, index: number) {
    while (!this.cancelled && !this.failed && !this.done) {
      const far = this.farAhead();
      const next = index > 0 && far ? null : this.nextPiece(); // far ahead: the first fetcher only
      if (!next) {
        await new Promise<void>((resolve) => this.wakeUp.push(resolve));
        continue;
      }
      if (far) {
        await new Promise((resolve) => setTimeout(resolve, FAR_PAUSE_MS));
        if (this.cancelled || this.failed) return;
        if (this.nextPiece()?.from !== next.from) continue; // a jump meanwhile
      }
      this.ask(next.from, next.size, 1);
      const t0 = Date.now();
      let piece: Uint8Array | null = null;
      try {
        for await (const chunk of client.iterDownload({
          file: this.o.media as never,
          offset: bigInt(next.from),
          requestSize: next.size,
          limit: 1,
          fileSize: bigInt(this.o.size),
        })) {
          // a copy of its own: a Buffer can be a slice of a larger memory block, which the native write may not
          // read from the right place (the app closed when it did)
          piece = new Uint8Array(chunk);
        }
      } finally {
        this.ask(next.from, next.size, 0);
      }
      if (this.cancelled || this.failed) return;
      if (!piece?.length) throw new Error("Telegram không trả về dữ liệu");
      const sample = piece.length / Math.max(0.05, (Date.now() - t0) / 1000);
      this.speed = this.speed ? this.speed * 0.7 + sample * 0.3 : sample;
      lastSpeed = this.speed;
      this.write(next.from, piece);
      this.grow();
      this.wake(); // the other one may be resting for want of a piece to fetch
    }
  }

  /** Mark a piece as on its way (1) or not (0). */
  private ask(from: number, size: number, on: 0 | 1) {
    const last = Math.ceil(Math.min(from + size, this.o.size) / UNIT);
    for (let u = Math.floor(from / UNIT); u < last; u++) this.asked[u] = on;
  }

  setPaused(paused: boolean) {
    this.paused = paused;
  }

  cancel() {
    this.cancelled = true;
    this.wake();
  }

  /** Let a resting fetch look again at what it should fetch. */
  private wake() {
    const waiting = this.wakeUp;
    this.wakeUp = [];
    for (const resolve of waiting) resolve();
  }

  /**
   * An mp3 starts with an ID3 tag (title, cover art…) the player reads past before the music: start once the music
   * after it is there. A big one (cover art of a few MB) is not waited for: written as an empty tag of the same size
   * (zeros are the tag's padding, the player skips them), so the music right after it is fetched first. The song
   * cached keeps the empty tag: its title and artist come from Telegram anyway.
   */
  private afterTag(head: Uint8Array) {
    const end = id3End(head);
    if (!end) return;
    this.musicAt = end;
    log(`ID3 tag ${(end / 1024).toFixed(0)} KB${end > SKIP_TAG ? " (blanked, music first)" : ""}`);
    if (end <= SKIP_TAG) return;
    const blank = new Uint8Array(Math.min(head.length, end));
    blank.set(head.subarray(0, 10)); // the tag's header (its size) only
    this.write(0, blank);
    // the 128 KB units wholly inside the tag count as there; the one holding its end is fetched (music in it)
    for (let u = 0; u < Math.floor(end / UNIT); u++)
      if (!this.units[u]) {
        this.units[u] = 1;
        this.count++;
      }
    this.save();
  }

  /** Put a piece in its place in the file. */
  private write(from: number, bytes: Uint8Array) {
    // never on a closed file: moving the position of one is an iOS exception that closes the app
    if (!this.handle || this.cancelled) return;
    const h = this.handle;
    h.offset = from;
    h.writeBytes(bytes);
    const last = Math.ceil(Math.min(from + bytes.length, this.o.size) / UNIT);
    for (let u = Math.floor(from / UNIT); u < last; u++)
      if (!this.units[u]) {
        this.units[u] = 1;
        this.count++;
      }
    if (this.count >= this.units.length) {
      this.done = true;
      this.parts.delete(); // whole: plays from the cache from now on
    } else if (Date.now() - this.savedAt > SAVE_MS) this.save();
    this.progress();
  }

  /** Where the run of fetched bytes holding `byte` ends (`byte` itself if it is not fetched). */
  private runEnd(byte: number, orAsked = false) {
    const has = (u: number) => this.units[u] || (orAsked && this.asked[u]);
    let u = Math.floor(byte / UNIT);
    if (!has(u)) return byte;
    while (u < this.units.length && has(u)) u++;
    return Math.min(u * UNIT, this.o.size);
  }

  /** Where the run of fetched bytes holding `byte` starts. */
  private runStart(byte: number) {
    let u = Math.floor(byte / UNIT);
    if (!this.units[u]) return byte;
    while (u > 0 && this.units[u - 1]) u--;
    return u * UNIT;
  }

  private get duration() {
    return this.o.duration || this.player.duration || 0;
  }

  /** The byte position of a time in the song. */
  private bytesAt(seconds: number) {
    const d = this.duration;
    return d ? Math.min(this.o.size, Math.ceil((seconds / d) * this.o.size)) : this.o.size;
  }

  /** The bytes of this many seconds of music. */
  private bytesFor(seconds: number) {
    const d = this.o.duration || 0;
    return Math.ceil((d ? this.o.size / d : GUESS_BITRATE) * seconds);
  }

  /** The time of a byte position in the song. */
  private secondsAt(bytes: number) {
    return (bytes / this.o.size) * this.duration;
  }

  /** The position the fetch serves: where play waits, or is. */
  private position() {
    return this.target() ?? (this.started ? this.player.currentTime : 0);
  }

  /** Where play is going to be (a jump being made / waited for), or null: where the player is. */
  target() {
    return this.pendingSeek ?? this.seekingTo ?? this.waitAt;
  }

  private progress() {
    const end = this.done ? this.o.size : this.runEnd(this.bytesAt(this.position()));
    const fraction = this.o.size ? end / this.o.size : 0;
    // in steps (a re-draw of the seek bar each piece is not needed)
    if (Math.abs(fraction - this.shown) >= 0.002 || (fraction === 1 && this.shown !== 1))
      this.o.onProgress((this.shown = fraction));
  }

  /** The next piece to fetch (null: all is there or on its way). */
  private nextPiece(): { from: number; size: number } | null {
    if (this.done) return null;
    const at = this.position();
    let from = this.runEnd(this.bytesAt(at), true); // past what is there or on its way
    if (from >= this.o.size) {
      // all is there from the play position on: the parts before it a jump went past
      const u = this.units.findIndex((has, i) => !has && !this.asked[i]);
      if (u < 0) return null;
      from = u * UNIT;
    }
    from -= from % UNIT;
    // STEP_SECONDS of music (START_SECONDS before play starts), in Telegram's ranges: a power of two, at a multiple
    // of itself (a 512 KB piece starts at a multiple of 512 KB…), so the largest such piece within it
    const want = Math.max(UNIT, this.bytesFor(this.started ? STEP_SECONDS : this.startSeconds()));
    let size = MAX_PIECE;
    const free = (n: number) => this.runEnd(from + n - UNIT, true) === from + n - UNIT; // no part already asked for
    while (size > UNIT && (size > want || from % size || !free(size))) size /= 2;
    return { from, size };
  }

  /** Where the part the playing player has ends, in seconds (Infinity: it has the rest of the song). */
  private loadedEnd() {
    return this.view.end >= this.o.size ? Infinity : this.secondsAt(this.view.end);
  }

  /** Music to have before play starts: less on a network well faster than the music (this song's, or the last). */
  private startSeconds() {
    const bitrate = this.duration ? this.o.size / this.duration : GUESS_BITRATE;
    const speed = this.speed || lastSpeed;
    return speed * PARALLEL >= 3 * bitrate * this.o.rate() ? QUICK_START : START_SECONDS;
  }

  /** Bytes from the start to have before the first try. */
  private startBytes() {
    return Math.min(this.o.size, this.musicAt + this.bytesFor(this.startSeconds()));
  }

  /** After a wait: how much music to have ahead before going on (less on a fast network). */
  private resumeSeconds() {
    const bitrate = this.duration ? this.o.size / this.duration : 0;
    return bitrate && this.speed * PARALLEL >= 1.5 * bitrate * this.o.rate() ? RESUME_FAST : RESUME_SLOW;
  }

  /** More of the song came in: start, go on after a wait, or give the player a longer file. */
  private grow() {
    if (this.cancelled || this.opening) return;
    if (!this.started) {
      const got = this.runEnd(0);
      const enough = this.failures ? got >= this.retryAt : got >= this.startBytes();
      if (this.done || (!this.needWhole && enough)) this.open(0, true);
      return;
    }
    if (this.waitAt !== null) {
      const end = this.runEnd(this.bytesAt(this.waitAt));
      if (end >= this.o.size || end >= this.bytesAt(this.waitAt + this.resumeSeconds()) + SEEK_MARGIN)
        this.open(this.waitAt, true);
      return;
    }
    this.tick();
  }

  /**
   * Called with the player's updates too: the fetch looks again at the buffer, and the longer file is opened
   * before the part being played runs out.
   */
  tick() {
    this.wake();
    if (!this.started || this.opening || this.waitAt !== null) return;
    this.progress();
    const now = this.player.currentTime;
    const end = this.runEnd(this.bytesAt(now));
    const step = Math.min(MAX_STEP, Math.max(MIN_STEP, this.view.end - this.view.start));
    const near = now > this.loadedEnd() - LEAD_SECONDS;
    if (near && end > this.view.end && (end >= this.o.size || end >= this.view.end + step))
      return void this.open(null, this.player.playing);
    // the part the player has ends before the end of the file (after a jump ahead): stop there, not play the gap
    if (this.view.end < this.o.size && now >= this.loadedEnd() - 0.3 && this.player.playing) this.finished();
  }

  /**
   * The player reached the end of what it had: if the song is not all there, it waits for more (true: handled,
   * it is not the end of the song).
   */
  finished() {
    if (this.view.end >= this.o.size) return false;
    this.player.pause();
    this.waitAt = this.player.currentTime;
    this.o.onState("waiting");
    this.wake();
    this.grow();
    return true;
  }

  /**
   * A jump: at once inside the part the player has, on the other player inside the part fetched, else the fetch
   * moves there and play waits for it.
   */
  seek(seconds: number) {
    const s = Math.max(0, seconds);
    if (this.opening) {
      this.pendingSeek = s;
      return;
    }
    const b = this.bytesAt(s);
    const whole = this.view.start === 0 && this.view.end >= this.o.size;
    if (whole || (b >= this.view.start && b + SEEK_MARGIN <= this.view.end)) {
      this.waitAt = null;
      this.seekingTo = s;
      this.player
        .seekTo(s)
        .catch(() => {})
        .finally(() => {
          if (this.seekingTo === s) this.seekingTo = null;
        });
    } else if (this.runEnd(b) >= Math.min(this.o.size, b + SEEK_MARGIN)) {
      this.player.pause(); // not the old place while the other player opens the new one
      this.open(s, true);
    } else {
      this.player.pause();
      this.waitAt = s;
      this.o.onState("waiting");
    }
    this.wake();
    this.progress();
  }

  /**
   * Open the file as it is now, at `at` seconds (null: wherever the playing player is when the new one is ready).
   * The first time on the player of the song; after that on the other one, which takes over once it is ready.
   */
  private async open(at: number | null, play: boolean) {
    const first = !this.started;
    const target = first ? this.o.active() : 1 - this.o.active();
    const next = this.o.players[target];
    const from = this.bytesAt(at ?? (first ? 0 : this.player.currentTime));
    const view = { start: this.runStart(from), end: this.runEnd(from) }; // what the file has around there now
    this.opening = true;
    if (at !== null) {
      this.seekingTo = at;
      this.waitAt = null;
    }
    const failed = { error: null as string | null };
    const sub = next.addListener("playbackStatusUpdate", (st) => {
      if (st.error) failed.error = st.error;
    });
    const t0 = Date.now();
    log(
      `open ${first ? "first" : "swap"} at=${at ?? "live"} file=${(this.o.file.size / 1048576).toFixed(2)}MB run=${(view.start / 1048576).toFixed(2)}-${(view.end / 1048576).toFixed(2)}MB`,
    );
    next.replace({ uri: this.o.file.uri });
    const ok = await this.whenLoaded(next, failed);
    sub.remove();
    log(
      ok ? "opened" : "NOT opened",
      `${Date.now() - t0}ms isLoaded=${next.isLoaded} duration=${next.duration}`,
      failed.error ? `error=${failed.error}` : "",
    );
    if (this.cancelled) return;
    if (!ok) {
      this.opening = false;
      if (this.seekingTo === at) this.seekingTo = null;
      if (!first && at !== null) {
        // a jump: wait there, tried again with more fetched
        this.waitAt = at;
        this.o.onState("waiting");
      }
      if (!first) return this.afterOpen(); // the one playing goes on; tried again with the next piece
      if (view.end < this.o.size) {
        // not playable yet (a big cover art first, an index at the end…): try again with more, then fetch it all
        this.failures++;
        this.retryAt = view.end + RETRY_BYTES;
        this.needWhole = this.failures >= RETRIES;
        this.o.onState("fetching");
        this.wake();
        return this.grow();
      }
      return this.o.onState("error", new Error("Không phát được file này"));
    }
    const old = this.player;
    const pos = at ?? old.currentTime; // read now: the old player kept playing while the new one opened
    if (pos > 0.5) await next.seekTo(pos).catch(() => {});
    if (this.cancelled) return;
    next.setPlaybackRate(this.o.rate());
    // play unless paused by the user, or (taking over) unless the old one was paused (a call, the lock screen…)
    if (!this.paused && (first || at !== null ? play : old.playing || this.waitAt !== null)) next.play();
    if (!first) {
      old.pause();
      this.o.setActive(target);
    }
    this.view = view;
    this.waitAt = null;
    this.started = true;
    if (this.seekingTo === at) this.seekingTo = null;
    this.opening = false; // only now: a piece coming in during the seek must not open the file on `next` again
    this.o.onState("playing");
    this.afterOpen();
  }

  private afterOpen() {
    if (this.pendingSeek !== null) {
      const s = this.pendingSeek;
      this.pendingSeek = null;
      return this.seek(s);
    }
    this.wake();
    this.grow(); // more may have come in meanwhile
  }

  /** Whether a player opened the file (within ~8 s, unless it said it cannot). */
  private whenLoaded(player: AudioPlayer, failed: { error: string | null }, tries = 160) {
    return new Promise<boolean>((resolve) => {
      const check = (left: number) => {
        if (this.cancelled) return resolve(false);
        if (player.isLoaded && player.duration > 0) return resolve(true);
        if (left <= 0 || failed.error) return resolve(false);
        setTimeout(() => check(left - 1), 50);
      };
      check(tries);
    });
  }
}
