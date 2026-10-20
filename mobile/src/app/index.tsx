// The start screen, like the web's on a phone: the cat alone (the dancing kittens while music plays); tapping it
// opens the channel list with the web's effect — the camera shakes, whips away, a white flash, the list pushes in.
import { Redirect, router } from "expo-router";
import { useRef } from "react";
import { AccessibilityInfo, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from "react-native-reanimated";

import { DancingCat } from "@/components/DancingCat";
import { T } from "@/components/ui";
import { useT } from "@/i18n";
import { usePlayer } from "@/player/PlayerProvider";
import { useAuth } from "@/telegram/AuthProvider";

export default function Home() {
  const auth = useAuth();
  const tr = useT();
  const { playing, speed } = usePlayer();
  const { height } = useWindowDimensions();
  const shake = useSharedValue(0);
  const whip = useSharedValue(0);
  const flash = useSharedValue(0);
  const busy = useRef(false);

  const frame = useAnimatedStyle(() => ({
    transform: [
      { translateX: shake.value * 6 - whip.value * 240 },
      { rotate: `${shake.value * 0.6}deg` },
      { scale: 1 + whip.value * 0.06 },
    ],
    opacity: 1 - whip.value * 0.6,
  }));
  const white = useAnimatedStyle(() => ({ opacity: flash.value }));

  if (auth.state === "out") return <Redirect href="/login" />;

  const open = () => {
    busy.current = false;
    router.push("/chats");
    shake.set(0);
    whip.set(0);
    flash.set(withTiming(0, { duration: 260 }));
  };
  async function tapCat() {
    if (busy.current) return;
    busy.current = true;
    if (await AccessibilityInfo.isReduceMotionEnabled()) return open();
    // 1. camera shake 2. whip pan away 3. white flash over the cut 4. the list pushes in (the stack's own slide)
    shake.set(
      withSequence(
        withTiming(1, { duration: 50 }),
        withTiming(-1, { duration: 60 }),
        withTiming(0.7, { duration: 60 }),
        withTiming(-0.5, { duration: 60 }),
        withTiming(0, { duration: 70 }),
      ),
    );
    whip.set(
      withSequence(withTiming(0, { duration: 300 }), withTiming(1, { duration: 140, easing: Easing.in(Easing.cubic) })),
    );
    flash.set(
      withSequence(
        withTiming(0, { duration: 420 }),
        withTiming(1, { duration: 60 }, (done) => {
          if (done) runOnJS(open)();
        }),
      ),
    );
  }

  const catHeight = Math.max(140, Math.min(240, height * 0.32));
  return (
    <View style={styles.page}>
      <Animated.View style={[styles.center, frame]}>
        <Pressable onPress={tapCat} accessibilityRole="button" accessibilityLabel={tr("Chạm vào mèo để chọn kênh")}>
          <DancingCat dancing={playing} height={catHeight} rate={speed} />
        </Pressable>
        <T size={13} muted style={{ marginTop: 8 }}>
          {tr("Chạm vào mèo để chọn kênh")}
        </T>
      </Animated.View>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.flash, white]} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  flash: { backgroundColor: "#fff" },
});
