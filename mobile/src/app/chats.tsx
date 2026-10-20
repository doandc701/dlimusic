// The channel list, like the web's sidebar on a phone: search (or paste a t.me link), "Bài hát yêu thích",
// "N hội thoại" with sorting and "Chọn hiển thị", the chats. Tap one to see its files.
import { FlashList } from "@shopify/flash-list";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, RefreshControl, StyleSheet, TextInput, View } from "react-native";

import { ChatRow } from "@/components/ChatRow";
import { ChatsModal } from "@/components/ChatsModal";
import { Icon, type IconName } from "@/components/Icon";
import { norm } from "@/components/RecentPanel";
import { Pill, T, haptic } from "@/components/ui";
import { useT } from "@/i18n";
import { useLibrary, type ChatSort } from "@/store/LibraryProvider";
import { reloadChats, useChats } from "@/telegram/useChats";
import { FONT, useTheme } from "@/theme";

// labels in Vietnamese, translated where shown
const SORTS: Record<ChatSort, { label: string; icon: IconName }> = {
  recent: { label: "Mới hoạt động", icon: "clock-history" }, // Telegram's own order
  az: { label: "Tên A → Z", icon: "sort-alpha-down" },
  za: { label: "Tên Z → A", icon: "sort-alpha-up-alt" },
  type: { label: "Theo loại (Kênh, Nhóm, Người dùng)", icon: "collection" },
};
const TYPE_ORDER = { channel: 0, group: 1, user: 2 };
const collator = new Intl.Collator("vi", { sensitivity: "base", numeric: true });

export default function Chats() {
  const t = useTheme();
  const tr = useT();
  const { chats, error, loading } = useChats();
  const { favorites, visibleChats, chatSort, setChatSort } = useLibrary();
  const [query, setQuery] = useState("");
  const [sortOpen, setSortOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [menuTop, setMenuTop] = useState(0);
  const bar = useRef<View>(null);

  useEffect(() => {
    if (!chats) reloadChats();
  }, [chats]);

  const shown = useMemo(() => {
    const all = chats ?? [];
    const visible = visibleChats ? all.filter((c) => visibleChats.includes(c.id)) : all;
    // a pasted link / @username finds the chat by its username (t.me/abc, https://t.me/abc/123, @abc)
    const link = /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?:s\/)?([A-Za-z0-9_]{4,})|^@([A-Za-z0-9_]{4,})$/.exec(
      query.trim(),
    );
    const q = norm(link ? (link[1] ?? link[2]) : query.trim());
    const list = visible.filter((c) => !q || norm(`${c.title} ${c.username ?? ""}`).includes(q));
    if (chatSort === "az") return [...list].sort((a, b) => collator.compare(a.title, b.title));
    if (chatSort === "za") return [...list].sort((a, b) => collator.compare(b.title, a.title));
    if (chatSort === "type") return [...list].sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type]);
    return list;
  }, [chats, visibleChats, chatSort, query]);

  const total = chats?.length ?? 0;
  const filtered = !!visibleChats;

  return (
    <View style={{ flex: 1, backgroundColor: t.surface }}>
      <View style={[styles.searchWrap, { borderBottomColor: t.border }]}>
        <View style={[styles.search, { borderColor: t.border }]}>
          <View style={[styles.searchIco, { borderRightColor: t.border, backgroundColor: t.bg }]}>
            <Icon name="search" size={15} color={t.text} />
          </View>
          <TextInput
            allowFontScaling={false}
            value={query}
            onChangeText={setQuery}
            placeholder={tr("Tìm kênh hoặc dán link t.me/…")}
            placeholderTextColor={t.textMuted}
            style={[styles.searchInput, { color: t.text }]}
            returnKeyType="search"
            autoCapitalize="none"
          />
        </View>
      </View>

      <Pressable
        onPress={() => {
          haptic();
          router.push({ pathname: "/chat/[id]", params: { id: "fav" } });
        }}
        style={({ pressed }) => [
          styles.fav,
          { borderBottomColor: t.border, backgroundColor: pressed ? t.bg : t.surface },
        ]}
        accessibilityRole="button"
        accessibilityLabel={tr("Bài hát yêu thích")}
      >
        <LinearGradient
          colors={["#ec4899", "#8b5cf6"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.favAvatar}
        >
          <Icon name="heart-fill" size={16} color="#fff" />
        </LinearGradient>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T weight="semibold">{tr("Bài hát yêu thích")}</T>
          <View style={styles.sub}>
            <Icon name="music-note-beamed" size={12} color={t.textMuted} />
            <T size={13} muted>
              {tr("{n} bài · từ mọi kênh", { n: favorites.length })}
            </T>
          </View>
        </View>
      </Pressable>

      <View
        ref={bar}
        style={[styles.bar, { borderBottomColor: t.border, backgroundColor: t.bg }]}
        onLayout={() => bar.current?.measureInWindow((_x, y, _w, h) => setMenuTop(y + h))}
      >
        <Icon name={filtered ? "funnel-fill" : "chat-dots"} size={12} color={filtered ? t.violet : t.textMuted} />
        <T size={12.5} muted style={{ flex: 1 }}>
          <T size={12.5} weight="bold">
            {filtered ? `${shown.length}/${total}` : total}
          </T>{" "}
          {tr("hội thoại", { n: filtered ? shown.length : total })}
        </T>
        <Pill
          icon="arrow-down-up"
          color={t.pink}
          small
          active={chatSort !== "recent"}
          onPress={() => setSortOpen(true)}
          label={tr("Sắp xếp hội thoại")}
        />
        <Pill
          title={tr(filtered ? "Chọn lại" : "Chọn hiển thị")}
          icon="sliders"
          color={t.pink}
          small
          onPress={() => setPicking(true)}
        />
      </View>

      <FlashList
        data={shown}
        keyExtractor={(c) => c.id}
        refreshControl={<RefreshControl refreshing={loading && !!chats} tintColor={t.violet} onRefresh={reloadChats} />}
        ListEmptyComponent={
          <T muted size={13} style={{ textAlign: "center", padding: 24 }}>
            {tr(
              error ??
                (chats ? (query ? "Không có hội thoại khớp" : "Không có hội thoại") : "Đang tải danh sách hội thoại…"),
            )}
          </T>
        }
        renderItem={({ item }) => (
          <ChatRow
            chat={item}
            onPress={() => router.push({ pathname: "/chat/[id]", params: { id: item.id, title: item.title } })}
          />
        )}
      />

      <Modal visible={sortOpen} transparent animationType="fade" onRequestClose={() => setSortOpen(false)}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => setSortOpen(false)} />
        <View style={[styles.menu, { top: menuTop + 2, backgroundColor: t.surface, borderColor: t.border }]}>
          <T size={12.5} muted style={{ paddingHorizontal: 12, paddingVertical: 6 }}>
            {tr("Sắp xếp hội thoại")}
          </T>
          {(Object.keys(SORTS) as ChatSort[]).map((k) => {
            const on = k === chatSort;
            return (
              <Pressable
                key={k}
                onPress={() => {
                  haptic();
                  setChatSort(k);
                  setSortOpen(false);
                }}
                style={[styles.menuItem, on && { backgroundColor: t.primary }]}
              >
                <Icon name={SORTS[k].icon} size={13} color={on ? "#fff" : t.text} />
                <T size={13.6} style={{ flex: 1 }} color={on ? "#fff" : undefined}>
                  {tr(SORTS[k].label)}
                </T>
                {on && <Icon name="check2" size={14} color="#fff" />}
              </Pressable>
            );
          })}
        </View>
      </Modal>
      <ChatsModal open={picking} onClose={() => setPicking(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  searchWrap: { padding: 16, paddingBottom: 16, borderBottomWidth: StyleSheet.hairlineWidth },
  search: { flexDirection: "row", height: 38, borderWidth: 1, borderRadius: 6 },
  searchIco: {
    width: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRightWidth: 1,
    borderTopLeftRadius: 5,
    borderBottomLeftRadius: 5,
  },
  searchInput: { flex: 1, paddingHorizontal: 12, fontSize: 16, fontFamily: FONT.regular },
  fav: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  favAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#ec4899",
    shadowOpacity: 0.6,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 4 },
  },
  sub: { flexDirection: "row", alignItems: "center", gap: 4 },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  menu: {
    position: "absolute",
    left: 8,
    width: 290,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 6,
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  menuItem: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 7 },
});
