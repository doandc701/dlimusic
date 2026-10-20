// "Phát gần đây" (the header's clock button), like the web's panel: search, the songs played lately (newest
// first; tap = play, the list goes on in that order), ✕ to drop one, "Xoá danh sách".
import { LinearGradient } from "expo-linear-gradient";
import { useMemo, useState } from "react";
import { Alert, FlatList, Modal, Pressable, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { displayName } from "../../../core.js";
import { useT, type Translate } from "../i18n";
import { usePlayer } from "../player/PlayerProvider";
import { useLibrary, type RecentItem } from "../store/LibraryProvider";
import { FavoritesScan } from "../telegram/library";
import { FONT, GRADIENT, tint, useTheme } from "../theme";
import { Icon } from "./Icon";
import { useToast } from "./Toast";
import { IconButton, T, fmtDur, haptic } from "./ui";

export const norm = (s: string) =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();

/** "5 phút trước", "Hôm qua 21:04", "12/10 08:30" (the web's ago()), in the picked language */
function ago(at: number, tr: Translate) {
  const min = Math.floor((Date.now() - at) / 60000);
  if (min < 1) return tr("Vừa xong");
  if (min < 60) return tr("{n} phút trước", { n: min });
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, "0");
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return tr("Hôm nay {time}", { time: hm });
  if (d.toDateString() === new Date(today.getTime() - 86_400_000).toDateString())
    return tr("Hôm qua {time}", { time: hm });
  return `${two(d.getDate())}/${two(d.getMonth() + 1)} ${hm}`;
}

export function RecentPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTheme();
  const tr = useT();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const { recent, removeRecent, clearRecent } = useLibrary();
  const { now, playing: sounding, play } = usePlayer();
  const [query, setQuery] = useState("");

  const list = useMemo(() => {
    const q = norm(query.trim());
    return recent.filter((h) => !q || norm(`${h.title || ""} ${h.performer || ""} ${h.name} ${h.chat}`).includes(q));
  }, [recent, query]);
  const playing = now?.song.key;

  async function playRecent(h: RecentItem) {
    const scan = new FavoritesScan(
      recent.map((r) => r.id),
      "recent",
    );
    try {
      await scan.next();
    } catch (e) {
      return toast(String((e as Error)?.message ?? e), "error");
    }
    const song = scan.songs.find((s) => s.key === h.id);
    if (!song) return toast(tr("Không tìm thấy bài này trong kênh (có thể tin đã bị xoá)"), "warn");
    play(scan, song);
  }

  function clearAll() {
    Alert.alert(
      tr("Xoá danh sách phát gần đây"),
      tr("Xoá {n} bài khỏi danh sách phát gần đây?", { n: recent.length }),
      [
        { text: tr("Huỷ"), style: "cancel" },
        { text: tr("Xoá"), style: "destructive", onPress: clearRecent },
      ],
    );
  }

  return (
    <Modal visible={open} animationType="slide" onRequestClose={onClose} presentationStyle="fullScreen">
      {/* the insets of the app's window: a SafeAreaView inside a Modal gets none on iOS (title under the clock) */}
      <View style={{ flex: 1, backgroundColor: t.surface, paddingTop: insets.top, paddingBottom: insets.bottom }}>
        <View style={styles.head}>
          <Icon name="clock-history" size={15} color={t.text} />
          <T weight="semibold" style={{ flex: 1 }}>
            {tr("Phát gần đây")}{" "}
            <T muted weight="regular">
              ({recent.length})
            </T>
          </T>
          <IconButton icon="x-lg" color={t.pink} size={16} onPress={onClose} label={tr("Đóng")} />
        </View>
        <View style={[styles.search, { borderColor: t.border }]}>
          <View style={[styles.searchIco, { borderRightColor: t.border, backgroundColor: t.bg }]}>
            <Icon name="search" size={15} color={t.text} />
          </View>
          <TextInput
            allowFontScaling={false}
            value={query}
            onChangeText={setQuery}
            placeholder={tr("Tìm bài đã nghe…")}
            placeholderTextColor={t.textMuted}
            style={[styles.searchInput, { color: t.text }]}
          />
        </View>
        <FlatList
          data={list}
          keyExtractor={(h) => h.id}
          style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.border }}
          ListEmptyComponent={
            <T size={13} muted style={{ textAlign: "center", paddingVertical: 24 }}>
              {tr(recent.length ? "Không có bài khớp" : "Chưa nghe bài nào — bài bạn nghe sẽ hiện ở đây")}
            </T>
          }
          renderItem={({ item }) => {
            const on = item.id === playing;
            return (
              <Pressable
                onPress={() => {
                  haptic();
                  playRecent(item);
                }}
                style={({ pressed }) => [
                  styles.row,
                  {
                    borderBottomColor: t.border,
                    backgroundColor: on ? tint(t.pink, 0.12) : pressed ? t.surfaceAlt : "transparent",
                  },
                ]}
              >
                <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.art}>
                  <Icon name={on && sounding ? "soundwave" : "play-fill"} size={15} color="#fff" />
                </LinearGradient>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T
                    size={13}
                    weight="medium"
                    numberOfLines={1}
                    color={on ? (t.dark ? "#c4b5fd" : "#5b21b6") : undefined}
                  >
                    {displayName(item)}
                  </T>
                  <T size={13} muted numberOfLines={1}>
                    {[item.chat, item.duration ? fmtDur(item.duration) : "", ago(item.at, tr)]
                      .filter(Boolean)
                      .join(" · ")}
                  </T>
                </View>
                <IconButton
                  icon="x-lg"
                  color={t.pink}
                  size={14}
                  box={30}
                  onPress={() => removeRecent(item.id)}
                  label={tr("Bỏ khỏi danh sách")}
                />
              </Pressable>
            );
          }}
        />
        <View style={[styles.foot, { borderTopColor: t.border }]}>
          <Pressable
            onPress={() => {
              haptic();
              clearAll();
            }}
            disabled={!recent.length}
            style={({ pressed }) => [
              styles.clear,
              {
                borderColor: tint(t.coral, 0.4),
                backgroundColor: pressed ? t.coral : "transparent",
                opacity: recent.length ? 1 : 0.45,
              },
            ]}
          >
            <Icon name="trash3" size={13} color={t.coral} />
            <T size={13} weight="medium" color={t.coral}>
              {tr("Xoá danh sách")}
            </T>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8 },
  search: { flexDirection: "row", marginHorizontal: 16, marginBottom: 12, height: 36, borderWidth: 1, borderRadius: 6 },
  searchIco: {
    width: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRightWidth: 1,
    borderTopLeftRadius: 5,
    borderBottomLeftRadius: 5,
  },
  searchInput: { flex: 1, paddingHorizontal: 10, fontSize: 16, fontFamily: FONT.regular },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  art: { width: 34, height: 34, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  foot: { paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  clear: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    height: 31,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderRadius: 999,
  },
});
