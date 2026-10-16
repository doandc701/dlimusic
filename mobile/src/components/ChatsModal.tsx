// "Hội thoại hiển thị", like the web's: tick the chats to see in the list (saved for this account); search,
// "Chọn tất cả" / "Bỏ hết", "Đã chọn x/y", then "Hiện tất cả" or Huỷ / Lưu.
import { useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, TextInput, View } from "react-native";

import { useLibrary } from "../store/LibraryProvider";
import { useChats } from "../telegram/useChats";
import { FONT, tint, useTheme } from "../theme";
import { ChatRow } from "./ChatRow";
import { Icon } from "./Icon";
import { norm } from "./RecentPanel";
import { Sheet } from "./Sheet";
import { Checkbox, GradientButton, T, haptic } from "./ui";

export function ChatsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTheme();
  const { chats } = useChats();
  const { visibleChats, setVisibleChats } = useLibrary();
  const all = useMemo(() => chats ?? [], [chats]);
  const [draft, setDraft] = useState<Set<string> | null>(null);
  const [query, setQuery] = useState("");
  // the ticks being edited: from what is saved, each time the dialog opens
  const ticked = draft ?? new Set(visibleChats ?? all.map((c) => c.id));

  const shown = useMemo(() => {
    const q = norm(query.trim());
    return all.filter((c) => !q || norm(`${c.title} ${c.username ?? ""}`).includes(q));
  }, [all, query]);

  const close = () => {
    setDraft(null);
    setQuery("");
    onClose();
  };
  const save = (ids: string[] | null) => {
    setVisibleChats(ids && ids.length === all.length ? null : ids);
    close();
  };
  // "Chọn tất cả" / "Bỏ hết" act on the chats the search shows; the others keep their ticks (like the web)
  const setShown = (on: boolean) => {
    const next = new Set(ticked);
    for (const c of shown) {
      if (on) next.add(c.id);
      else next.delete(c.id);
    }
    setDraft(next);
  };
  const toggle = (id: string) => {
    const next = new Set(ticked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setDraft(next);
  };

  return (
    <Sheet
      open={open}
      onClose={close}
      title="Hội thoại hiển thị"
      icon="sliders"
      footer={
        <>
          <OutlineBtn title="Hiện tất cả" color={t.violet} onPress={() => save(null)} />
          <View style={{ flex: 1 }} />
          <OutlineBtn title="Huỷ" color={t.slate} onPress={close} />
          <GradientButton
            title="Lưu"
            icon="check-lg"
            radius={999}
            height={38}
            size={15}
            onPress={() => save(all.filter((c) => ticked.has(c.id)).map((c) => c.id))}
          />
        </>
      }
    >
      <View style={styles.top}>
        <View style={[styles.search, { borderColor: t.border }]}>
          <View style={[styles.searchIco, { borderRightColor: t.border, backgroundColor: t.bg }]}>
            <Icon name="search" size={15} color={t.text} />
          </View>
          <TextInput
            allowFontScaling={false}
            value={query}
            onChangeText={setQuery}
            placeholder="Tìm hội thoại…"
            placeholderTextColor={t.textMuted}
            style={[styles.searchInput, { color: t.text }]}
          />
        </View>
        <View style={styles.bulk}>
          <View style={[styles.group, { borderColor: tint(t.violet, 0.4) }]}>
            <GroupBtn icon="check2-all" title="Chọn tất cả" onPress={() => setShown(true)} />
            <View style={{ width: 1, backgroundColor: tint(t.violet, 0.4) }} />
            <GroupBtn icon="x-lg" title="Bỏ hết" onPress={() => setShown(false)} />
          </View>
          <T size={13} muted style={{ marginLeft: "auto" }}>
            Đã chọn {ticked.size}/{all.length}
          </T>
        </View>
      </View>
      <FlatList
        data={shown}
        keyExtractor={(c) => c.id}
        style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.border }}
        renderItem={({ item }) => (
          <ChatRow
            chat={item}
            onPress={() => toggle(item.id)}
            left={<Checkbox checked={ticked.has(item.id)} onPress={() => toggle(item.id)} label={item.title} />}
          />
        )}
      />
    </Sheet>
  );
}

function GroupBtn({ icon, title, onPress }: { icon: "check2-all" | "x-lg"; title: string; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={() => {
        haptic();
        onPress();
      }}
      style={({ pressed }) => [styles.groupBtn, { backgroundColor: pressed ? t.violet : "transparent" }]}
    >
      <Icon name={icon} size={12} color={t.violet} />
      <T size={12} weight="medium" color={t.violet}>
        {title}
      </T>
    </Pressable>
  );
}

export function OutlineBtn({ title, color, onPress }: { title: string; color: string; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={() => {
        haptic();
        onPress();
      }}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.outline,
        { borderColor: tint(color, 0.4), backgroundColor: pressed ? color : "transparent" },
      ]}
    >
      {({ pressed }) => (
        <T size={15} weight="medium" color={pressed ? (t.dark ? "#111827" : "#fff") : color}>
          {title}
        </T>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  top: { paddingHorizontal: 16, paddingVertical: 12, gap: 10 },
  search: { flexDirection: "row", height: 36, borderWidth: 1, borderRadius: 6 },
  searchIco: {
    width: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRightWidth: 1,
    borderTopLeftRadius: 5,
    borderBottomLeftRadius: 5,
  },
  searchInput: { flex: 1, paddingHorizontal: 10, fontSize: 16, fontFamily: FONT.regular },
  bulk: { flexDirection: "row", alignItems: "center" },
  group: { flexDirection: "row", borderWidth: 1, borderRadius: 6, overflow: "hidden" },
  groupBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 9, height: 28 },
  outline: {
    height: 38,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
});
