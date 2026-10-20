// The downloads of this session, above a chat's list (like the web's download panel, folded to one line): the file
// on its way with its %, how many are done, a thin bar; "Huỷ" while it runs, ✕ once it is over.
import { StyleSheet, View } from "react-native";

import { cancelAll, clearFinished, useDownloads } from "../download/downloads";
import { useT } from "../i18n";
import { useTheme } from "../theme";
import { Icon } from "./Icon";
import { IconButton, Pill, T } from "./ui";

export function DownloadBar() {
  const t = useTheme();
  const tr = useT();
  const { jobs, dirName } = useDownloads();
  if (!jobs.length) return null;
  const now = jobs.find((j) => j.status === "downloading");
  const waiting = jobs.filter((j) => j.status === "queued").length;
  const done = jobs.filter((j) => j.status === "done").length;
  const failed = jobs.filter((j) => j.status === "failed");
  const running = !!now || waiting > 0;
  // the whole batch's bytes: what the files done and the one on its way have
  const total = jobs.reduce((n, j) => n + (j.size || 0), 0);
  const got = jobs.reduce(
    (n, j) => n + (j.status === "done" ? j.size || 0 : j.status === "downloading" ? j.received : 0),
    0,
  );
  const pct = total ? Math.min(100, Math.floor((got / total) * 100)) : 0;

  return (
    <View style={[styles.bar, { borderBottomColor: t.border, backgroundColor: t.bg }]}>
      <View style={styles.row}>
        <Icon
          name={running ? "download" : failed.length ? "exclamation-triangle" : "check-circle-fill"}
          size={15}
          color={running ? t.primary : failed.length ? t.coral : t.green}
        />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T size={13} weight="semibold" numberOfLines={1}>
            {running
              ? tr("Đang tải {n}/{total} · {pct}%", { n: done + 1, total: jobs.length, pct })
              : tr("Đã tải xong {n}/{total} file", { n: done, total: jobs.length }) +
                (failed.length ? tr(" · {n} lỗi", { n: failed.length }) : "")}
            {dirName ? <T size={13} muted>{` → ${dirName}`}</T> : null}
          </T>
          <T size={12} muted numberOfLines={1}>
            {now
              ? now.name
              : failed.length
                ? tr(failed[failed.length - 1].error ?? "")
                : tr("Đã lưu vào thư mục đã chọn")}
          </T>
        </View>
        {running ? (
          <Pill title={tr("Huỷ")} icon="x-lg" color={t.coral} small onPress={cancelAll} />
        ) : (
          <IconButton icon="x-lg" color={t.textMuted} size={14} onPress={clearFinished} label={tr("Ẩn")} />
        )}
      </View>
      <View style={[styles.track, { backgroundColor: t.surfaceAlt }]}>
        <View
          style={[
            styles.fill,
            { width: `${running ? pct : 100}%`, backgroundColor: failed.length && !running ? t.coral : t.green },
          ]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { paddingHorizontal: 16, paddingVertical: 8, gap: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  track: { height: 4, borderRadius: 2, overflow: "hidden" },
  fill: { height: 4, borderRadius: 2 },
});
