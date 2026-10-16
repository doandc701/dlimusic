// "Cài đặt" (the account card), like the web's: which chats show in the list.
// Where "Tải xuống" saves (the system's folder picker, remembered).
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { chooseFolder, useDownloads } from "../download/downloads";
import { useLibrary } from "../store/LibraryProvider";
import { useChats } from "../telegram/useChats";
import { useTheme } from "../theme";
import { ChatsModal, OutlineBtn } from "./ChatsModal";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";
import { GradientButton, Pill, T } from "./ui";

export function SettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTheme();
  const { chats } = useChats();
  const { visibleChats } = useLibrary();
  const [picking, setPicking] = useState(false);
  const { dirName } = useDownloads();
  const total = chats ? String(chats.length) : "…"; // still being read
  const summary = visibleChats ? `Hiện ${visibleChats.length}/${total} hội thoại` : `Hiện tất cả (${total} hội thoại)`;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Cài đặt"
      icon="gear"
      footer={
        <>
          <View style={{ flex: 1 }} />
          <OutlineBtn title="Huỷ" color={t.slate} onPress={onClose} />
          <GradientButton title="Lưu" icon="check-lg" radius={999} height={38} size={15} onPress={onClose} />
        </>
      }
    >
      <View style={styles.body}>
        <T weight="semibold">Hội thoại hiển thị</T>
        <View style={[styles.box, { borderColor: t.border }]}>
          <Icon name="window-sidebar" size={14} color={t.violet} />
          <T size={13} style={{ flex: 1 }}>
            {summary}
          </T>
          <Pill title="Chọn…" icon="sliders" color={t.violet} small onPress={() => setPicking(true)} />
        </View>
        <T size={13} muted>
          Chỉ những hội thoại được chọn mới hiện trong danh sách. Lưu riêng cho từng tài khoản Telegram.
        </T>

        <T weight="semibold" style={{ marginTop: 12 }}>
          Thư mục tải về
        </T>
        <View style={[styles.box, { borderColor: t.border }]}>
          <Icon name="folder2-open" size={14} color={t.violet} />
          <T size={13} numberOfLines={1} style={{ flex: 1 }} muted={!dirName}>
            {dirName ?? "Chưa chọn (hỏi khi tải lần đầu)"}
          </T>
          <Pill title={dirName ? "Đổi…" : "Chọn…"} icon="folder2-open" color={t.violet} small onPress={chooseFolder} />
        </View>
        <T size={13} muted>
          File tải về được lưu vào thư mục này. Trên iPhone, sau khi mở lại app có thể phải chọn lại thư mục.
        </T>
      </View>
      <ChatsModal open={picking} onClose={() => setPicking(false)} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { padding: 16, gap: 10 },
  box: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
});
