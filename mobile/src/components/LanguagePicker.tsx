// The language switch: a row of four choices (Cài đặt), and the header's round 文A button (signed out) that opens
// the same list as a sheet. Each language is always written in its own words.
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { LANGS, useT } from "../i18n";
import { tint, useTheme } from "../theme";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";
import { RoundButton, T, haptic } from "./ui";

/** The four languages as one outlined group, the picked one filled (like the web's btn-group). */
export function LanguageChoices() {
  const t = useTheme();
  const { lang, setLang } = useT();
  return (
    <View style={[styles.group, { borderColor: tint(t.violet, 0.4) }]} accessibilityRole="radiogroup">
      {LANGS.map((l, i) => {
        const on = l.code === lang;
        return (
          <Pressable
            key={l.code}
            onPress={() => {
              haptic();
              setLang(l.code);
            }}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            accessibilityLabel={l.label}
            style={({ pressed }) => [
              styles.choice,
              i > 0 && { borderLeftWidth: 1, borderLeftColor: tint(t.violet, 0.4) },
              { backgroundColor: on ? t.violet : pressed ? tint(t.violet, 0.16) : "transparent" },
            ]}
          >
            <T size={13} weight="medium" numberOfLines={1} color={on ? "#fff" : t.violet}>
              {l.label}
            </T>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The header's language button: opens the list from the bottom. */
export function LanguageButton() {
  const t = useTheme();
  const tr = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <RoundButton icon="translate" color={t.violet} label={tr("Ngôn ngữ")} onPress={() => setOpen(true)} />
      <Sheet open={open} onClose={() => setOpen(false)} title={tr("Ngôn ngữ")} icon="translate" bottom>
        <View style={{ marginHorizontal: -16 }}>
          {LANGS.map((l) => {
            const on = l.code === tr.lang;
            return (
              <Pressable
                key={l.code}
                onPress={() => {
                  haptic();
                  tr.setLang(l.code);
                  setOpen(false);
                }}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                style={({ pressed }) => [
                  styles.option,
                  { backgroundColor: on ? t.primary : pressed ? t.surfaceAlt : "transparent" },
                ]}
              >
                <T style={{ flex: 1 }} color={on ? "#fff" : undefined}>
                  {l.label}
                </T>
                {on && <Icon name="check2" size={15} color="#fff" />}
              </Pressable>
            );
          })}
        </View>
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  group: { flexDirection: "row", borderWidth: 1, borderRadius: 6, overflow: "hidden" },
  choice: { flex: 1, alignItems: "center", justifyContent: "center", height: 34, paddingHorizontal: 4 },
  option: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 12 },
});
