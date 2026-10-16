// The header, like the web's navbar: logo + "DLiMusic"; signed in: "Phát gần đây" (amber, with the count),
// light / dark, and the account's avatar that opens the account card (name band in the account's colour,
// phone, id, sync, Cài đặt / Đăng xuất).
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { useState } from "react";
import { Alert, Image, Modal, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useLibrary } from "../store/LibraryProvider";
import { useAuth } from "../telegram/AuthProvider";
import { FONT, mix, tint, useTheme, useThemeToggle } from "../theme";
import { Icon, type IconName } from "./Icon";
import { RecentPanel } from "./RecentPanel";
import { SettingsSheet } from "./SettingsSheet";
import { HEADER_H, useToast } from "./Toast";
import { RoundButton, T, colorFor, haptic, initialOf } from "./ui";

/** "+84912345678" -> "+84 912 345 678" (like the web's card) */
const fmtPhone = (p?: string | null) =>
  p ? `+${p}`.replace(/^\+\+/, "+").replace(/^\+(84|1|7|\d{2})(\d{3})(\d{3})(\d+)$/, "+$1 $2 $3 $4") : "Không có";

export function AppHeader({ signedIn }: { signedIn: boolean }) {
  const t = useTheme();
  const toggleTheme = useThemeToggle();
  const insets = useSafeAreaInsets();
  const { recent } = useLibrary();
  const [panel, setPanel] = useState<"card" | "recent" | "settings" | null>(null);

  return (
    <View style={{ paddingTop: insets.top, backgroundColor: t.surface }}>
      <View style={[styles.bar, { borderBottomColor: t.border }]}>
        <Pressable
          onPress={() => signedIn && router.dismissTo("/")}
          style={styles.brand}
          accessibilityRole="link"
          accessibilityLabel="DLiMusic — màn hình chính"
        >
          <Image source={require("@/assets/images/logo-192.png")} style={styles.logo} />
          <T weight="bold" size={16.8} style={{ letterSpacing: -0.3 }}>
            DLiMusic
          </T>
        </Pressable>
        <View style={styles.right}>
          {signedIn && (
            <Pressable
              onPress={() => {
                haptic();
                setPanel("recent");
              }}
              accessibilityRole="button"
              accessibilityLabel={`Phát gần đây (${recent.length})`}
              style={({ pressed }) => [
                styles.recentBtn,
                { borderColor: tint(t.amber, 0.4), backgroundColor: pressed ? t.amber : "transparent" },
              ]}
            >
              <Icon name="clock-history" size={14} color={t.amber} />
              <View style={styles.count}>
                <T weight="bold" size={10.5} color="#fff">
                  {recent.length}
                </T>
              </View>
            </Pressable>
          )}
          <RoundButton
            icon={t.dark ? "moon-stars-fill" : "sun-fill"}
            color={t.violet}
            label={t.dark ? "Chuyển sang giao diện sáng" : "Chuyển sang giao diện tối"}
            onPress={toggleTheme}
          />
          {signedIn && <UserButton onPress={() => setPanel("card")} />}
        </View>
      </View>
      {signedIn && (
        <>
          <UserCard
            open={panel === "card"}
            onClose={() => setPanel(null)}
            onSettings={() => setPanel("settings")}
            top={insets.top + HEADER_H - 2}
          />
          <RecentPanel open={panel === "recent"} onClose={() => setPanel(null)} />
          <SettingsSheet open={panel === "settings"} onClose={() => setPanel(null)} />
        </>
      )}
    </View>
  );
}

function UserAvatar({ size }: { size: number }) {
  const t = useTheme();
  const { me } = useAuth();
  const id = String(me?.id ?? "");
  const name = [me?.firstName, me?.lastName].filter(Boolean).join(" ") || me?.username || "?";
  return (
    <View
      style={{
        width: size + 7,
        height: size + 7,
        borderRadius: (size + 7) / 2,
        borderWidth: 1.5,
        borderColor: tint(t.violet, 0.6),
        padding: 2,
        backgroundColor: t.surface,
      }}
    >
      <View
        style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: colorFor(id) }]}
      >
        <T weight="bold" size={size * 0.43} color="#fff">
          {initialOf(name)}
        </T>
      </View>
    </View>
  );
}

function UserButton({ onPress }: { onPress: () => void }) {
  const { me } = useAuth();
  const name = [me?.firstName, me?.lastName].filter(Boolean).join(" ");
  return (
    <Pressable
      onPress={() => {
        haptic();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={`Tài khoản: ${name}`}
      hitSlop={6}
    >
      <UserAvatar size={27} />
    </Pressable>
  );
}

function UserCard({
  open,
  onClose,
  onSettings,
  top,
}: {
  open: boolean;
  onClose: () => void;
  onSettings: () => void;
  top: number;
}) {
  const t = useTheme();
  const auth = useAuth();
  const toast = useToast();
  const me = auth.me;
  const id = String(me?.id ?? "");
  const color = colorFor(id);
  const name = [me?.firstName, me?.lastName].filter(Boolean).join(" ") || "?";
  // like the web's: synced (at what time), trying again, or this phone only (no sync server)
  const { sync } = useLibrary();
  const syncAt = sync?.lastSync
    ? ` · ${new Date(sync.lastSync).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}`
    : "";
  const syncRow: [string, string | undefined] =
    !sync || sync.off
      ? [sync ? "Chỉ lưu trên thiết bị này" : "Đang kết nối…", undefined]
      : sync.connected
        ? [`Đã đồng bộ${syncAt}`, t.green]
        : ["Mất kết nối, đang thử lại", t.amber];
  const rows: [IconName, string, string, string?][] = [
    ["telephone", "Số điện thoại", fmtPhone(me?.phone)],
    ["person-badge", "ID tài khoản", id],
    ["cloud", "Đồng bộ", ...syncRow],
  ];

  function signOut() {
    onClose();
    Alert.alert("Đăng xuất", "Bạn có muốn đăng xuất tài khoản khỏi DLiMusic?", [
      { text: "Huỷ", style: "cancel" },
      {
        text: "Đăng xuất",
        style: "destructive",
        onPress: () => {
          router.dismissTo("/");
          auth
            .signOut()
            .then(() => toast("Xin chào và hẹn gặp lại", "bye"))
            .catch((e) => toast(String(e?.message ?? e), "error"));
        },
      },
    ]);
  }

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Đóng" />
      <View style={[styles.card, { top, backgroundColor: t.surface, borderColor: t.border }]}>
        <LinearGradient
          colors={[mix(color, t.dark ? "#212529" : "#ffffff", 0.38), mix(color, t.dark ? "#212529" : "#ffffff", 0.12)]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.cardHead}
        >
          <View style={[styles.avatarLg, { backgroundColor: color, borderColor: t.surface }]}>
            <T weight="bold" size={18} color="#fff">
              {initialOf(name)}
            </T>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T weight="semibold" numberOfLines={1}>
              {name}
            </T>
            <T size={13} muted numberOfLines={1}>
              {me?.username ? `@${me.username}` : "Chưa đặt username"}
            </T>
          </View>
        </LinearGradient>
        <View style={styles.info}>
          {rows.map(([icon, label, value, color]) => (
            <View key={label} style={styles.infoRow}>
              <View style={styles.infoLabel}>
                <Icon name={icon} size={13} color={t.textMuted} />
                <T size={13} weight="medium" muted>
                  {label}
                </T>
              </View>
              <T size={13} style={styles.infoValue} color={color}>
                {value}
              </T>
            </View>
          ))}
        </View>
        <View style={[styles.actions, { borderTopColor: t.border }]}>
          <CardButton icon="gear" title="Cài đặt" color={t.violet} onPress={onSettings} />
          <CardButton icon="box-arrow-right" title="Đăng xuất" color={t.coral} onPress={signOut} />
        </View>
      </View>
    </Modal>
  );
}

function CardButton({
  icon,
  title,
  color,
  onPress,
}: {
  icon: IconName;
  title: string;
  color: string;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={() => {
        haptic();
        onPress();
      }}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.cardBtn,
        { borderColor: tint(color, 0.4), backgroundColor: pressed ? color : "transparent" },
      ]}
    >
      {({ pressed }) => (
        <>
          <Icon name={icon} size={13} color={pressed ? (t.dark ? "#111827" : "#fff") : color} />
          <T weight="medium" size={13} color={pressed ? (t.dark ? "#111827" : "#fff") : color}>
            {title}
          </T>
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    height: HEADER_H,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  brand: { flexDirection: "row", alignItems: "center", gap: 6, flex: 1 },
  logo: { width: 27, height: 27, borderRadius: 6 },
  right: { flexDirection: "row", alignItems: "center", gap: 8 },
  recentBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 30,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderRadius: 999,
  },
  count: { backgroundColor: "#6c757d", borderRadius: 999, minWidth: 18, paddingHorizontal: 5, alignItems: "center" },
  avatar: { alignItems: "center", justifyContent: "center" },
  card: {
    position: "absolute",
    right: 12,
    width: 300,
    maxWidth: "94%",
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    elevation: 12,
  },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  avatarLg: { width: 50, height: 50, borderRadius: 25, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  info: { paddingHorizontal: 16, paddingVertical: 13, gap: 8 },
  infoRow: { flexDirection: "row", gap: 12 },
  infoLabel: { flexDirection: "row", alignItems: "center", gap: 5 },
  infoValue: { flex: 1, textAlign: "right", fontVariant: ["tabular-nums"], fontFamily: FONT.regular },
  actions: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  cardBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 31,
    borderWidth: 1,
    borderRadius: 999,
  },
});
