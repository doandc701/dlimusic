// The verification code, one box per digit like the web's (5 boxes): typing moves on, Backspace goes back,
// pasting or the phone's autofill fills them all; the 5th digit sends it.
import { useRef, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";

import { FONT, mix, tint, useTheme } from "../theme";

export const OTP_LEN = 5; // Telegram login codes are 5 digits

export function OtpBoxes({ onDone, invalid }: { onDone: (code: string) => void; invalid?: boolean }) {
  const t = useTheme();
  const [digits, setDigits] = useState<string[]>(Array(OTP_LEN).fill(""));
  const [focus, setFocus] = useState(0);
  const refs = useRef<(TextInput | null)[]>([]);

  function fill(from: number, text: string) {
    const next = [...digits];
    let i = from;
    for (const d of text.replace(/\D/g, "")) {
      if (i >= OTP_LEN) break;
      next[i++] = d;
    }
    if (!text) next[from] = "";
    setDigits(next);
    if (text) refs.current[Math.min(i, OTP_LEN - 1)]?.focus();
    const code = next.join("");
    if (code.length === OTP_LEN) onDone(code);
  }

  return (
    <View style={styles.row} accessibilityRole="none" accessibilityLabel="Mã xác nhận">
      {digits.map((d, i) => (
        <TextInput
          allowFontScaling={false}
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          value={d}
          onChangeText={(v) => fill(i, v.slice(d ? 1 : 0) || v)}
          onKeyPress={(e) => {
            if (e.nativeEvent.key === "Backspace" && !d && i > 0) {
              const next = [...digits];
              next[i - 1] = "";
              setDigits(next);
              refs.current[i - 1]?.focus();
            }
          }}
          onFocus={() => setFocus(i)}
          keyboardType="number-pad"
          textContentType={i === 0 ? "oneTimeCode" : "none"}
          autoComplete={i === 0 ? "one-time-code" : "off"}
          autoFocus={i === 0}
          maxLength={i === 0 ? OTP_LEN : 2}
          selectTextOnFocus
          accessibilityLabel={`Số thứ ${i + 1}`}
          style={[
            styles.box,
            {
              color: t.text,
              borderColor: invalid ? t.coral : focus === i ? t.violet : d ? tint(t.pink, 0.6) : t.border,
              backgroundColor: d ? mix(t.pink, t.dark ? "#212529" : "#ffffff", 0.08) : t.surface,
            },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", justifyContent: "center", gap: 9 },
  box: {
    width: 42,
    height: 48,
    borderRadius: 14,
    borderWidth: 2,
    textAlign: "center",
    fontSize: 21,
    fontFamily: FONT.semibold,
    padding: 0,
  },
});
