// The playlists' pieces shared by the screens (like the web's): a cover made of the pictures of the chats of the
// first songs (2x2, or one big picture when fewer than 4 chats), the sheet asking a playlist's name, and the sheet
// adding songs to a playlist (or to a new one).
import { LinearGradient } from "expo-linear-gradient";
import { useState } from "react";
import { FlatList, Image, Pressable, StyleSheet, TextInput, View } from "react-native";

import { useT } from "../i18n";
import { useLibrary, type Playlist } from "../store/LibraryProvider";
import { useAvatar } from "../telegram/avatars";
import type { Chat } from "../telegram/library";
import { useChats } from "../telegram/useChats";
import { FONT, GRADIENT, useTheme } from "../theme";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";
import { useToast } from "./Toast";
import { Badge, GradientButton, T, colorFor, haptic, initialOf } from "./ui";

const NAME_MAX = 80; // core.js PLAYLIST_NAME_MAX

/** Why a playlist name cannot be used ("" when it can) — the same rules as core.js (`except`: its own playlist). */
export function playlistNameError(name: string, playlists: Playlist[], except: string | null = null) {
  const n = name.trim();
  if (!n) return "Hãy đặt tên cho playlist";
  if (playlists.some((p) => p.id !== except && p.name.trim().toLocaleLowerCase() === n.toLocaleLowerCase()))
    return "Đã có playlist trùng tên";
  return "";
}

/** The chats of a playlist's first songs (different ones, at most 4), among the account's chats. */
function coverChats(p: Playlist, all: Chat[]) {
  const byRaw = new Map(all.map((c) => [c.rawId, c]));
  const chats: Chat[] = [];
  for (const song of p.songs) {
    const c = byRaw.get(song.split("|")[0]);
    if (c && !chats.includes(c)) chats.push(c);
    if (chats.length === 4) break;
  }
  return chats;
}

/** A chat's picture filling a square (its letter on its colour until the picture is there). */
function Tile({ chat, size }: { chat: Chat; size: number }) {
  const uri = useAvatar(chat.id, chat.photo);
  return (
    <View
      style={{
        width: size,
        height: size,
        backgroundColor: colorFor(chat.id),
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <T weight="semibold" size={size * 0.42} color="#fff">
        {initialOf(chat.title)}
      </T>
      {uri && <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" fadeDuration={0} />}
    </View>
  );
}

export function PlaylistCover({ playlist, size, radius = 10 }: { playlist: Playlist; size: number; radius?: number }) {
  // the account's chats (read once, shared): drawn again when they come in
  const chats = coverChats(playlist, useChats().chats ?? []);
  const box = { width: size, height: size, borderRadius: radius, overflow: "hidden" as const };
  if (!chats.length)
    return (
      <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[box, styles.center]}>
        <Icon name="music-note-list" size={size * 0.38} color="rgba(255,255,255,0.92)" />
      </LinearGradient>
    );
  if (chats.length < 4)
    return (
      <View style={box}>
        <Tile chat={chats[0]} size={size} />
      </View>
    );
  return (
    <View style={[box, styles.grid]}>
      {chats.map((c) => (
        <Tile key={c.id} chat={c} size={size / 2} />
      ))}
    </View>
  );
}

/** "Tạo playlist mới" / "Đổi tên playlist": a name, then Lưu. */
export function NameSheet({
  open,
  title,
  initial = "",
  except = null,
  onClose,
  onSave,
}: {
  open: boolean;
  title: string;
  initial?: string;
  except?: string | null; // the playlist being renamed
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const t = useTheme();
  const tr = useT();
  const { playlists } = useLibrary();
  // a new value each time it opens (the sheet stays mounted)
  const [draft, setDraft] = useState<{ for: string; name: string } | null>(null);
  const key = `${open}|${initial}`;
  const typed = draft?.for === key; // the reason shows once something is typed (or Lưu pressed)
  const [tried, setTried] = useState("");
  const name = typed ? draft.name : initial;
  const error = playlistNameError(name, playlists, except);
  const unchanged = except !== null && name.trim() === initial.trim();
  const save = () => {
    setTried(key);
    if (error || unchanged) return;
    haptic();
    onSave(name.trim());
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      icon="music-note-list"
      bottom
      footer={
        <GradientButton
          title={tr("Lưu")}
          icon="check-lg"
          radius={999}
          height={42}
          onPress={save}
          disabled={!!error || unchanged}
        />
      }
    >
      <TextInput
        allowFontScaling={false}
        value={name}
        onChangeText={(v) => setDraft({ for: key, name: v })}
        placeholder={tr("Tên playlist")}
        placeholderTextColor={t.textMuted}
        maxLength={NAME_MAX}
        autoFocus
        returnKeyType="done"
        onSubmitEditing={save}
        style={[styles.input, { color: t.text, borderColor: error && (typed || tried === key) ? t.coral : t.border }]}
      />
      <View style={styles.hint}>
        <T size={12.5} color={t.coral} style={{ flex: 1 }}>
          {error && (typed || tried === key) ? tr(error) : ""}
        </T>
        <T size={12} muted>
          {name.trim().length}/{NAME_MAX}
        </T>
      </View>
    </Sheet>
  );
}

/**
 * "Thêm vào playlist": the playlists (one tap adds the songs) and a name for a new one. `onDone(true)`: songs were
 * added (the list unticks what was ticked).
 */
export function PlaylistPicker({
  songs,
  open,
  onDone,
}: {
  songs: string[];
  open: boolean;
  onDone: (added: boolean) => void;
}) {
  const t = useTheme();
  const tr = useT();
  const toast = useToast();
  const { playlists, editPlaylist } = useLibrary();
  const [draft, setDraft] = useState<{ for: string; name: string } | null>(null);
  const key = `${open}|${songs.join(",")}`;
  const name = draft?.for === key ? draft.name : "";
  const [tried, setTried] = useState("");
  const nameError = playlistNameError(name, playlists);
  const showError = !!nameError && (!!name.trim() || tried === key); // not on an empty field never used

  const add = (p: Playlist) => {
    haptic();
    const fresh = songs.filter((k) => !p.songs.includes(k)).length;
    const r = editPlaylist({ op: "add", id: p.id, songs });
    if (r.error) return toast(tr(r.error), "error");
    toast(
      fresh < songs.length
        ? tr("Đã thêm {n} bài vào “{name}” ({m} bài đã có sẵn)", { n: fresh, name: p.name, m: songs.length - fresh })
        : tr("Đã thêm {n} bài vào “{name}”", { n: fresh, name: p.name }),
    );
    onDone(true);
  };
  const create = () => {
    setTried(key);
    const n = name.trim();
    if (nameError) return;
    haptic();
    const r = editPlaylist({ op: "create", name: n, songs });
    if (r.error) return toast(tr(r.error), "error");
    toast(tr("Đã tạo playlist “{name}” với {n} bài", { name: n, n: songs.length }));
    onDone(true);
  };

  return (
    <Sheet
      open={open}
      onClose={() => onDone(false)}
      title={songs.length === 1 ? tr("Thêm vào playlist") : tr("Thêm {n} bài vào playlist", { n: songs.length })}
      icon="music-note-list"
      bottom
    >
      <View style={styles.newRow}>
        <TextInput
          allowFontScaling={false}
          value={name}
          onChangeText={(v) => setDraft({ for: key, name: v })}
          placeholder={tr("Tên playlist mới…")}
          placeholderTextColor={t.textMuted}
          maxLength={80}
          returnKeyType="done"
          onSubmitEditing={create}
          style={[styles.input, { flex: 1, color: t.text, borderColor: showError ? t.coral : t.border }]}
        />
        <GradientButton
          title={tr("Tạo & thêm")}
          icon="plus-lg"
          radius={999}
          height={40}
          size={14}
          onPress={create}
          disabled={!!nameError}
        />
      </View>
      {showError && (
        <T size={12.5} color={t.coral} style={{ marginTop: -4 }}>
          {tr(nameError)}
        </T>
      )}
      <FlatList
        data={playlists}
        keyExtractor={(p) => p.id}
        style={{ marginHorizontal: -16, maxHeight: 360 }}
        ListEmptyComponent={
          <T size={13} muted style={{ textAlign: "center", padding: 20 }}>
            {tr("Chưa có playlist nào. Đặt tên ở trên để tạo playlist đầu tiên.")}
          </T>
        }
        renderItem={({ item: p }) => {
          const all = songs.every((k) => p.songs.includes(k));
          return (
            <Pressable
              onPress={() => !all && add(p)}
              disabled={all}
              style={({ pressed }) => [
                styles.pick,
                { borderTopColor: t.border, backgroundColor: pressed ? t.bg : "transparent" },
              ]}
              accessibilityRole="button"
              accessibilityLabel={p.name}
            >
              <PlaylistCover playlist={p} size={44} radius={7} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <T weight="semibold" numberOfLines={1} color={all ? t.textMuted : undefined}>
                  {p.name}
                </T>
                <T size={12.5} muted>
                  {tr("{n} bài", { n: p.songs.length })}
                </T>
              </View>
              {all ? (
                <Badge text={tr("Đã có")} color={t.green} textColor="#fff" />
              ) : (
                <Icon name="plus-lg" size={16} color={t.textMuted} />
              )}
            </Pressable>
          );
        }}
      />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center" },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  input: { height: 42, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, fontSize: 16, fontFamily: FONT.regular },
  newRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  hint: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 },
  pick: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
