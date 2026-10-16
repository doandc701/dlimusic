// The phone field of the sign-in, like the web's: the country (flag + code, +84 by default, remembered) in
// front, the rest of the number in the field. Tapping the country opens a sheet to pick another one.
import * as Haptics from "expo-haptics";
import { useEffect, useState } from "react";
import { FlatList, Pressable, StyleSheet, TextInput, View } from "react-native";

import { storage } from "../storage";
import { COUNTRIES, countryOf, flag } from "../telegram/phone";
import { FONT, useTheme } from "../theme";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";
import { T } from "./ui";

const CODE_KEY = "tdl.phoneCode";

export function PhoneField({
  code,
  onCode,
  value,
  onChange,
  onSubmit,
  invalid,
}: {
  code: string;
  onCode: (code: string) => void;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  invalid?: boolean;
}) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const country = countryOf(code);

  // the country picked last time on this phone
  useEffect(() => {
    storage
      .get(CODE_KEY)
      .then((saved) => saved && COUNTRIES.some((c) => c.code === saved) && onCode(saved))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pick(c: string) {
    Haptics.selectionAsync().catch(() => {});
    onCode(c);
    storage.set(CODE_KEY, c).catch(() => {});
    setOpen(false);
  }

  const border = invalid ? t.coral : t.border;
  return (
    <>
      <View style={[styles.group, { borderColor: border, backgroundColor: t.surface }]}>
        <Pressable
          onPress={() => setOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={`Mã quốc gia: ${country.name} (+${country.code})`}
          style={({ pressed }) => [styles.code, { borderRightColor: border, opacity: pressed ? 0.6 : 1 }]}
        >
          <T size={17}>{flag(country.cc)}</T>
          <T size={15.2}>+{country.code}</T>
          <Icon name="caret-down-fill" size={9} color={t.text} />
        </Pressable>
        <TextInput
          allowFontScaling={false}
          value={value}
          onChangeText={onChange}
          onSubmitEditing={onSubmit}
          placeholder={code === "84" ? "912 345 678" : "Số điện thoại"}
          placeholderTextColor={t.textMuted}
          keyboardType="phone-pad"
          autoComplete="tel"
          textContentType="telephoneNumber"
          maxLength={20}
          autoFocus
          style={[styles.input, { color: t.text }]}
          accessibilityLabel="Số điện thoại"
        />
      </View>

      <Sheet open={open} onClose={() => setOpen(false)} title="Mã quốc gia" icon="globe2" bottom>
        <FlatList
          data={COUNTRIES}
          keyExtractor={(c) => c.code}
          style={{ marginHorizontal: -16 }}
          renderItem={({ item }) => {
            const active = item.code === code;
            return (
              <Pressable
                onPress={() => pick(item.code)}
                style={({ pressed }) => [
                  styles.row,
                  { backgroundColor: active ? t.primary : pressed ? t.surfaceAlt : "transparent" },
                ]}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
              >
                <T size={20}>{flag(item.cc)}</T>
                <T style={{ flex: 1 }} color={active ? "#fff" : undefined}>
                  {item.name}
                </T>
                <T size={13} muted={!active} color={active ? "#fff" : undefined}>
                  +{item.code}
                </T>
              </Pressable>
            );
          }}
        />
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  group: { flexDirection: "row", alignItems: "stretch", height: 40, borderRadius: 6, borderWidth: 1 },
  code: { flexDirection: "row", alignItems: "center", gap: 5, paddingLeft: 11, paddingRight: 8, borderRightWidth: 1 },
  input: { flex: 1, paddingHorizontal: 12, fontSize: 16, fontFamily: FONT.regular },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 11 },
});
