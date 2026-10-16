// The account's favourites, recent plays and visible chats, the same as on the web version: through its sync
// server (/api/cloud on dlimusic.vercel.app — MongoDB stays behind it, its address never in the app). The merging
// and the operations sent are the web version's own (web/cloud-sync.js, core.js), so both behave alike: on
// joining, this phone's copy and MongoDB's are merged (nothing lost); each change is sent as operations; MongoDB
// is read again every 30 s and when the app comes back to the front.
// The session only proves the account to the server ("keepSession": it is not stored there — the browser
// version's stays). Unreachable: the app keeps working on its own copy and tries again a minute later.
import Constants from "expo-constants";

import { createAccountSync } from "../../../web/cloud-sync.js";
import { storage } from "../storage";
import { sessionString } from "../telegram/client";

// CLOUD_URL in .env (app.config.js); EXPO_PUBLIC_CLOUD_URL overrides it (tests against a local server)
export const CLOUD_URL = (
  process.env.EXPO_PUBLIC_CLOUD_URL ||
  (Constants.expoConfig?.extra as { cloudUrl?: string } | undefined)?.cloudUrl ||
  "https://dlimusic.vercel.app"
).replace(/\/+$/, "");
const TOKEN_KEY = "cloud.token"; // { token, account } in the phone's secure storage
const RETRY_MS = 60_000;

export type SharedName = "settings" | "history" | "visibleChats" | "favorites" | "recent";
export type CloudStatus = { connected: boolean; error: string | null; lastSync: number | null; off?: boolean };
type CloudError = Error & { status?: number; code?: string };

async function call(method: "GET" | "POST", action: string, body?: unknown, token?: string | null) {
  const res = await fetch(`${CLOUD_URL}/api/cloud/${action}`, {
    method,
    headers: {
      ...(body !== undefined && { "Content-Type": "application/json" }),
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw Object.assign(new Error(data.error || `Máy chủ đồng bộ trả lỗi ${res.status}`), {
      status: res.status,
      code: data.code,
    }) as CloudError;
  return data;
}

/**
 * @param account  the Telegram account signed in
 * @param read     (name) => this phone's value of a shared item (core.js formats)
 * @param apply    (name, value) => take MongoDB's value into the app
 */
export function createCloud({
  account,
  read,
  apply,
  onStatus,
}: {
  account: string;
  read: (name: SharedName) => unknown;
  apply: (name: SharedName, value: unknown) => void;
  onStatus: (s: CloudStatus) => void;
}) {
  let token: string | null = null;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const retryLater = () => {
    clearTimeout(retry);
    if (!stopped) retry = setTimeout(connect, RETRY_MS);
  };

  const shared = createAccountSync({
    read: (name: SharedName) => read(name),
    apply: (name: SharedName, value: unknown) => apply(name, value),
    onSynced: () => onStatus({ connected: true, error: null, lastSync: Date.now() }),
    // (typed from the JS file's default, which takes no argument)
    onError: ((err: CloudError) => {
      if (err.status === 401) token = null; // signs in to the server again
      onStatus({ connected: false, error: err.message, lastSync: null });
      retryLater();
    }) as () => void,
  });

  const transport = {
    join: async (data: unknown) => (await call("POST", "join", { data }, token)).data,
    ops: (name: string, ops: unknown) => call("POST", "ops", { name, ops }, token),
    read: () => call("GET", "data", undefined, token),
  };

  async function connect() {
    clearTimeout(retry);
    try {
      const saved = JSON.parse((await storage.get(TOKEN_KEY)) ?? "null") as { token: string; account: string } | null;
      token = saved?.account === account ? saved.token : null;
      if (token) {
        try {
          await call("GET", "data", undefined, token); // the token still works
        } catch (err) {
          if ((err as CloudError).status !== 401) throw err;
          token = null;
        }
      }
      if (!token) {
        const session = await sessionString();
        if (!session) throw new Error("Chưa đăng nhập Telegram");
        const r = await call("POST", "login", { session, api: { mode: "builtin" }, keepSession: true });
        if (String(r.accountId) !== account) throw new Error("Tài khoản không khớp");
        token = r.token as string;
        await storage.set(TOKEN_KEY, JSON.stringify({ token, account }));
      }
      if (stopped) return;
      await shared.start(transport);
    } catch (err) {
      const e = err as CloudError;
      // no server / not configured: stays on this phone without a fuss
      const off = e.status === 404 || e.code === "CLOUD_OFF";
      onStatus({ connected: false, error: off ? null : e.message, lastSync: null, off });
      if (!off) retryLater();
    }
  }

  return {
    connect,
    /** A shared item changed on this phone. */
    changed: (name: SharedName) => shared.changed(name),
    /** Read MongoDB now (the app came back to the front). */
    pull: () => (shared.connected ? shared.pull().catch(() => {}) : Promise.resolve()),
    /**
     * Signing out: the changes not sent yet are sent, then the server forgets this phone's token (the browser
     * version's session stays).
     */
    async stop() {
      stopped = true;
      clearTimeout(retry);
      const sent = shared.finish();
      await Promise.race([sent.catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
      if (token) await call("POST", "logout", { keepSession: true }, token).catch(() => {});
      await storage.del(TOKEN_KEY).catch(() => {});
    },
    /** Another account / app closing: stop syncing, keep the token. */
    detach() {
      stopped = true;
      clearTimeout(retry);
      shared.stop();
    },
  };
}

let active: ReturnType<typeof createCloud> | null = null;
/** The sync of the account signed in (stopped on signing out). */
export const setActiveCloud = (c: ReturnType<typeof createCloud> | null) => (active = c);
/** Signing out: send what is left, then the server forgets this phone. */
export async function stopCloud() {
  const c = active;
  active = null;
  await c?.stop();
}
