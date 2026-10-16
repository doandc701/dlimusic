// DLiMusic look, the same as the web version (public/css/styles.css on Bootstrap 5.3): Bootstrap's light / dark
// surfaces, the playful palette (one colour per group of buttons), the violet → pink gradient, Be Vietnam Pro.
// Light / dark follows the system until the header button is used (also like the web).
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createContext, use, useEffect, useState, type ReactNode } from "react";
import { useColorScheme } from "react-native";

export const GRADIENT = ["#7c3aed", "#ec4899"] as const;

const light = {
  bg: "#f8f9fa", // page (--bs-tertiary-bg)
  surface: "#ffffff", // bars, cards, rows (--bs-body-bg)
  surfaceAlt: "#e9ecef", // --bs-secondary-bg
  border: "#dee2e6",
  text: "#212529",
  textMuted: "rgba(33, 37, 41, 0.75)",
  primary: "#7c3aed",
  violet: "#7c3aed",
  pink: "#db2777",
  orange: "#ea580c",
  amber: "#d97706",
  green: "#059669",
  teal: "#0d9488",
  sky: "#0284c7",
  indigo: "#4f46e5",
  coral: "#e11d48",
  slate: "#64748b",
  badge: "#ffc107",
  badgeText: "#000000",
  selected: "#ede9fe", // a ticked row (--bs-primary-bg-subtle)
  backdrop: "rgba(0, 0, 0, 0.5)",
};
const dark: typeof light = {
  bg: "#2b3035",
  surface: "#212529",
  surfaceAlt: "#343a40",
  border: "#495057",
  text: "#dee2e6",
  textMuted: "rgba(222, 226, 230, 0.75)",
  primary: "#8b5cf6",
  violet: "#a78bfa",
  pink: "#f472b6",
  orange: "#fb923c",
  amber: "#fbbf24",
  green: "#34d399",
  teal: "#2dd4bf",
  sky: "#38bdf8",
  indigo: "#818cf8",
  coral: "#fb7185",
  slate: "#94a3b8",
  badge: "#ffc107",
  badgeText: "#000000",
  selected: "#5b21b6",
  backdrop: "rgba(0, 0, 0, 0.5)",
};

export type Theme = typeof light & { dark: boolean };
type Mode = "light" | "dark" | "system";

const ThemeContext = createContext<{ theme: Theme; toggle: () => void } | null>(null);
const KEY = "theme"; // "light" / "dark"; nothing = follow the system

export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme() === "dark" ? "dark" : "light";
  const [mode, setMode] = useState<Mode>("system");
  useEffect(() => {
    AsyncStorage.getItem(KEY)
      .then((v) => (v === "light" || v === "dark") && setMode(v))
      .catch(() => {});
  }, []);
  const shown = mode === "system" ? system : mode;
  const toggle = () => {
    const next = shown === "dark" ? "light" : "dark";
    // picking what the system already shows = follow the system again
    const m: Mode = next === system ? "system" : next;
    setMode(m);
    (m === "system" ? AsyncStorage.removeItem(KEY) : AsyncStorage.setItem(KEY, m)).catch(() => {});
  };
  const theme = { ...(shown === "dark" ? dark : light), dark: shown === "dark" };
  return <ThemeContext value={{ theme, toggle }}>{children}</ThemeContext>;
}

export const useTheme = (): Theme => use(ThemeContext)!.theme;
export const useThemeToggle = () => use(ThemeContext)!.toggle;

/** A colour with some transparency: tint("#7c3aed", 0.16). */
export function tint(color: string, alpha: number) {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export const FONT = {
  regular: "BeVietnamPro_400Regular",
  medium: "BeVietnamPro_500Medium",
  semibold: "BeVietnamPro_600SemiBold",
  bold: "BeVietnamPro_700Bold",
};

export const RADIUS = { sm: 6, md: 8, lg: 12, card: 6, pill: 999 };

/** CSS color-mix(in srgb, a p%, b) for "#rrggbb" colours: mix(userColor, t.surface, 0.38). */
export function mix(a: string, b: string, p: number) {
  const rgb = (c: string) => {
    const n = parseInt(c.slice(1, 7), 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
  };
  if (!/^#[0-9a-f]{6}$/i.test(a) || !/^#[0-9a-f]{6}$/i.test(b)) return a;
  const [x, y] = [rgb(a), rgb(b)];
  return `rgb(${x.map((v, i) => Math.round(v * p + y[i] * (1 - p))).join(", ")})`;
}
