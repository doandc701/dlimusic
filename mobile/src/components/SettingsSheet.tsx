// "Cài đặt" (the account card), like the web's: the app's language (applies at once), which chats show in the
// list. Where "Tải xuống" saves (the system's folder picker, remembered).
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { chooseFolder, useDownloads } from "../download/downloads";
import { useT } from "../i18n";
import { useLibrary } from "../store/LibraryProvider";
import { useChats } from "../telegram/useChats";
import { useTheme } from "../theme";
import { ChatsModal, OutlineBtn } from "./ChatsModal";
import { Icon } from "./Icon";
import { LanguageChoices } from "./LanguagePicker";
import { Sheet } from "./Sheet";
import { GradientButton, Pill, T } from "./ui";

export function SettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTheme();
  const tr = useT();
  const { chats } = useChats();
  const { visibleChats } = useLibrary();
  const [picking, setPicking] = useState(false);
  const { dirName } = useDownloads();
  const total = chats ? String(chats.length) : "…"; // still being read
  const summary = visibleChats
    ? tr("Hiện {n}/{total} hội thoại", { n: visibleChats.length, total })
    : tr("Hiện tất cả ({total} hội thoại)", { total });

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={tr("Cài đặt")}
      icon="gear"
      footer={
        <>
          <View style={{ flex: 1 }} />
          <OutlineBtn title={tr("Huỷ")} color={t.slate} onPress={onClose} />
          <GradientButton title={tr("Lưu")} icon="check-lg" radius={999} height={38} size={15} onPress={onClose} />
        </>
      }
    >
      <View style={styles.body}>
        <T weight="semibold">{tr("Ngôn ngữ")}</T>
        <LanguageChoices />

        <T weight="semibold" style={{ marginTop: 12 }}>
          {tr("Hội thoại hiển thị")}
        </T>
        <View style={[styles.box, { borderColor: t.border }]}>
          <Icon name="window-sidebar" size={14} color={t.violet} />
          <T size={13} style={{ flex: 1 }}>
            {summary}
          </T>
          <Pill title={tr("Chọn…")} icon="sliders" color={t.violet} small onPress={() => setPicking(true)} />
        </View>
        <T size={13} muted>
          {tr("Chỉ những hội thoại được chọn mới hiện trong danh sách. Lưu riêng cho từng tài khoản Telegram.")}
        </T>

        <T weight="semibold" style={{ marginTop: 12 }}>
          {tr("Thư mục tải về")}
        </T>
        <View style={[styles.box, { borderColor: t.border }]}>
          <Icon name="folder2-open" size={14} color={t.violet} />
          <T size={13} numberOfLines={1} style={{ flex: 1 }} muted={!dirName}>
            {dirName ?? tr("Chưa chọn (hỏi khi tải lần đầu)")}
          </T>
          <Pill
            title={tr(dirName ? "Đổi…" : "Chọn…")}
            icon="folder2-open"
            color={t.violet}
            small
            onPress={chooseFolder}
          />
        </View>
        <T size={13} muted>
          {tr("File tải về được lưu vào thư mục này. Trên iPhone, sau khi mở lại app có thể phải chọn lại thư mục.")}
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
