// A chat in a list, like the web's dialog-item: avatar, title, "📢 Kênh · @username".
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import type { Chat } from "../telegram/library";
import { useT } from "../i18n";
import { useTheme } from "../theme";
import { Icon, type IconName } from "./Icon";
import { Avatar, T, haptic } from "./ui";

export const TYPE: Record<Chat["type"], { icon: IconName; label: string }> = {
  channel: { icon: "megaphone", label: "Kênh" },
  group: { icon: "people", label: "Nhóm" },
  user: { icon: "person", label: "Người dùng" },
};

export function ChatRow({ chat, onPress, left }: { chat: Chat; onPress: () => void; left?: ReactNode }) {
  const t = useTheme();
  const tr = useT();
  const kind = TYPE[chat.type];
  return (
    <Pressable
      onPress={() => {
        haptic();
        onPress();
      }}
      style={({ pressed }) => [
        styles.row,
        { borderBottomColor: t.border, backgroundColor: pressed ? t.surfaceAlt : t.surface },
      ]}
      accessibilityRole="button"
      accessibilityLabel={chat.title}
    >
      {left}
      <Avatar name={chat.title} id={chat.id} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <T numberOfLines={1}>{chat.title}</T>
        <View style={styles.sub}>
          <Icon name={kind.icon} size={12} color={t.textMuted} />
          <T size={13} muted numberOfLines={1} style={{ flexShrink: 1 }}>
            {tr(kind.label)}
            {chat.username ? ` · @${chat.username}` : ""}
          </T>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: 3,
    borderLeftColor: "transparent",
  },
  sub: { flexDirection: "row", alignItems: "center", gap: 4 },
});
