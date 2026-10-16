// Where a song is kept on the phone once fetched (played or downloaded): the app's cache, "<chat>_<message>.<ext>".
import { Directory, File, Paths } from "expo-file-system";
import { Platform } from "react-native";

import { extname } from "../../../core.js";
import type { Song } from "../telegram/library";

let songsDir: Directory | null = null; // made on first use: expo-file-system has no web version, and a
// Directory built while the module loads crashed the whole app there

export function cacheFile(song: Song) {
  if (Platform.OS === "web") throw new Error("Phát nhạc chỉ có trong app trên điện thoại");
  songsDir ??= new Directory(Paths.cache, "songs");
  if (!songsDir.exists) songsDir.create({ intermediates: true });
  const ext = extname(song.name) || ".mp3"; // iOS picks the decoder from the extension
  return new File(songsDir, `${song.chatId}_${song.id}${ext}`);
}

/** Whether the whole song is in the cache (no map of pieces still missing). */
export function cachedWhole(song: Song) {
  const f = cacheFile(song);
  return f.exists && !new File(f.uri + ".map").exists && f.size === song.size;
}
