// The app's languages: Vietnamese is the source (every string is written in Vietnamese in the code), the others
// are dictionaries keyed by that exact text. t("Đã chọn {n}/{total}", { n: 3, total: 9 }) -> "3/9 selected"; a
// missing key shows the Vietnamese. "{n|file|files}" in a translation picks the singular when n is 1. Picked in Cài đặt or on the
// sign-in screen, remembered like the theme.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { LANG_FILES } from "./lang";

export type Lang = keyof typeof LANG_FILES;
type Vars = Record<string, string | number>;
export type Translate = (vi: string, vars?: Vars) => string;

/** The choices (one file each in src/lang/), each named in its own language. */
export const LANGS = (Object.keys(LANG_FILES) as Lang[]).map((code) => ({ code, label: LANG_FILES[code].label }));

/** For dates / times and sorting in the picked language. */
export const LOCALE = Object.fromEntries(LANGS.map(({ code }) => [code, LANG_FILES[code].locale])) as Record<
  Lang,
  string
>;

// Messages built with numbers / codes outside the app (core.js, the sync server): matched by shape, the parts
// carried over as vars. The Vietnamese key (with its {placeholders}) is then looked up like any other.
const PATTERNS: [RegExp, string, string[]][] = [
  [
    /^Bạn thử quá nhiều lần\. Telegram yêu cầu đợi (\d+) (giờ|phút|giây) rồi thử lại\.$/,
    "Bạn thử quá nhiều lần. Telegram yêu cầu đợi {n} {unit} rồi thử lại.",
    ["n", "unit"],
  ],
  [
    /^Telegram từ chối đăng nhập \((.+)\)\. Vui lòng thử lại\.$/,
    "Telegram từ chối đăng nhập ({code}). Vui lòng thử lại.",
    ["code"],
  ],
  [/^Máy chủ đồng bộ trả lỗi (\d+)$/, "Máy chủ đồng bộ trả lỗi {status}", ["status"]],
];

const KEY = "lang";
let current: Lang = "vi"; // read by the plain t() outside components

function fill(text: string, vars?: Vars) {
  if (!vars) return text;
  return text
    .replace(/\{(\w+)\|([^|}]*)\|([^}]*)\}/g, (_, k, one, many) => (Number(vars[k]) === 1 ? one : many))
    .replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

function translate(lang: Lang, vi: string, vars?: Vars): string {
  if (lang === "vi" || !vi) return fill(vi, vars);
  const dict: Record<string, string> = LANG_FILES[lang].dict;
  const hit = dict[vi];
  if (hit !== undefined) return fill(hit, vars);
  for (const [re, key, names] of PATTERNS) {
    const m = re.exec(vi);
    if (!m) continue;
    const got: Vars = { ...vars };
    names.forEach((n, i) => (got[n] = n === "unit" ? translate(lang, m[i + 1]) : m[i + 1]));
    return fill(dict[key] ?? key, got);
  }
  return fill(vi, vars);
}

/** The plain t() for code outside React (reads the language last picked). */
export const t = (vi: string, vars?: Vars) => translate(current, vi, vars);

type Ctx = { lang: Lang; ready: boolean; setLang: (l: Lang) => void };
const LangContext = createContext<Ctx>({ lang: "vi", ready: true, setLang: () => {} });

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, set] = useState<Lang>(current);
  // the splash screen stays up until the saved language is read, so Vietnamese does not flash first
  const [ready, setReady] = useState(false);
  useEffect(() => {
    AsyncStorage.getItem(KEY)
      .then((v) => {
        if (v && LANGS.some((l) => l.code === v)) {
          current = v as Lang;
          set(v as Lang);
        }
      })
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);
  const setLang = useCallback((l: Lang) => {
    current = l;
    set(l);
    (l === "vi" ? AsyncStorage.removeItem(KEY) : AsyncStorage.setItem(KEY, l)).catch(() => {});
  }, []);
  return <LangContext value={{ lang, ready, setLang }}>{children}</LangContext>;
}

/** t() bound to the current language (the component draws again when it changes), plus the language itself. */
export function useT() {
  const { lang, ready, setLang } = use(LangContext);
  return useMemo(
    () =>
      Object.assign((vi: string, vars?: Vars) => translate(lang, vi, vars), {
        lang,
        ready,
        setLang,
        locale: LOCALE[lang],
      }),
    [lang, ready, setLang],
  );
}
