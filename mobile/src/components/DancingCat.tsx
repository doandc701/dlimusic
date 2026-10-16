// The cat of the start screen: the cat with headphones bobbing gently, or — while music plays — the two dancing
// kittens. The kittens are the web's 3x13 frame grid (cat-dance-grid.webp, 320x224 frames), one frame shown at a
// time through a clipping box, 100ms a frame at normal speed — faster or slower with the playback speed (like the
// web's --cat-rate).
import { Image } from "expo-image";
import { useEffect, useState } from "react";
import { AccessibilityInfo, StyleSheet, View } from "react-native";
import { useTheme } from "@/theme";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";

const COLS = 3;
const ROWS = 13;
const FRAMES = 39;
const FRAME_W = 320;
const FRAME_H = 224;

export function DancingCat({ dancing, height = 200, rate = 1 }: { dancing: boolean; height?: number; rate?: number }) {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduce);
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduce);
    return () => sub.remove();
  }, []);
  return dancing && !reduce ? <Kittens height={height} rate={rate} /> : <StillCat height={height} still={reduce} />;
}

function StillCat({ height, still }: { height: number; still: boolean }) {
  const t = useTheme();
  const bob = useSharedValue(0);
  useEffect(() => {
    if (!still) bob.set(withRepeat(withTiming(1, { duration: 1600, easing: Easing.inOut(Easing.sin) }), -1, true));
  }, [bob, still]);
  const style = useAnimatedStyle(() => ({
    // the tail sticks out to the right: shifted like the web (11%) so the cat itself is in the middle
    transform: [
      { translateX: ((height * 233) / 320) * 0.11 },
      { translateY: -6 * bob.value },
      { rotate: `${-1.5 * bob.value}deg` },
    ],
  }));
  // like the web's drop-shadow: the shadow follows the cat's own shape (a blurred copy of the picture in the
  // shadow's colour, behind it) — a view's shadow on iOS filled the picture's whole box, which showed as a
  // background around the cat. In the dark a warm glow, so the black headphones stay visible.
  const shade = t.dark
    ? { tint: "rgb(255, 196, 130)", opacity: 0.35, blur: 14, y: 0 }
    : { tint: "#000000", opacity: 0.22, blur: 10, y: 10 };
  const size = { height, aspectRatio: 233 / 320 };
  return (
    <Animated.View style={[size, style]}>
      <Image
        source={require("@/assets/images/cat-headphones.webp")}
        style={[StyleSheet.absoluteFill, { opacity: shade.opacity, transform: [{ translateY: shade.y }] }]}
        tintColor={shade.tint}
        blurRadius={shade.blur}
        contentFit="contain"
        accessible={false}
      />
      <Image
        source={require("@/assets/images/cat-headphones.webp")}
        style={StyleSheet.absoluteFill}
        contentFit="contain"
        accessibilityLabel="Mèo đeo tai nghe đang thưởng thức nhạc"
      />
    </Animated.View>
  );
}

function Kittens({ height, rate }: { height: number; rate: number }) {
  const w = (height * FRAME_W) / FRAME_H;
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % FRAMES), 100 / (rate || 1));
    return () => clearInterval(id);
  }, [rate]);
  const col = frame % COLS;
  const row = Math.floor(frame / COLS);
  return (
    <View
      style={{ width: w, height, overflow: "hidden" }}
      accessible
      accessibilityRole="image"
      accessibilityLabel="Hai chú mèo con đang nhảy theo nhạc"
    >
      <Image
        source={require("@/assets/images/cat-dance-grid.webp")}
        style={{
          width: w * COLS,
          height: height * ROWS,
          transform: [{ translateX: -col * w }, { translateY: -row * height }],
        }}
        contentFit="fill"
        cachePolicy="memory"
      />
    </View>
  );
}
