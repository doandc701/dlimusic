// Short messages at the top, under the header, like the web's fun-toast: a coloured edge and round icon per
// kind, gone after 3.5 s. toast("…", "welcome").
import { LinearGradient } from "expo-linear-gradient";
import { createContext, use, useCallback, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeInUp, FadeOutUp } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useTheme } from "../theme";
import { Icon, type IconName } from "./Icon";
import { T } from "./ui";

export type ToastKind = "success" | "error" | "warn" | "info" | "bye" | "welcome";
const KINDS: Record<ToastKind, { k: string; k2: string; icon: IconName }> = {
  success: { k: "#10b981", k2: "#06b6d4", icon: "check-lg" },
  error: { k: "#f43f5e", k2: "#f97316", icon: "x-lg" },
  warn: { k: "#f59e0b", k2: "#f97316", icon: "exclamation-lg" },
  info: { k: "#8b5cf6", k2: "#ec4899", icon: "info-lg" },
  bye: { k: "#ec4899", k2: "#f43f5e", icon: "heart-fill" },
  welcome: { k: "#8b5cf6", k2: "#ec4899", icon: "emoji-heart-eyes-fill" },
};
export const HEADER_H = 54;

type Shown = { id: number; msg: string; kind: ToastKind };
const ToastContext = createContext<((msg: string, kind?: ToastKind) => void) | null>(null);
export const useToast = () => use(ToastContext)!;

export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [shown, setShown] = useState<Shown | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const seq = useRef(0);

  const toast = useCallback((msg: string, kind: ToastKind = "success") => {
    clearTimeout(timer.current);
    setShown({ id: ++seq.current, msg, kind });
    timer.current = setTimeout(() => setShown(null), 3500);
  }, []);

  const k = shown && KINDS[shown.kind];
  return (
    <ToastContext value={toast}>
      {children}
      {shown && k && (
        // taps go through the message to what is under it (like the web), except on the message itself
        <View pointerEvents="box-none" style={[styles.layer, { top: insets.top + HEADER_H + 8 }]}>
          <Animated.View
            key={shown.id}
            entering={FadeInUp.duration(180)}
            exiting={FadeOutUp.duration(160)}
            style={[
              styles.toast,
              { backgroundColor: t.surface, borderLeftColor: k.k, borderColor: `${k.k}4d`, shadowColor: k.k },
            ]}
            accessibilityRole="alert"
          >
            <Pressable onPress={() => setShown(null)} style={styles.inner} accessibilityLabel="Đóng">
              <LinearGradient colors={[k.k, k.k2]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.ico}>
                <Icon name={k.icon} size={14} color="#fff" />
              </LinearGradient>
              <T weight="medium" size={13} style={{ flexShrink: 1 }}>
                {shown.msg}
              </T>
            </Pressable>
          </Animated.View>
        </View>
      )}
    </ToastContext>
  );
}

const styles = StyleSheet.create({
  layer: { position: "absolute", left: 8, right: 8, alignItems: "center", zIndex: 1000 },
  toast: {
    maxWidth: "100%",
    borderRadius: 16,
    borderWidth: 1,
    borderLeftWidth: 5,
    shadowOpacity: 0.5,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  inner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    paddingLeft: 10,
    paddingRight: 16,
  },
  ico: { width: 26, height: 26, borderRadius: 13, alignItems: "center", justifyContent: "center" },
});
