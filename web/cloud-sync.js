// MongoDB copy of the browser version's data, through /api/cloud (the Vercel function, cloud/api.js).
//
// localStorage stays the working copy. After signing in to Telegram:
//   sync(account)   the server checks the session with Telegram and hands out a device token; this
//                   account's data is pulled (MongoDB wins) and what MongoDB lacks is pushed
//   changed(key)    after a synced localStorage item was written: pushed ~1 s later (bursts = one upload)
//   signOut()       MongoDB forgets the session and the token (settings, history, favourites stay)
//   restoreSession() a device token but no session (e.g. cleared): take the session back
// Missing function (404) or not configured (CLOUD_OFF): stays local without a fuss. Unreachable: keeps
// working locally and tries again every minute.
//
// Everything specific to the app is injected, so this runs (and is tested) outside the browser too.

const NAMES = ["settings", "history", "visibleChats", "favorites"];
const TOKEN_KEY = "tdl.cloudToken"; // { token, account }

/**
 * @param store     { load(key, fallback), save(key, value) }  localStorage helpers (save() calls changed())
 * @param keys      localStorage keys: { session, api, settings, history, visibleChats, favorites }
 * @param read      (name, account) => this account's value for MongoDB (null = nothing)
 * @param apply     (name, value, account) => take MongoDB's value into the app
 * @param signedIn  () => account id currently signed in, or null
 * @param fetchFn   fetch(); `timers` { setTimeout, clearTimeout } (tests)
 */
export function createCloudSync({ store, keys, read, apply, signedIn, emit = () => {}, fetchFn = (...a) => fetch(...a), timers = globalThis, debounceMs = 800, retryMs = 60_000 }) {
  const status = { enabled: false, connected: false, error: null, lastSync: null, kind: "browser" };
  const byKey = { [keys.settings]: "settings", [keys.history]: "history", [keys.visibleChats]: "visibleChats", [keys.favorites]: "favorites", [keys.session]: "session" };
  const dirty = new Set();
  let account = null; // the token's account, while connected
  let applying = false; // writing MongoDB's data: do not send it back
  let flushTimer = null;
  let retryTimer = null;
  let flushing = Promise.resolve();

  const set = (patch) => {
    Object.assign(status, patch);
    emit({ ...status });
  };

  async function call(method, action, body, token = store.load(TOKEN_KEY, null)?.token) {
    const res = await fetchFn(`/api/cloud/${action}`, {
      method,
      cache: "no-store",
      headers: { ...(body && { "Content-Type": "application/json" }), ...(token && { Authorization: `Bearer ${token}` }) },
      body: body && JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `cloud ${res.status}`), { status: res.status, code: data.code });
    return data;
  }

  function retryLater(acc) {
    timers.clearTimeout(retryTimer);
    retryTimer = timers.setTimeout(() => signedIn() === acc && !status.connected && sync(acc), retryMs);
    retryTimer?.unref?.(); // Node (tests): a pending retry must not keep the process alive
  }

  function applyRemote(name, value, acc) {
    applying = true;
    try {
      apply(name, value, acc);
    } finally {
      applying = false;
    }
  }

  async function sync(acc) {
    try {
      let saved = store.load(TOKEN_KEY, null);
      let data;
      if (saved?.account === acc) {
        try {
          data = await call("GET", "data", undefined, saved.token);
        } catch (err) {
          if (err.status !== 401) throw err; // revoked / expired: sign in to the cloud again below
        }
      }
      if (!data) {
        const r = await call("POST", "login", { session: store.load(keys.session, ""), api: store.load(keys.api, null) }, null);
        if (r.accountId !== acc) throw new Error("Tài khoản không khớp");
        store.save(TOKEN_KEY, { token: r.token, account: acc });
        data = r.data;
      }
      if (signedIn() !== acc) return false; // signed out meanwhile
      account = acc;
      for (const name of NAMES) {
        if (data[name] !== null && data[name] !== undefined) applyRemote(name, data[name], acc);
        else if (read(name, acc) !== null) dirty.add(name);
      }
      set({ enabled: true, connected: true, error: null, lastSync: Date.now() });
      await flush();
      return true;
    } catch (err) {
      const off = err.status === 404 || err.code === "CLOUD_OFF"; // no function / not configured
      set({ enabled: !off, connected: false, error: off ? null : err.message });
      if (!off && signedIn() === acc) retryLater(acc);
      return false;
    }
  }

  function flush() {
    flushing = flushing.then(async () => {
      if (!status.connected || !account) return;
      const acc = account;
      for (const name of [...dirty]) {
        dirty.delete(name);
        try {
          if (name === "session") {
            const session = store.load(keys.session, "");
            if (session) await call("POST", "session", { session });
          } else await call("POST", "data", { name, value: read(name, acc) });
          set({ lastSync: Date.now(), error: null });
        } catch (err) {
          dirty.add(name);
          if (err.status === 401) store.save(TOKEN_KEY, undefined); // next sync signs in again
          set({ connected: false, error: err.message });
          retryLater(acc);
          return;
        }
      }
    });
    return flushing;
  }

  return {
    status,
    sync,
    flush,

    changed(key) {
      const name = byKey[key];
      if (!name || applying || !account) return;
      dirty.add(name);
      timers.clearTimeout(flushTimer);
      flushTimer = timers.setTimeout(flush, debounceMs);
    },

    async restoreSession(timeoutMs = 5000) {
      const saved = store.load(TOKEN_KEY, null);
      if (!saved?.token || store.load(keys.session, "")) return false;
      let timer;
      try {
        const r = await Promise.race([
          call("GET", "session", undefined, saved.token),
          new Promise((_, reject) => (timer = timers.setTimeout(() => reject(new Error("timeout")), timeoutMs))),
        ]);
        if (!r.session) return false;
        applying = true;
        store.save(keys.session, r.session);
        if (r.api && !store.load(keys.api, null)) store.save(keys.api, r.api);
        return true;
      } catch (err) {
        if (err.status === 401) store.save(TOKEN_KEY, undefined);
        return false;
      } finally {
        applying = false;
        timers.clearTimeout(timer);
      }
    },

    signOut() {
      const saved = store.load(TOKEN_KEY, null);
      account = null; // stop syncing before the app clears its local data
      dirty.clear();
      timers.clearTimeout(flushTimer);
      timers.clearTimeout(retryTimer);
      set({ connected: false, error: null });
      store.save(TOKEN_KEY, undefined);
      if (saved?.token) return call("POST", "logout", {}, saved.token).catch(() => {});
      return Promise.resolve();
    },
  };
}
