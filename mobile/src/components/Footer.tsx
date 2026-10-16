// The brand line at the very bottom, like the web's: "© 2026 DLiMusic · Chạm là nghe, nhấn là tải".
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useTheme } from "../theme";
import { T } from "./ui";

export const SLOGAN = "Chạm là nghe, nhấn là tải";

export function Footer({ bar }: { bar?: boolean }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.foot,
        { paddingBottom: Math.max(insets.bottom, 5) },
        bar && { backgroundColor: t.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.border },
      ]}
    >
      <T size={12} muted style={{ textAlign: "center", letterSpacing: 0.12 }}>
        © {new Date().getFullYear()} DLiMusic · {SLOGAN}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  foot: { paddingTop: 5, paddingHorizontal: 16 },
});
