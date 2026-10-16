// Building blocks in the web's look (Bootstrap + public/css/styles.css): text, the gradient button, the
// playful outline pills (each group its own colour), round icon buttons, avatars, checkboxes, badges.
import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextProps,
  type ViewStyle,
} from "react-native";

import { FONT, GRADIENT, RADIUS, tint, useTheme } from "../theme";
import { Icon, type IconName } from "./Icon";

export const haptic = () => Haptics.selectionAsync().catch(() => {});

export function T({
  style,
  weight = "regular",
  muted,
  size = 15,
  color,
  ...rest
}: TextProps & { weight?: keyof typeof FONT; muted?: boolean; size?: number; color?: string }) {
  const t = useTheme();
  return (
    <Text
      allowFontScaling={false}
      {...rest}
      style={[{ fontFamily: FONT[weight], fontSize: size, color: color ?? (muted ? t.textMuted : t.text) }, style]}
    />
  );
}

/** The primary button: violet → pink gradient, white text (#loginBtn, "Lưu", "Xong", "Tải xuống"). */
export function GradientButton({
  title,
  icon,
  onPress,
  busy,
  disabled,
  radius = RADIUS.sm,
  height = 44,
  size = 16,
  colors = GRADIENT,
  style,
}: {
  title: string;
  icon?: IconName;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  radius?: number;
  height?: number;
  size?: number;
  colors?: readonly [string, string];
  style?: StyleProp<ViewStyle>;
}) {
  const off = disabled || busy;
  return (
    <Pressable
      onPress={() => {
        haptic();
        onPress();
      }}
      disabled={off}
      accessibilityRole="button"
      style={({ pressed }) => [{ opacity: off ? 0.45 : 1, transform: [{ scale: pressed ? 0.97 : 1 }] }, style]}
    >
      <LinearGradient
        colors={colors}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.grad, { height, borderRadius: radius, shadowColor: colors[1] }]}
      >
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <View style={styles.row}>
            {icon && <Icon name={icon} size={size} color="#fff" />}
            <Text allowFontScaling={false} style={{ color: "#fff", fontFamily: FONT.semibold, fontSize: size }}>
              {title}
            </Text>
          </View>
        )}
      </LinearGradient>
    </Pressable>
  );
}

/** An outline pill in one colour of the playful palette (btn-outline-* with --c): "Lọc", "Chọn hiển thị"… */
export function Pill({
  title,
  icon,
  color,
  onPress,
  active,
  small,
  badge,
  label,
  style,
}: {
  title?: string;
  icon?: IconName;
  color: string;
  onPress: () => void;
  active?: boolean;
  small?: boolean;
  badge?: number | string;
  label?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const h = small ? 26 : 30;
  return (
    <Pressable
      onPress={() => {
        haptic();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={label ?? title}
      hitSlop={6}
      style={({ pressed }) => [
        styles.pill,
        {
          height: h,
          minWidth: h,
          paddingHorizontal: title ? (small ? 9 : 10) : 0,
          borderColor: active ? color : tint(color, 0.4),
          backgroundColor: active || pressed ? color : "transparent",
        },
        style,
      ]}
    >
      {({ pressed }) => {
        const fg = active || pressed ? (t.dark ? "#111827" : "#fff") : color;
        return (
          <>
            {icon && <Icon name={icon} size={small ? 12 : 14} color={fg} />}
            {title ? (
              <Text allowFontScaling={false} style={{ color: fg, fontFamily: FONT.medium, fontSize: small ? 12 : 13 }}>
                {title}
              </Text>
            ) : null}
            {badge !== undefined && badge !== "" && badge !== 0 ? (
              <View style={[styles.pillBadge, { backgroundColor: t.violet }]}>
                <Text allowFontScaling={false} style={styles.pillBadgeText}>
                  {badge}
                </Text>
              </View>
            ) : null}
          </>
        );
      }}
    </Pressable>
  );
}

/** Round outline icon button of the header / list head (theme, ‹ back…), 31px like the web's btn-sm btn-icon. */
export function RoundButton({
  icon,
  color,
  onPress,
  label,
  size = 31,
  iconSize = 15,
  square,
  style,
}: {
  icon: IconName;
  color: string;
  onPress: () => void;
  label: string;
  size?: number;
  iconSize?: number;
  square?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={() => {
        haptic();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={({ pressed }) => [
        {
          width: size,
          height: size - 1,
          borderRadius: square ? 4 : size / 2,
          borderWidth: 1,
          borderColor: tint(color, 0.4),
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: pressed ? color : "transparent",
        },
        style,
      ]}
    >
      {({ pressed }) => <Icon name={icon} size={iconSize} color={pressed ? (t.dark ? "#111827" : "#fff") : color} />}
    </Pressable>
  );
}

/** A borderless icon button (player controls, hearts, ✕). */
export function IconButton({
  icon,
  color,
  size = 20,
  box = 34,
  onPress,
  label,
  disabled,
  style,
}: {
  icon: IconName;
  color: string;
  size?: number;
  box?: number;
  onPress: () => void;
  label: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      onPress={() => {
        haptic();
        onPress();
      }}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={({ pressed }) => [
        {
          width: box,
          height: box,
          borderRadius: box / 2,
          alignItems: "center",
          justifyContent: "center",
          opacity: disabled ? 0.35 : 1,
          backgroundColor: pressed ? tint(color, 0.16) : "transparent",
        },
        style,
      ]}
    >
      <Icon name={icon} size={size} color={color} />
    </Pressable>
  );
}

// Avatars: the web's colours, picked from the id the same way (public/js/ui.js COLORS)
const COLORS = ["#e57373", "#f06292", "#ba68c8", "#7986cb", "#4fc3f7", "#4db6ac", "#81c784", "#ffb74d", "#a1887f"];
export const colorFor = (id: string) =>
  COLORS[Math.abs([...id].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % COLORS.length];
export const initialOf = (name: string) => [...name.replace(/[^\p{L}\p{N}]/gu, "")][0]?.toUpperCase() || "?";

export function Avatar({
  name,
  id,
  size = 36,
  children,
}: {
  name: string;
  id: string;
  size?: number;
  children?: ReactNode;
}) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: colorFor(id),
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {children ?? (
        <Text allowFontScaling={false} style={{ color: "#fff", fontFamily: FONT.semibold, fontSize: size * 0.42 }}>
          {initialOf(name)}
        </Text>
      )}
    </View>
  );
}

/** Bootstrap's checkbox (16px, rounded 4, violet when ticked; `mixed` = some ticked). */
export function Checkbox({
  checked,
  mixed,
  onPress,
  label,
}: {
  checked: boolean;
  mixed?: boolean;
  onPress: () => void;
  label: string;
}) {
  const t = useTheme();
  const on = checked || mixed;
  return (
    <Pressable
      onPress={() => {
        haptic();
        onPress();
      }}
      hitSlop={12}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: mixed ? "mixed" : checked }}
      accessibilityLabel={label}
      style={[styles.check, { borderColor: on ? t.primary : t.border, backgroundColor: on ? t.primary : t.surface }]}
    >
      {mixed ? <View style={styles.dash} /> : checked ? <Icon name="check-lg" size={12} color="#fff" /> : null}
    </Pressable>
  );
}

/** The yellow "Nghe thử" badge (text-bg-warning). */
export function Badge({ text, color, textColor }: { text: string; color?: string; textColor?: string }) {
  const t = useTheme();
  return (
    <View style={[styles.badge, { backgroundColor: color ?? t.badge }]}>
      <Text allowFontScaling={false} style={{ fontFamily: FONT.bold, fontSize: 10, color: textColor ?? t.badgeText }}>
        {text}
      </Text>
    </View>
  );
}

export function fmtDur(s?: number) {
  if (!s || !Number.isFinite(s)) return "";
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function fmtSize(n: number) {
  if (!n) return "";
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return `${(n / 1024 ** i).toFixed(1)} ${u[i]}`;
}

const styles = StyleSheet.create({
  grad: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    shadowOpacity: 0.5,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 6 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    borderWidth: 1,
    borderRadius: RADIUS.pill,
  },
  pillBadge: {
    position: "absolute",
    top: -7,
    right: -5,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  pillBadgeText: { color: "#fff", fontFamily: FONT.bold, fontSize: 10 },
  check: { width: 18, height: 18, borderRadius: 4, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  dash: { width: 9, height: 2, borderRadius: 1, backgroundColor: "#fff" },
  badge: { borderRadius: 5, paddingHorizontal: 5, paddingVertical: 1.5 },
});
