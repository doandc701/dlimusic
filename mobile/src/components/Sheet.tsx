// A dialog in the web's style: a full-screen one on phones (modal-fullscreen-sm-down: "Hội thoại hiển thị",
// "Cài đặt") or a sheet from the bottom (offcanvas-bottom: "Bộ lọc & sắp xếp"). Title with its icon, ✕, body,
// buttons at the bottom.
import type { ReactNode } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useTheme } from "../theme";
import { Icon, type IconName } from "./Icon";
import { IconButton, T } from "./ui";

export function Sheet({
  open,
  onClose,
  title,
  icon,
  children,
  footer,
  bottom,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  icon: IconName;
  children: ReactNode;
  footer?: ReactNode;
  bottom?: boolean; // a sheet from the bottom instead of the full screen
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const head = (
    <View style={[styles.head, { borderBottomColor: t.border }]}>
      <Icon name={icon} size={18} color={t.violet} />
      <T weight="semibold" size={19} style={{ flex: 1 }}>
        {title}
      </T>
      <IconButton icon="x-lg" color={t.text} size={16} onPress={onClose} label="Đóng" />
    </View>
  );
  const foot = footer ? <View style={[styles.foot, { borderTopColor: t.border }]}>{footer}</View> : null;

  if (bottom)
    return (
      <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
        <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: t.backdrop }]} onPress={onClose} />
        <View style={[styles.sheet, { backgroundColor: t.surface, paddingBottom: Math.max(insets.bottom, 12) }]}>
          {head}
          <View style={styles.body}>{children}</View>
          {footer && <View style={styles.sheetFoot}>{footer}</View>}
        </View>
      </Modal>
    );

  return (
    <Modal visible={open} animationType="slide" onRequestClose={onClose} presentationStyle="fullScreen">
      {/* the insets of the app's window: a SafeAreaView inside a Modal gets none on iOS (title under the clock) */}
      <View style={{ flex: 1, backgroundColor: t.surface, paddingTop: insets.top, paddingBottom: insets.bottom }}>
        {head}
        <View style={{ flex: 1 }}>{children}</View>
        {foot}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  body: { paddingHorizontal: 16, paddingTop: 14, gap: 14 },
  foot: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  sheetFoot: { paddingHorizontal: 16, paddingTop: 16 },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: "85%",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },
});
