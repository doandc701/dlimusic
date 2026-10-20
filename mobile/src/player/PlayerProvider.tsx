// The player, like the web's dock: play a file of a list, previous / next, shuffle, repeat (off / all / one),
// speed. A song plays while it is fetched from Telegram (stream.ts: starts on the first 128 KB, like the web's
// streaming, on two players taking turns), from the cache if it was fetched before; tapping another one stops the fetch. Every song played goes
// to "Phát gần đây". A sleep timer ("Hẹn giờ ngủ", like YouTube's) pauses it after some minutes or at the end of the
// song.
// What changes several times a second (position, part fetched) is a store of its own (usePlayerClock), read by the
// dock only: the screens using the player (a chat's list…) do not draw again with it.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Asset } from "expo-asset";
import { createAudioPlayer, setAudioModeAsync } from "expo-audio";
import type { File } from "expo-file-system";
import { createContext, use, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { AppState, Platform } from "react-native";

import { authErrorText } from "../../../core.js";
import { MOCK } from "../mock";
import { useLibrary } from "../store/LibraryProvider";
import { chatById, type FileList, type Song } from "../telegram/library";
import { cacheFile } from "./cache";
import { prefetchHead, takeHead } from "./prefetch";
import { SongStream } from "./stream";

export const playable = (s: Song) => s.kind === "audio" || s.kind === "voice";
export type Repeat = "off" | "all" | "one";
/** The sleep timer: off, minutes (counted from when it was picked, across songs) or "song" (the end of this one). */
export type SleepMode = "off" | "song" | number;
export type Sleep = { mode: SleepMode; endsAt: number | null }; // endsAt: Date.now() deadline of a minutes timer
const FADE_MS = 10_000; // a minutes timer fades the volume down over its last 10 s, then pauses

export type NowPlaying = {
  song: Song;
  list: FileList;
  phase: "fetching" | "ready" | "error"; // fetching: before the first sound
  waiting?: boolean; // playing, but waiting for the part of the song it needs
  error?: string;
};

type PlayerApi = {
  now: NowPlaying | null;
  playing: boolean;
  play: (list: FileList, song: Song) => void;
  toggle: () => void;
  seekTo: (seconds: number) => void;
  seekBy: (seconds: number) => void;
  next: (step?: 1 | -1) => void;
  shuffle: boolean;
  setShuffle: (on: boolean) => void;
  repeat: Repeat;
  setRepeat: (r: Repeat) => void;
  speed: number;
  setSpeed: (rate: number) => void;
  sleep: Sleep;
  setSleep: (mode: SleepMode) => void;
};

const PlayerContext = createContext<PlayerApi | null>(null);
export const usePlayer = () => use(PlayerContext)!;

// two players: while one plays, the other opens the longer file (stream.ts) and then takes over.
// keepAudioSessionActive: on iOS a player that pauses or reaches the end of what it has turns the app's audio off
// 0.1 s later when nothing is playing — which is the case for a moment at each take-over, and while waiting for
// more of the song; with the screen locked the app may not turn it on again, so the music stopped.
const players = [
  createAudioPlayer(null, { updateInterval: 250, keepAudioSessionActive: true }),
  createAudioPlayer(null, { updateInterval: 250, keepAudioSessionActive: true }),
] as [ReturnType<typeof createAudioPlayer>, ReturnType<typeof createAudioPlayer>];
let activeIndex = 0;

/**
 * The audio session: plays with the silent switch on, goes on in the background / with the screen locked, pauses
 * other apps' sound. Set at start, and again before each song, each "play" and each time the app leaves the
 * front — a failure is logged, not ignored.
 */
function audioMode() {
  return setAudioModeAsync({
    playsInSilentMode: true,
    shouldPlayInBackground: true,
    interruptionMode: "doNotMix",
  }).catch((err) => __DEV__ && console.log("[player] setAudioModeAsync failed:", String(err)));
}

// the lock screen's picture: DLiMusic's logo, 768 px (made sharp from the web's 192 px one), as a file the
// system can read
let artwork: string | null = null;
if (Platform.OS !== "web")
  Asset.fromModule(require("@/assets/images/lockscreen-artwork.jpg"))
    .downloadAsync()
    .then((a) => (artwork = a.localUri ?? a.uri))
    .catch(() => {});
const player = () => players[activeIndex]; // the one playing

type Clock = { currentTime: number; duration: number; progress: number }; // progress: 0..1 fetched (from the position)
let clock: Clock = { currentTime: 0, duration: 0, progress: 0 };
const clockListeners = new Set<() => void>();
function setClock(c: Partial<Clock>) {
  const n = { ...clock, ...c };
  if (n.currentTime === clock.currentTime && n.duration === clock.duration && n.progress === clock.progress) return;
  clock = n;
  clockListeners.forEach((l) => l());
}
/** Position, length and part fetched of the song playing (the dock's seek bar and times). */
export function usePlayerClock() {
  return useSyncExternalStore(
    (l) => {
      clockListeners.add(l);
      return () => clockListeners.delete(l);
    },
    () => clock,
  );
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const [isPlaying, setPlaying] = useState(false);
  const opened = useRef(false); // the song is in the player (before: the player still has the previous one)
  const heldUntil = useRef(0); // after a tap on play / pause: its state is shown, not the player's late updates
  const library = useLibrary();
  const [now, setNow] = useState<NowPlaying | null>(null);
  const [shuffle, setShuffleState] = useState(false);
  const [repeat, setRepeatState] = useState<Repeat>("off");
  const [speed, setSpeedState] = useState(1);
  const speedRef = useRef(1);
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);
  const token = useRef(0);
  const stream = useRef<SongStream | null>(null);
  const upcoming = useRef<string | null>(null); // with shuffle: the next song, picked ahead so it can be prefetched
  const playing = MOCK ? !!now : isPlaying; // the sample screens: a song "playing" at its start
  const [sleep, setSleepState] = useState<Sleep>({ mode: "off", endsAt: null });
  const fadeFrom = useRef<number | null>(null); // the volume before the fade (null: not fading)
  // checked on each update of the player, on each change of AppState and every 250 ms while a minutes timer runs:
  // timers alone may be late or stopped with the screen locked, the deadline is the wall clock's
  const sleepCheck = useRef(() => {});

  useEffect(() => {
    audioMode();
    // leaving the app / locking the screen: said again just before (another module of Expo Go may have changed
    // the shared audio session meanwhile; the music is paused on going to the background unless it is set)
    const sub = AppState.addEventListener("change", (s) => {
      if (s !== "active") audioMode();
      sleepCheck.current();
    });
    AsyncStorage.multiGet(["speed", "shuffle", "repeat"])
      .then(([[, sp], [, sh], [, rp]]) => {
        const rate = Number(sp);
        if (rate >= 0.5 && rate <= 2) {
          setSpeedState(rate);
          for (const p of players) p.setPlaybackRate(rate);
        }
        setShuffleState(sh === "1");
        if (rp === "all" || rp === "one") setRepeatState(rp);
      })
      .catch(() => {});
    return () => sub.remove();
  }, []);

  function play(list: FileList, song: Song) {
    if (!playable(song)) return;
    ++token.current;
    for (const p of players) p.pause();
    audioMode();
    opened.current = false;
    setPlaying(false);
    setClock({ currentTime: 0, duration: song.duration ?? 0, progress: 0 });
    setNow({ song, list, phase: "fetching" });
    library.addRecent({
      id: song.key,
      name: song.name,
      title: song.title,
      performer: song.performer,
      chat: song.chat ?? chatById(song.chatId)?.title ?? "",
      chatId: song.chatId,
      duration: song.duration,
      size: song.size,
    });
    if (MOCK) {
      setClock({ progress: 1 });
      return setNow({ song, list, phase: "ready" });
    }
    stream.current?.cancel();
    const msg = list.message(song.id);
    if (!msg?.media) return setNow({ song, list, phase: "error", error: "Không tìm thấy tin nhắn của bài này" });
    let file: File;
    try {
      file = cacheFile(song);
    } catch (err) {
      return setNow({ song, list, phase: "error", error: authErrorText(err) });
    }
    const mine = token.current;
    const live = () => token.current === mine;
    const s = new SongStream({
      players,
      active: () => activeIndex,
      setActive: (i) => {
        activeIndex = i;
        setClock({ currentTime: players[i].currentTime, duration: players[i].duration });
      },
      file,
      size: song.size,
      duration: song.duration,
      media: msg.media,
      head: takeHead(song.key),
      rate: () => speedRef.current,
      onProgress: (progress) => live() && setClock({ progress }),
      onState: (state, err) => {
        if (!live()) return;
        if (state === "error") return setNow((n) => n && { ...n, phase: "error", error: authErrorText(err) });
        setNow((n) => n && { ...n, phase: state === "fetching" ? "fetching" : "ready", waiting: state === "waiting" });
        if (state === "playing") {
          opened.current = true;
          setClock({ currentTime: player().currentTime, duration: player().duration });
          prefetchNext(list, song);
          try {
            // (again at each take-over: the lock screen follows the player playing)
            player().setActiveForLockScreen(true, {
              title: song.title || song.name,
              artist: song.performer || song.chat || chatById(song.chatId)?.title,
              artworkUrl: artwork ?? undefined,
            });
          } catch {}
        }
      },
    });
    stream.current = s;
    s.start().catch((err) => live() && setNow((n) => n && { ...n, phase: "error", error: authErrorText(err) }));
  }

  /** The song "next" would play after `song` (with shuffle: picked now and kept), or null. */
  function pickNext(list: FileList, song: Song): Song | null {
    const songs = list.songs.filter(playable);
    if (!songs.length) return null;
    if (shuffle && songs.length > 1) {
      const kept = songs.find((s) => s.key === upcoming.current && s.key !== song.key);
      if (kept) return kept;
      const others = songs.filter((s) => s.key !== song.key);
      const pick = others[Math.floor(Math.random() * others.length)];
      upcoming.current = pick.key;
      return pick;
    }
    const i = songs.findIndex((s) => s.key === song.key);
    return songs[(i + 1) % songs.length] ?? null;
  }

  /** Fetch the first piece of the song that comes next, so "next" (or the end of this one) sounds at once. */
  function prefetchNext(list: FileList, song: Song) {
    const n = pickNext(list, song);
    if (n && n.key !== song.key) prefetchHead(n.key, list.message(n.id)?.media, n.size);
  }

  /** Pause / play as the button does (also what the sleep timer pauses with). */
  function setPaused(paused: boolean) {
    heldUntil.current = Date.now() + 1000;
    setPlaying(!paused);
    stream.current?.setPaused(paused);
    if (!opened.current) return; // not in the player yet: it starts paused / playing as asked
    if (!paused) {
      audioMode();
      player().play();
    } else player().pause();
  }

  /** The volume as it was before the fade, on both players (the next play is at the usual volume). */
  function unfade() {
    if (fadeFrom.current === null) return;
    for (const p of players) p.volume = fadeFrom.current;
    fadeFrom.current = null;
  }

  function setSleep(mode: SleepMode) {
    unfade();
    setSleepState({ mode, endsAt: typeof mode === "number" ? Date.now() + mode * 60_000 : null });
  }

  /** A minutes timer: fade over its last seconds, then pause (nothing playing: just off). */
  function checkSleep() {
    if (typeof sleep.mode !== "number" || sleep.endsAt === null) return;
    const left = sleep.endsAt - Date.now();
    if (left <= 0) {
      // (also while it is fetched / waiting: it would start then; already paused, it stays so)
      if (now) setPaused(true);
      return setSleep("off"); // after the pause: the volume back for the next play
    }
    if (left > FADE_MS || !player().playing) return;
    if (fadeFrom.current === null) fadeFrom.current = player().volume;
    for (const p of players) p.volume = fadeFrom.current * (left / FADE_MS); // both: a take-over keeps it
  }
  useEffect(() => {
    sleepCheck.current = checkSleep;
  });
  useEffect(() => {
    if (sleep.endsAt === null) return;
    const id = setInterval(() => sleepCheck.current(), 250);
    return () => clearInterval(id);
  }, [sleep.endsAt]);

  /** The next / previous playable song of the list (random with shuffle; wraps with repeat all). */
  function next(step: 1 | -1 = 1, ended = false) {
    if (!now) return;
    if (ended && sleep.mode === "song") {
      // "Hết bài này": stop here (not the next one, nor this one again with repeat one), at its start for a replay
      setPaused(true);
      setClock({ currentTime: 0 });
      if (stream.current) stream.current.seek(0);
      else player().seekTo(0);
      return setSleep("off");
    }
    if (ended && repeat === "one") {
      player().seekTo(0);
      player().play();
      return;
    }
    const songs = now.list.songs.filter(playable);
    if (!songs.length) return;
    if (shuffle && songs.length > 1) {
      const pick = pickNext(now.list, now.song)!;
      upcoming.current = null;
      return play(now.list, pick);
    }
    const i = songs.findIndex((s) => s.key === now.song.key);
    let j = i + step;
    if (j < 0 || j >= songs.length) {
      if (repeat !== "all" && ended) return;
      j = (j + songs.length) % songs.length;
    }
    play(now.list, songs[j]);
  }

  // a song that ends moves on (repeat one: plays it again)
  const nextRef = useRef(next);
  useEffect(() => {
    nextRef.current = next;
  });
  useEffect(() => {
    const subs = players.map((p, i) =>
      p.addListener("playbackStatusUpdate", (s) => {
        if (i !== activeIndex) return; // the other one, opening the longer file or put aside
        sleepCheck.current();
        // a jump on its way: its place, not the one the player still says (the bar stays where it was dragged)
        if (opened.current) setClock({ currentTime: stream.current?.target() ?? s.currentTime, duration: s.duration });
        if (Date.now() > heldUntil.current) setPlaying(s.playing);
        if (s.didJustFinish) {
          // the end of the part fetched so far is not the end of the song
          if (stream.current?.finished()) return;
          nextRef.current(1, true);
        } else stream.current?.tick();
      }),
    );
    return () => subs.forEach((sub) => sub.remove());
  }, []);

  const api: PlayerApi = {
    now,
    playing,
    play,
    toggle: () => setPaused(playing),
    seekTo: (s) => {
      setClock({ currentTime: Math.max(0, s) }); // there at once, while it is fetched / opened
      if (stream.current) stream.current.seek(s);
      else player().seekTo(Math.max(0, s));
    },
    seekBy: (s) => {
      const d = now?.song.duration || clock.duration || 0;
      const to = Math.max(0, Math.min(d - 1, clock.currentTime + s));
      setClock({ currentTime: to });
      if (stream.current) stream.current.seek(to);
      else player().seekTo(to);
    },
    next: (step) => next(step),
    shuffle,
    setShuffle: (on) => {
      setShuffleState(on);
      AsyncStorage.setItem("shuffle", on ? "1" : "0").catch(() => {});
    },
    repeat,
    setRepeat: (r) => {
      setRepeatState(r);
      AsyncStorage.setItem("repeat", r).catch(() => {});
    },
    speed,
    setSpeed: (rate) => {
      setSpeedState(rate);
      for (const p of players) p.setPlaybackRate(rate);
      AsyncStorage.setItem("speed", String(rate)).catch(() => {});
    },
    sleep,
    setSleep,
  };
  return <PlayerContext value={api}>{children}</PlayerContext>;
}
