// Small key/value storage: the phone's secure storage (Keychain / Keystore); a web page has none, so
// localStorage there.
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

export const storage =
  Platform.OS === "web"
    ? {
        get: async (k: string) => globalThis.localStorage?.getItem(k) ?? null,
        set: async (k: string, v: string) => globalThis.localStorage?.setItem(k, v),
        del: async (k: string) => globalThis.localStorage?.removeItem(k),
      }
    : { get: SecureStore.getItemAsync, set: SecureStore.setItemAsync, del: SecureStore.deleteItemAsync };
