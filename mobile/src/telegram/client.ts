// The app's one Telegram connection (GramJS over secure WebSockets, like the web version).
// The session is kept in the phone's secure storage (Keychain / Keystore), never in plain files.
import Constants from "expo-constants";
import { Platform } from "react-native";
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";

import { MOCK, MOCK_ME, mockParam } from "../mock";
import { storage as store } from "../storage";

const SESSION_KEY = "tdl.session";
const extra = (Constants.expoConfig?.extra ?? {}) as { tgApiId?: number; tgApiHash?: string };
export const API_ID = Number(extra.tgApiId) || 0;
export const API_HASH = extra.tgApiHash || "";

let client: TelegramClient | null = null;
let connecting: Promise<TelegramClient> | null = null;

/** The connected client (connects once, with the saved session if there is one). */
export function getClient(): Promise<TelegramClient> {
  if (client) return Promise.resolve(client);
  connecting ??= (async () => {
    if (!API_ID || !API_HASH) throw new Error("Thiếu API ID / API hash của Telegram (API_ID, API_HASH trong .env)");
    const saved = (await store.get(SESSION_KEY)) ?? "";
    const c = new TelegramClient(new StringSession(saved), API_ID, API_HASH, {
      connectionRetries: 5,
      useWSS: true,
      deviceModel: `DLiMusic ${Platform.OS === "ios" ? "iPhone" : "Android"}`,
      systemVersion: String(Platform.Version),
      appVersion: String(Constants.expoConfig?.version ?? "0.1"),
      langCode: "vi",
      systemLangCode: "vi",
    });
    c.setLogLevel("error" as never);
    await c.connect();
    client = c;
    return c;
  })().finally(() => {
    connecting = null;
  });
  return connecting;
}

export async function saveSession() {
  if (client) await store.set(SESSION_KEY, String(client.session.save()));
}

/** The session as text (proves the account to the sync server), or "" when signed out. */
export async function sessionString() {
  if (client) return String((client.session as StringSession).save() || "");
  return (await store.get(SESSION_KEY)) ?? "";
}

/** The signed-in account, or null. */
export async function currentUser(): Promise<Api.User | null> {
  if (MOCK) return mockParam("mock") === "out" ? null : (MOCK_ME as unknown as Api.User);
  const c = await getClient();
  if (!(await c.checkAuthorization())) return null;
  return (await c.getMe()) as Api.User;
}

export async function signOut() {
  try {
    await client?.invoke(new Api.auth.LogOut());
  } catch {}
  try {
    await client?.disconnect();
  } catch {}
  client = null;
  await store.del(SESSION_KEY);
}
