// "Playlist" (like Zing MP3's, and the web's): a grid of the account's playlists, "Tạo playlist mới" first. A card
// opens its songs (the chat screen with id "pl:<id>"); ⋯ plays it, shuffles it, renames or deletes it.
import { router } from "expo-router";
import { useState } from "react";
import { Alert, FlatList, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";

import { Icon } from "@/components/Icon";
import { NameSheet, PlaylistCover } from "@/components/Playlists";
import { Sheet } from "@/components/Sheet";
import { useToast } from "@/components/Toast";
import { RoundButton, T, haptic } from "@/components/ui";
import { useT } from "@/i18n";
import { playable, usePlayer } from "@/player/PlayerProvider";
import { useLibrary, type Playlist } from "@/store/LibraryProvider";
import { FavoritesScan } from "@/telegram/library";
import { useTheme } from "@/theme";

/** One of them, at random (the shuffled start of a playlist). */
const anyOf = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)];
const GAP = 14;
const PAD = 16;

export default function Playlists() {
  const t = useTheme();
  const tr = useT();
  const toast = useToast();
  const { width } = useWindowDimensions();
  const { playlists, editPlaylist } = useLibrary();
  const { play, shuffle: shuffling, setShuffle } = usePlayer();
  const [naming, setNaming] = useState<{ id: string | null; name: string } | null>(null); // id null: a new one
  const [menu, setMenu] = useState<Playlist | null>(null);
  const cols = width >= 700 ? 4 : width >= 520 ? 3 : 2;
  const card = (width - PAD * 2 - GAP * (cols - 1)) / cols;

  const open = (p: Playlist) => router.push({ pathname: "/chat/[id]", params: { id: `pl:${p.id}` } });

  /** Its songs read from Telegram, then the first one (or a random one) plays. */
  async function playAll(p: Playlist, shuffle = false) {
    const list = new FavoritesScan(p.songs, "playlist", p.id);
    try {
      await list.next();
    } catch (err) {
      return toast(String((err as Error)?.message ?? err), "error");
    }
    const songs = list.songs.filter(playable);
    if (!songs.length) return toast(tr("Playlist chưa có bài nào"), "info");
    if (shuffle && !shuffling) setShuffle(true); // the next songs at random too
    play(list, shuffle ? anyOf(songs) : songs[0]);
  }

  function remove(p: Playlist) {
    Alert.alert(
      tr("Xoá playlist"),
      tr("Xoá playlist “{name}”? Các bài hát vẫn còn trong kênh của chúng.", { name: p.name }),
      [
        { text: tr("Huỷ"), style: "cancel" },
        {
          text: tr("Xoá"),
          style: "destructive",
          onPress: () => {
            const r = editPlaylist({ op: "delete", id: p.id });
            if (r.error) toast(tr(r.error), "error");
            else toast(tr("Đã xoá playlist “{name}”", { name: p.name }), "info");
          },
        },
      ],
    );
  }

  function saveName(name: string) {
    if (!naming) return;
    const r = naming.id ? editPlaylist({ op: "rename", id: naming.id, name }) : editPlaylist({ op: "create", name });
    if (r.error) return toast(tr(r.error), "error");
    toast(naming.id ? tr("Đã đổi tên playlist") : tr("Đã tạo playlist “{name}”", { name }));
    setNaming(null);
  }

  const data: (Playlist | "new")[] = ["new", ...playlists];
  return (
    <View style={{ flex: 1, backgroundColor: t.surface }}>
      <View style={[styles.head, { borderBottomColor: t.border }]}>
        <RoundButton
          icon="chevron-left"
          color={t.violet}
          label={tr("Danh sách kênh")}
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/chats"))}
        />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T weight="semibold" size={20} numberOfLines={1}>
            {tr("Playlist")}
          </T>
          <T size={13} muted>
            {tr("{n} playlist", { n: playlists.length })}
          </T>
        </View>
      </View>
      <FlatList
        key={cols} // a new number of columns needs a new list
        data={data}
        numColumns={cols}
        keyExtractor={(p) => (p === "new" ? "new" : p.id)}
        contentContainerStyle={{ padding: PAD, gap: 18 }}
        columnWrapperStyle={{ gap: GAP }}
        renderItem={({ item }) =>
          item === "new" ? (
            <Pressable
              onPress={() => {
                haptic();
                setNaming({ id: null, name: "" });
              }}
              style={{ width: card }}
              accessibilityRole="button"
              accessibilityLabel={tr("Tạo playlist mới")}
            >
              <View style={[styles.newBox, { width: card, height: card, borderColor: t.border }]}>
                <Icon name="plus-circle" size={card * 0.24} color={t.text} />
                <T size={13.5} style={{ textAlign: "center" }}>
                  {tr("Tạo playlist mới")}
                </T>
              </View>
            </Pressable>
          ) : (
            <Pressable
              onPress={() => {
                haptic();
                open(item);
              }}
              onLongPress={() => {
                haptic();
                setMenu(item);
              }}
              style={{ width: card }}
              accessibilityRole="button"
              accessibilityLabel={item.name}
            >
              <View>
                <PlaylistCover playlist={item} size={card} />
                <Pressable
                  onPress={() => {
                    haptic();
                    setMenu(item);
                  }}
                  hitSlop={8}
                  style={styles.more}
                  accessibilityRole="button"
                  accessibilityLabel={tr("Tuỳ chọn")}
                >
                  <Icon name="three-dots" size={16} color="#fff" />
                </Pressable>
              </View>
              <T weight="semibold" numberOfLines={1} style={{ marginTop: 7 }}>
                {item.name}
              </T>
              <T size={12.5} muted>
                {tr("{n} bài", { n: item.songs.length })}
              </T>
            </Pressable>
          )
        }
      />

      <NameSheet
        open={naming !== null}
        title={tr(naming?.id ? "Đổi tên playlist" : "Tạo playlist mới")}
        initial={naming?.name ?? ""}
        except={naming?.id ?? null}
        onClose={() => setNaming(null)}
        onSave={saveName}
      />

      <Sheet open={menu !== null} onClose={() => setMenu(null)} title={menu?.name ?? ""} icon="music-note-list" bottom>
        {(
          [
            ["play-fill", "Phát tất cả", () => menu && playAll(menu)],
            ["shuffle", "Phát ngẫu nhiên", () => menu && playAll(menu, true)],
            ["pencil", "Đổi tên", () => menu && setNaming({ id: menu.id, name: menu.name })],
            ["trash3", "Xoá playlist", () => menu && remove(menu)],
          ] as const
        ).map(([icon, label, act]) => (
          <Pressable
            key={label}
            onPress={() => {
              haptic();
              setMenu(null);
              act();
            }}
            style={({ pressed }) => [styles.option, { backgroundColor: pressed ? t.bg : "transparent" }]}
            accessibilityRole="button"
          >
            <Icon name={icon} size={17} color={icon === "trash3" ? t.coral : t.text} />
            <T color={icon === "trash3" ? t.coral : undefined}>{tr(label)}</T>
          </Pressable>
        ))}
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  newBox: {
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: 8,
  },
  more: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  option: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 4, paddingVertical: 13 },
});
