// Bootstrap Icons, the icon font of the web version (bootstrap-icons 1.13.1, MIT — assets/fonts), so both show
// the very same icons: <Icon name="heart-fill" size={18} color={t.pink} />.
import { Text, type StyleProp, type TextStyle } from "react-native";

import glyphs from "./bootstrap-icons.json";

export type IconName = keyof typeof glyphs;

export function Icon({
  name,
  size = 16,
  color,
  style,
}: {
  name: IconName;
  size?: number;
  color?: string;
  style?: StyleProp<TextStyle>;
}) {
  return (
    <Text
      style={[{ fontFamily: "bootstrap-icons", fontSize: size, lineHeight: size * 1.05, color }, style]}
      allowFontScaling={false}
      accessible={false}
    >
      {String.fromCodePoint(glyphs[name])}
    </Text>
  );
}
