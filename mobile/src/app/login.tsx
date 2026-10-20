// Sign-in, like the web's card: phone (country code in front) → the 5-digit code sent to the Telegram app →
// the two-step password. Same words as the web. (No QR code here: it has to be scanned from another device.)
import { Redirect } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Image, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TextInput, View } from "react-native";

import { OtpBoxes } from "@/components/OtpBoxes";
import { PhoneField } from "@/components/PhoneField";
import { useToast } from "@/components/Toast";
import { GradientButton, T } from "@/components/ui";
import { t as tNow, useT } from "@/i18n";
import { useAuth } from "@/telegram/AuthProvider";
import { LoginFlow, apiReady, type LoginStep } from "@/telegram/login";
import { composePhone, phoneMessage } from "@/telegram/phone";
import { FONT, useTheme } from "@/theme";

// the same words as the web's sign-in (public/js/ui.js LOGIN_STEPS; the button always says "Tiếp tục"),
// translated where they are shown
const TEXT: Record<Exclude<LoginStep, "done">, { title: string; desc: string }> = {
  phone: { title: "Đăng nhập DLiMusic", desc: "Nhập số điện thoại của bạn." },
  code: { title: "Nhập mã xác nhận", desc: "DLiMusic vừa gửi mã vào app Telegram của bạn (không phải SMS)." },
  password: { title: "Mật khẩu 2 lớp", desc: "Tài khoản bật xác minh 2 bước, nhập mật khẩu." },
};

export default function Login() {
  const t = useTheme();
  const tr = useT();
  const auth = useAuth();
  const toast = useToast();
  const [step, setStep] = useState<Exclude<LoginStep, "done">>("phone");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("84"); // country code in front of the number
  const [checked, setChecked] = useState(false); // after the first "Tiếp tục", the number re-checks while typing
  const flow = useRef<LoginFlow | null>(null);

  // one sign-in run: asks the phone first, then whatever Telegram needs
  function startFlow() {
    flow.current?.cancel();
    const f = new LoginFlow({
      onStep: (s) => {
        if (flow.current !== f) return;
        setBusy(false);
        if (s === "done") {
          auth.refresh().then((user) => {
            // tNow: this callback outlives the render it was made in, the language may have changed since
            const full = [user?.firstName, user?.lastName].filter(Boolean).join(" ") || tNow("bạn");
            const name = [...full].length > 18 ? [...full].slice(0, 17).join("").trimEnd() + "…" : full;
            toast(tNow("Chào mừng {name} quay trở lại 🥰", { name }), "welcome");
          });
          return;
        }
        setStep(s);
        setValue("");
      },
      onError: (msg) => {
        if (flow.current !== f) return;
        setBusy(false);
        setError(msg);
      },
    });
    flow.current = f;
    f.start();
  }
  useEffect(() => {
    startFlow();
    return () => flow.current?.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (auth.state === "in") return <Redirect href="/" />;

  /** "+<code><number>", or null (and why, on the field). */
  function checkPhone(typed = value, c = code) {
    if (!typed.trim()) {
      setError("Hãy nhập số điện thoại."); // kept in Vietnamese, translated where it is shown
      return null;
    }
    const full = composePhone(c, typed);
    setError(full ? undefined : phoneMessage(c));
    return full;
  }

  function submit(v = value.trim()) {
    if (step === "phone") {
      setChecked(true);
      const phone = checkPhone();
      if (!phone) return;
      setBusy(true);
      flow.current?.answer(phone);
    } else {
      if (!v) return;
      setError(undefined);
      setBusy(true);
      flow.current?.answer(v);
    }
  }

  const text = TEXT[step];
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.border }]}>
          <Image source={require("@/assets/images/logo-192.png")} style={styles.logo} />
          <T weight="semibold" size={22} style={{ textAlign: "center", letterSpacing: -0.2 }}>
            {tr(text.title)}
          </T>
          <T muted style={{ textAlign: "center", marginTop: 6, marginBottom: 16 }}>
            {tr(text.desc)}
          </T>
          {!apiReady() && (
            <T color={t.coral} style={{ marginBottom: 12 }}>
              {tr("Thiếu API ID / API hash: thêm API_ID, API_HASH vào file .env của dự án rồi chạy lại.")}
            </T>
          )}

          {step === "phone" ? (
            <PhoneField
              code={code}
              onCode={(c) => {
                setCode(c);
                if (checked) checkPhone(value, c);
              }}
              value={value}
              onChange={(v) => {
                setValue(v);
                if (checked) checkPhone(v);
                else if (error) setError(undefined);
              }}
              onSubmit={() => submit()}
              invalid={!!error}
            />
          ) : step === "code" ? (
            <OtpBoxes key="code" invalid={!!error} onDone={(c) => submit(c)} />
          ) : (
            <TextInput
              allowFontScaling={false}
              value={value}
              onChangeText={setValue}
              onSubmitEditing={() => submit()}
              placeholder={tr("Mật khẩu")}
              placeholderTextColor={t.textMuted}
              secureTextEntry
              autoComplete="password"
              textContentType="password"
              autoFocus
              style={[
                styles.input,
                { color: t.text, backgroundColor: t.surface, borderColor: error ? t.coral : t.border },
              ]}
            />
          )}
          {error && (
            <T size={13} color={t.coral} style={{ marginTop: 6 }}>
              {tr(error)}
            </T>
          )}
          <GradientButton
            title={tr("Tiếp tục")}
            onPress={() => submit()}
            busy={busy}
            radius={6}
            height={42}
            style={{ marginTop: 22 }}
          />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { flexGrow: 1, justifyContent: "center", padding: 16 },
  card: { borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, padding: 24 },
  logo: {
    width: 72,
    height: 72,
    borderRadius: 16,
    alignSelf: "center",
    marginBottom: 14,
    shadowColor: "#4c1d95",
    shadowOpacity: 0.6,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 8 },
  },
  input: { height: 40, borderRadius: 6, borderWidth: 1, paddingHorizontal: 12, fontSize: 16, fontFamily: FONT.regular },
});
