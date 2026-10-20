import "../polyfills"; // first: GramJS needs Buffer, WebCrypto… before it loads

import {
  BeVietnamPro_400Regular,
  BeVietnamPro_500Medium,
  BeVietnamPro_600SemiBold,
  BeVietnamPro_700Bold,
  useFonts,
} from "@expo-google-fonts/be-vietnam-pro";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider as NavTheme } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { AppHeader } from "@/components/AppHeader";
import { Footer } from "@/components/Footer";
import { MiniPlayer } from "@/components/MiniPlayer";
import { ToastProvider } from "@/components/Toast";
import { LanguageProvider, useT } from "@/i18n";
import { PlayerProvider } from "@/player/PlayerProvider";
import { LibraryProvider } from "@/store/LibraryProvider";
import { AuthProvider, useAuth } from "@/telegram/AuthProvider";
import { ThemeProvider, useTheme } from "@/theme";

SplashScreen.preventAutoHideAsync();

// The web's frame on a phone: header, the screen, the player dock (signed in), the brand line.
function Shell() {
  const t = useTheme();
  const { state } = useAuth();
  const { ready: langReady } = useT();
  const [fontsLoaded] = useFonts({
    BeVietnamPro_400Regular,
    BeVietnamPro_500Medium,
    BeVietnamPro_600SemiBold,
    BeVietnamPro_700Bold,
    "bootstrap-icons": require("@/assets/fonts/bootstrap-icons.ttf"),
  });
  const ready = fontsLoaded && langReady && state !== "checking";
  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);
  if (!ready) return null;

  const signedIn = state === "in";
  const nav = t.dark ? DarkTheme : DefaultTheme;
  return (
    <NavTheme value={{ ...nav, colors: { ...nav.colors, background: t.bg, card: t.surface, primary: t.violet } }}>
      <StatusBar style={t.dark ? "light" : "dark"} />
      <View style={{ flex: 1, backgroundColor: t.bg }}>
        <AppHeader signedIn={signedIn} />
        <View style={{ flex: 1 }}>
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.bg } }} />
        </View>
        {signedIn && <MiniPlayer />}
        <Footer bar={signedIn} />
      </View>
    </NavTheme>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider>
        <LanguageProvider>
          <AuthProvider>
            <LibraryProvider>
              <PlayerProvider>
                <ToastProvider>
                  <Shell />
                </ToastProvider>
              </PlayerProvider>
            </LibraryProvider>
          </AuthProvider>
        </LanguageProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
