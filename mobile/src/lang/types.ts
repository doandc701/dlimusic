import type en from "./en";

/** One language of the app: one file in src/lang/, listed in src/lang/index.ts. */
export type LangFile = {
  label: string; // its name, written in that language
  locale: string; // for dates and times
  dict: Record<string, string>; // the Vietnamese text -> its translation
};

/** A translation: exactly the sentences of en.ts (typecheck names any missing or unknown one). */
export type Translation = LangFile & { dict: Record<keyof (typeof en)["dict"], string> };
