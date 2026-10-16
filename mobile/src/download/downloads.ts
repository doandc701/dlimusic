// "Tải xuống": the files ticked go to a folder chosen once (the system's folder picker, remembered — like the web's
// download folder), one after another. A song already whole in the cache (played to the end) is copied from there;
// the others are fetched from Telegram into the cache first (so they then play from the phone too). A file of the
// same name already in the folder is skipped ("đã có").
// Runs while the app is open (a phone puts an app in the background to sleep after a while).
import AsyncStorage from "@react-native-async-storage/async-storage";
import bigInt from "big-integer";
import { Directory, File, FileMode, Paths } from "expo-file-system";
import { useSyncExternalStore } from "react";
import type { Api } from "telegram";

import { authErrorText } from "../../../core.js";
import { cacheFile, cachedWhole } from "../player/cache";
import { getClient } from "../telegram/client";
import type { Song } from "../telegram/library";

const PIECE = 512 * 1024; // the largest piece Telegram gives
const SHOW_MS = 300; // the progress shown at most this often

export type JobStatus = "queued" | "downloading" | "done" | "failed";
export type Job = {
  key: string;
  name: string; // the file's name in the folder
  size: number;
  received: number;
  status: JobStatus;
  error?: string;
  song: Song;
  media: Api.TypeMessageMedia;
};

type State = {
  jobs: Job[]; // this session's downloads, in order
  dir: string | null; // the folder's URI
  dirName: string | null;
};

let state: State = { jobs: [], dir: null, dirName: null };
const listeners = new Set<() => void>();
function set(s: Partial<State>) {
  state = { ...state, ...s };
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The whole download state (the bar at the top of a chat's list, Cài đặt). */
export function useDownloads() {
  return useSyncExternalStore(subscribe, () => state);
}

// where to (chosen before)
const loaded = AsyncStorage.getItem("downloadDir")
  .then((dir) => set({ dir: dir || null, dirName: dir ? folderName(dir) : null }))
  .catch(() => {});

function folderName(uri: string) {
  // a picked Android folder is "content://…/tree/primary%3AMusic%2FDLiMusic": its last part, decoded
  const last = decodeURIComponent(uri.replace(/\/+$/, "").split("/").pop() ?? "");
  return last.split(":").pop() || last || uri;
}

/** Ask where downloads go (the system's folder picker); false if none was chosen. */
export async function chooseFolder() {
  try {
    const dir = await Directory.pickDirectoryAsync(state.dir ?? undefined);
    if (!dir?.uri) return false;
    set({ dir: dir.uri, dirName: folderName(dir.uri) });
    AsyncStorage.setItem("downloadDir", dir.uri).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** The folder chosen, still there and writable (an iPhone forgets the access after the app restarts): else ask. */
async function folder() {
  await loaded;
  if (state.dir) {
    try {
      const dir = new Directory(state.dir);
      if (dir.exists) return dir;
    } catch {}
  }
  if (!(await chooseFolder())) return null;
  return new Directory(state.dir!);
}

/** A name a folder takes ("a/b.mp3" → "a_b.mp3"). */
const safeName = (name: string) => name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim() || "file";

/**
 * Download these files (with their message's media) into the folder (asked the first time). Returns how many
 * were queued and how many were there already, or null if no folder was chosen.
 */
export async function download(items: { song: Song; media?: Api.TypeMessageMedia }[]) {
  const dir = await folder();
  if (!dir) return null;
  let names: Set<string>;
  try {
    names = new Set(dir.list().map((e) => e.name));
  } catch {
    names = new Set();
  }
  let added = 0;
  let already = 0;
  const jobs = [...state.jobs];
  for (const { song, media } of items) {
    const name = safeName(song.name);
    const busy = jobs.some((j) => j.key === song.key && (j.status === "queued" || j.status === "downloading"));
    if (busy) continue;
    if (names.has(name)) {
      already++;
      continue;
    }
    if (!media) continue;
    jobs.push({ key: song.key, name, size: song.size, received: 0, status: "queued", song, media });
    added++;
  }
  set({ jobs });
  run();
  return { added, already };
}

/** Stop the downloads waiting and the one on its way. */
export function cancelAll() {
  cancelled = true;
  set({ jobs: state.jobs.filter((j) => j.status === "done" || j.status === "failed") });
}

/** Forget the finished ones of the bar (done / failed). */
export function clearFinished() {
  set({ jobs: state.jobs.filter((j) => j.status === "queued" || j.status === "downloading") });
}

function update(key: string, change: Partial<Job>) {
  set({
    jobs: state.jobs.map((j) =>
      j.key === key && (j.status === "queued" || j.status === "downloading") ? { ...j, ...change } : j,
    ),
  });
}

let running = false;
let cancelled = false;

/** One file after another, while some are waiting. */
async function run() {
  if (running) return;
  running = true;
  cancelled = false;
  try {
    for (;;) {
      const job = state.jobs.find((j) => j.status === "queued");
      if (!job) break;
      update(job.key, { status: "downloading" });
      try {
        await save(job);
        if (cancelled) break;
        update(job.key, { status: "done", received: job.size });
      } catch (err) {
        if (cancelled) break;
        update(job.key, { status: "failed", error: authErrorText(err) });
      }
    }
  } finally {
    running = false;
    // something queued while the last one was being cancelled
    if (state.jobs.some((j) => j.status === "queued")) run();
  }
}

/** Get the whole file in the cache, then copy it into the folder under its name. */
async function save(job: Job) {
  const { song } = job;
  const whole = cachedWhole(song);
  const source = whole ? cacheFile(song) : await fetchWhole(job);
  if (!source || cancelled) return;
  const mime = (job.media as { document?: { mimeType?: string } }).document?.mimeType || "application/octet-stream";
  try {
    const dest = new Directory(state.dir!).createFile(job.name, mime);
    await source.copy(dest, { overwrite: true });
  } catch {
    // the folder is gone, or no longer allowed (an iPhone forgets it once the app restarts): asked again next time
    set({ dir: null, dirName: null });
    AsyncStorage.removeItem("downloadDir").catch(() => {});
    if (!whole) source.delete();
    throw new Error("Không ghi được vào thư mục đã chọn — bấm Tải xuống lại để chọn thư mục");
  }
  if (!whole) {
    // into the cache too (it then plays from the phone), unless a part of it is there already, being played
    const cached = cacheFile(song);
    if (!cached.exists) source.move(cached);
    else source.delete();
  }
}

/** Fetch the whole file from Telegram into a file of its own (not the cache file a song playing writes to). */
async function fetchWhole(job: Job) {
  const tmpDir = new Directory(Paths.cache, "downloads");
  if (!tmpDir.exists) tmpDir.create({ intermediates: true, idempotent: true });
  const tmp = new File(tmpDir, `${job.song.chatId}_${job.song.id}_${job.name}`);
  tmp.create({ overwrite: true });
  const handle = tmp.open(FileMode.ReadWrite);
  let received = 0;
  let shownAt = 0;
  try {
    const client = await getClient();
    for await (const chunk of client.iterDownload({
      file: job.media as never,
      requestSize: PIECE,
      fileSize: bigInt(job.size),
    })) {
      if (cancelled) break;
      handle.writeBytes(new Uint8Array(chunk)); // a copy: a Buffer can be a slice of a larger block
      received += chunk.length;
      if (Date.now() - shownAt > SHOW_MS) {
        shownAt = Date.now();
        update(job.key, { received });
      }
    }
  } finally {
    handle.close();
  }
  if (cancelled) {
    tmp.delete();
    return null;
  }
  if (job.size && received < job.size) {
    tmp.delete();
    throw new Error("Tải chưa đủ file");
  }
  return tmp;
}
