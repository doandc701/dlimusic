// The player docked at the bottom, like the web's on a phone: song (tap the name: its list), "Nghe thử" + chat,
// ♡, sleep timer, speed; 🔀 ⏮ ▶ ⏭ 🔁; the seek bar (played part in colour, a round thumb to drag) between the times.
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, View } from "react-native";

import { displayName } from "../../../core.js";
import { useT } from "../i18n";
import { usePlayer, usePlayerClock, type SleepMode } from "../player/PlayerProvider";
import { useLibrary } from "../store/LibraryProvider";
import { chatById } from "../telegram/library";
import { FONT, GRADIENT, mix, tint, useTheme } from "../theme";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";
import { useToast } from "./Toast";
import { Badge, IconButton, T, fmtDur, haptic } from "./ui";

const SPEEDS: [number, string][] = [
  [0.5, "Chậm"],
  [1, "Bình thường"],
  [1.2, "Hơi nhanh"],
  [1.5, "Nhanh"],
  [1.7, "Rất nhanh"],
  [2, "Siêu nhanh"],
];
const SLEEP_MINUTES = [10, 15, 20, 30, 45, 60];

export function MiniPlayer() {
  const t = useTheme();
  const tr = useT();
  const toast = useToast();
  const p = usePlayer();
  const { isFavorite, toggleFavorite } = useLibrary();
  const [speedOpen, setSpeedOpen] = useState(false);
  const clock = usePlayerClock(); // the dock only draws again with the position, not the screens
  const { now, playing } = p;
  if (!now) return null;

  const fetching = now.phase === "fetching";
  const busy = fetching || !!now.waiting; // no sound yet / waiting for the part of the song it needs
  // the whole song's length (Telegram's): while fetching, the player only knows the part it has
  const dur = now.song.duration || clock.duration || 0;
  const pos = fetching ? 0 : clock.currentTime || 0;
  const fav = isFavorite(now.song.key);
  const chat = now.song.chat ?? chatById(now.song.chatId)?.title ?? "";
  const modeColor = (on: boolean) => (on ? "#ec4899" : t.violet);

  return (
    <View style={[styles.dock, { backgroundColor: t.surface, borderTopColor: t.border }]}>
      <View style={styles.top}>
        <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.art}>
          <Icon name="music-note-beamed" size={18} color="#fff" />
        </LinearGradient>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T
            weight="semibold"
            size={14.4}
            numberOfLines={1}
            style={{ alignSelf: "flex-start", maxWidth: "100%" }}
            onPress={() =>
              // its list: the favourites if it plays from there, else its own chat (also for "Phát gần đây")
              router.navigate({
                pathname: "/chat/[id]",
                params: { id: now.list.kind === "fav" ? "fav" : now.song.chatId, song: now.song.key },
              })
            }
            accessibilityRole="button"
          >
            {displayName(now.song)}
          </T>
          <View style={styles.sub}>
            {now.phase === "error" ? (
              <T size={12} color={t.coral} numberOfLines={1}>
                {tr(now.error ?? "")}
              </T>
            ) : fetching ? (
              <T size={12} muted numberOfLines={1}>
                {tr("Đang tải {pct}%", { pct: Math.round(clock.progress * 100) })}
              </T>
            ) : (
              <>
                <Badge text={tr("Nghe thử")} />
                <T size={12} muted numberOfLines={1} style={{ flexShrink: 1 }}>
                  {now.song.performer || chat}
                </T>
              </>
            )}
          </View>
        </View>
        <IconButton
          icon={fav ? "heart-fill" : "heart"}
          color={fav ? "#ec4899" : t.textMuted}
          size={18}
          onPress={() => {
            const on = toggleFavorite(now.song.key);
            toast(tr(on ? "Đã thêm vào Bài hát yêu thích" : "Đã bỏ khỏi Bài hát yêu thích"), on ? "bye" : "info");
          }}
          label={tr(fav ? "Bỏ khỏi yêu thích" : "Thêm vào yêu thích")}
        />
        <SleepButton songLeft={(dur - pos) / p.speed} />
        <Pressable
          onPress={() => {
            haptic();
            setSpeedOpen(true);
          }}
          accessibilityRole="button"
          accessibilityLabel={tr("Tốc độ phát")}
          hitSlop={6}
          style={({ pressed }) => [
            styles.speedBtn,
            { backgroundColor: pressed ? tint(t.violet, 0.16) : "transparent" },
          ]}
        >
          <T
            weight="semibold"
            size={13}
            color={p.speed !== 1 ? "#ec4899" : t.violet}
            style={{ fontVariant: ["tabular-nums"] }}
          >
            {p.speed}x
          </T>
        </Pressable>
      </View>

      <View style={styles.controls}>
        <ModeButton
          icon="shuffle"
          on={p.shuffle}
          color={modeColor(p.shuffle)}
          onPress={() => p.setShuffle(!p.shuffle)}
          label={tr(p.shuffle ? "Phát ngẫu nhiên: bật" : "Phát ngẫu nhiên: tắt")}
        />
        <IconButton
          icon="skip-start-fill"
          color={t.violet}
          size={20}
          onPress={() => p.next(-1)}
          label={tr("Bài trước")}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={tr(playing ? "Tạm dừng" : "Phát")}
          onPress={() => {
            haptic();
            p.toggle();
          }}
          disabled={fetching}
          style={({ pressed }) => ({ transform: [{ scale: pressed ? 0.94 : 1 }] })}
        >
          <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.play}>
            {busy ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Icon name={playing ? "pause-fill" : "play-fill"} size={24} color="#fff" />
            )}
          </LinearGradient>
        </Pressable>
        <IconButton
          icon="skip-end-fill"
          color={t.violet}
          size={20}
          onPress={() => p.next(1)}
          label={tr("Bài tiếp theo")}
        />
        <ModeButton
          icon={p.repeat === "one" ? "repeat-1" : "repeat"}
          on={p.repeat !== "off"}
          color={modeColor(p.repeat !== "off")}
          onPress={() => p.setRepeat(p.repeat === "off" ? "all" : p.repeat === "all" ? "one" : "off")}
          label={tr(
            p.repeat === "off" ? "Lặp lại: tắt" : p.repeat === "all" ? "Lặp lại: cả danh sách" : "Lặp lại: một bài",
          )}
        />
      </View>

      <View style={styles.seekRow}>
        <T size={12} muted style={styles.time}>
          {fmtDur(pos) || "0:00"}
        </T>
        <SeekBar value={pos} duration={dur} disabled={fetching} loaded={clock.progress} onSeek={p.seekTo} />
        <T size={12} muted style={styles.time}>
          {fmtDur(dur) || "0:00"}
        </T>
      </View>

      <Modal visible={speedOpen} transparent animationType="fade" onRequestClose={() => setSpeedOpen(false)}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => setSpeedOpen(false)} />
        <View style={[styles.speedMenu, { backgroundColor: t.surface, borderColor: t.border }]}>
          <View style={[styles.speedHead, { borderBottomColor: t.border }]}>
            <T weight="semibold" size={13} style={{ fontVariant: ["tabular-nums"] }}>
              {p.speed.toFixed(1)}x
            </T>
          </View>
          {SPEEDS.map(([rate, label]) => {
            const on = rate === p.speed;
            return (
              <Pressable
                key={rate}
                onPress={() => {
                  haptic();
                  p.setSpeed(rate);
                  setSpeedOpen(false);
                }}
                style={[styles.speedItem, on && { backgroundColor: t.primary }]}
              >
                <T size={12} muted={!on} color={on ? "#fff" : undefined} style={{ width: 34 }}>
                  {rate}x
                </T>
                <T size={14} style={{ flex: 1 }} color={on ? "#fff" : undefined}>
                  {tr(label)}
                </T>
                {on && <Icon name="check2" size={15} color="#fff" />}
              </Pressable>
            );
          })}
        </View>
      </Modal>
    </View>
  );
}

/** The alarm clock: "Hẹn giờ ngủ" — the time left while it is on; its choices in a sheet from the bottom. */
function SleepButton({ songLeft }: { songLeft: number }) {
  const t = useTheme();
  const tr = useT();
  const p = usePlayer();
  const [open, setOpen] = useState(false);
  const [nowMs, setNowMs] = useState(0); // the wall clock, read every second while a minutes timer runs
  const { mode, endsAt } = p.sleep;
  // the countdown goes on while paused (the dock draws again with the position only while playing)
  useEffect(() => {
    if (endsAt === null) return;
    const tick = () => setNowMs(Date.now());
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [endsAt]);
  const songTime = fmtDur(Math.max(0, songLeft)) || "0:00";
  const left =
    mode === "off"
      ? null
      : endsAt !== null
        ? fmtDur(Math.min(Number(mode) * 60, Math.max(0, (endsAt - nowMs) / 1000))) || "0:00"
        : songTime;
  const pick = (m: SleepMode) => {
    haptic();
    p.setSleep(m);
    setOpen(false);
  };
  const choices: [SleepMode, string][] = [
    ["off", tr("Tắt")],
    ...SLEEP_MINUTES.map((n): [SleepMode, string] => [n, tr("{n} phút", { n })]),
    ["song", tr("Hết bài này")],
  ];
  return (
    <>
      <Pressable
        onPress={() => {
          haptic();
          setOpen(true);
        }}
        accessibilityRole="button"
        accessibilityLabel={tr("Hẹn giờ ngủ")}
        accessibilityValue={left ? { text: left } : undefined}
        hitSlop={6}
        style={({ pressed }) => [
          styles.speedBtn,
          styles.sleepBtn,
          { backgroundColor: pressed ? tint(t.violet, 0.16) : "transparent" },
        ]}
      >
        <Icon name={left ? "alarm-fill" : "alarm"} size={15} color={left ? "#ec4899" : t.violet} />
        {left && (
          <T weight="semibold" size={13} color="#ec4899" style={{ fontVariant: ["tabular-nums"] }}>
            {left}
          </T>
        )}
      </Pressable>
      <Sheet open={open} onClose={() => setOpen(false)} title={tr("Hẹn giờ ngủ")} icon="alarm" bottom>
        <View style={styles.sleepList}>
          {choices.map(([m, label]) => {
            const on = m === mode;
            return (
              <Pressable
                key={String(m)}
                onPress={() => pick(m)}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                style={({ pressed }) => [
                  styles.sleepItem,
                  { backgroundColor: on ? t.primary : pressed ? tint(t.violet, 0.16) : "transparent" },
                ]}
              >
                <View style={{ flex: 1 }}>
                  <T size={15} color={on ? "#fff" : undefined}>
                    {label}
                  </T>
                  {m === "song" && (
                    <T size={12} muted={!on} color={on ? "#fff" : undefined} style={{ fontVariant: ["tabular-nums"] }}>
                      {tr("Còn {time}", { time: songTime })}
                    </T>
                  )}
                </View>
                {on && <Icon name="check2" size={16} color="#fff" />}
              </Pressable>
            );
          })}
        </View>
      </Sheet>
    </>
  );
}

function ModeButton({
  icon,
  on,
  color,
  onPress,
  label,
}: {
  icon: "shuffle" | "repeat" | "repeat-1";
  on: boolean;
  color: string;
  onPress: () => void;
  label: string;
}) {
  return (
    <View>
      <IconButton icon={icon} color={color} size={18} onPress={onPress} label={label} />
      {on && <View style={[styles.dot, { backgroundColor: color }]} />}
    </View>
  );
}

/** The seek bar: played part in the gradient, a round thumb; tap or drag to move. */
function SeekBar({
  value,
  duration,
  disabled,
  loaded,
  onSeek,
}: {
  value: number;
  duration: number;
  disabled?: boolean;
  loaded: number;
  onSeek: (s: number) => void;
}) {
  const t = useTheme();
  const tr = useT();
  const [width, setWidth] = useState(1);
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? (duration ? Math.min(1, value / duration) : 0);
  const at = (x: number) => Math.max(0, Math.min(1, x / width));
  return (
    <View
      style={styles.seek}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width || 1)}
      onStartShouldSetResponder={() => !disabled && duration > 0}
      onMoveShouldSetResponder={() => !disabled && duration > 0}
      onResponderGrant={(e) => setDrag(at(e.nativeEvent.locationX))}
      onResponderMove={(e) => setDrag(at(e.nativeEvent.locationX))}
      onResponderRelease={() => {
        if (drag !== null) onSeek(drag * duration);
        setDrag(null);
      }}
      onResponderTerminate={() => setDrag(null)}
      accessibilityRole="adjustable"
      accessibilityLabel={tr("Vị trí")}
    >
      <View style={[styles.track, { backgroundColor: t.surfaceAlt }]}>
        {/* the part already fetched, grey like the web's (--seek-loaded: secondary colour 40% into its background) */}
        <View
          style={[
            styles.fill,
            { width: `${loaded * 100}%`, backgroundColor: mix(t.dark ? "#b1b5b9" : "#595c5f", t.surfaceAlt, 0.4) },
          ]}
        />
        <LinearGradient
          colors={GRADIENT}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={[styles.fill, { width: `${shown * 100}%` }]}
        />
      </View>
      <LinearGradient
        colors={GRADIENT}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.thumb, { left: Math.max(0, Math.min(width - 16, shown * width - 8)) }]}
        pointerEvents="none"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  dock: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingTop: 7, paddingBottom: 8, gap: 4 },
  top: { flexDirection: "row", alignItems: "center", gap: 12 },
  art: {
    width: 38,
    height: 38,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#ec4899",
    shadowOpacity: 0.8,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 6 },
  },
  sub: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 1 },
  speedBtn: { minWidth: 42, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  controls: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 14 },
  play: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#ec4899",
    shadowOpacity: 0.6,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
  },
  dot: { position: "absolute", bottom: 1, alignSelf: "center", width: 4, height: 4, borderRadius: 2 },
  seekRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  time: { minWidth: 34, textAlign: "center", fontVariant: ["tabular-nums"], fontFamily: FONT.regular },
  seek: { flex: 1, height: 22, justifyContent: "center" },
  track: { height: 8, borderRadius: 4, overflow: "hidden" },
  fill: { position: "absolute", left: 0, top: 0, bottom: 0, borderRadius: 4 },
  thumb: { position: "absolute", width: 16, height: 16, borderRadius: 8 },
  speedMenu: {
    position: "absolute",
    right: 12,
    bottom: 140,
    width: 240,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    paddingBottom: 6,
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  speedHead: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    marginBottom: 6,
  },
  sleepBtn: { flexDirection: "row", gap: 4, paddingHorizontal: 6 },
  sleepList: { gap: 2 },
  sleepItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  speedItem: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 7 },
});
