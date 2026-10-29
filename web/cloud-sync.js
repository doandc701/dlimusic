// Keeping one account's data the same on every device, through MongoDB.
//
//   createAccountSync  shared by the browser version and the local server: on joining, this device's copy
//                      and MongoDB's are merged (nothing lost); every change is sent as operations
//                      (core.js accountOps) so two devices never overwrite each other; MongoDB is read
//                      again every 30 s (and when asked) to show what other devices changed.
//   createCloudSync    the browser version's part: device token, /api/cloud (the Vercel function,
//                      cloud/api.js), sign-out, and taking the session back on this device.
// Missing function (404) or not configured (CLOUD_OFF): stays local without a fuss. Unreachable: keeps
// working locally and joins again a minute later (merging, so no change is lost).
//
// Everything specific to the app is injected, so this runs (and is tested) outside the browser too.

import { ACCOUNT_NAMES, accountOps, accountEmpty } from "../core.js";

export const TOKEN_KEY = "tdl.cloudToken"; // { token, account }
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * @param read       (name) => this device's value of a shared item (core.js formats)
 * @param apply      (name, value) => take another device's value into the app
 * @param onError    (err) => a request failed (the owner decides: offline status, retry…)
 */
export function createAccountSync({
  read,
  apply,
  onError = () => {},
  onSynced = () => {},
  timers = globalThis,
  debounceMs = 800,
  pullMs = 30_000,
}) {
  let transport = null; // { join(data), ops(name, ops), read() } while connected
  let last = {}; // each item as MongoDB has it (what the next operations are computed against)
  const dirty = new Set();
  let applying = false;
  let flushTimer = null;
  let pullTimer = null;
  let chain = Promise.resolve();

  /** Run one step at a time (join, uploads and reads never interleave). */
  const queue = (fn) => {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  };

  function take(data) {
    for (const name of ACCOUNT_NAMES) {
      const value = data[name] ?? accountEmpty(name);
      if (!same(value, read(name)) && !(name === "settings" && value === null)) {
        applying = true;
        try {
          apply(name, clone(value));
        } finally {
          applying = false;
        }
      }
      last[name] = clone(value);
    }
  }

  async function upload() {
    if (!transport) return;
    for (const name of [...dirty]) {
      dirty.delete(name);
      const now = clone(read(name));
      const ops = accountOps(name, last[name], now);
      try {
        if (ops.length) await transport.ops(name, ops);
        last[name] = now;
      } catch (err) {
        dirty.add(name);
        throw err;
      }
    }
    onSynced();
  }

  const schedulePull = () => {
    timers.clearTimeout(pullTimer);
    if (!transport) return;
    pullTimer = timers.setTimeout(() => api.pull().catch(() => {}), pullMs);
    pullTimer?.unref?.();
  };

  const api = {
    get connected() {
      return !!transport;
    },

    /** Connect and merge: this device's copy + MongoDB's, both end up with the result. */
    start(t) {
      return queue(async () => {
        const mine = Object.fromEntries(ACCOUNT_NAMES.map((n) => [n, clone(read(n))]));
        const merged = await t.join(mine);
        transport = t;
        dirty.clear();
        take(merged);
        onSynced();
        schedulePull();
      }).catch((err) => {
        transport = null;
        onError(err);
        throw err;
      });
    },

    /**
     * Signing out: the changes not sent yet are worked out right now (the app clears its local data just
     * after this call, which must not be taken for "the user deleted everything"), then sent; syncing stops.
     */
    finish() {
      const t = transport;
      const pending = [];
      if (t) {
        for (const name of dirty) {
          const ops = accountOps(name, last[name], clone(read(name)));
          if (ops.length) pending.push([name, ops]);
        }
      }
      api.stop();
      return queue(async () => {
        for (const [name, ops] of pending) await t.ops(name, ops);
      });
    },

    stop() {
      transport = null;
      dirty.clear();
      timers.clearTimeout(flushTimer);
      timers.clearTimeout(pullTimer);
      last = {};
    },

    /** After a shared item changed on this device. */
    changed(name) {
      if (!transport || applying || !ACCOUNT_NAMES.includes(name)) return;
      dirty.add(name);
      timers.clearTimeout(flushTimer);
      flushTimer = timers.setTimeout(() => api.flush().catch(() => {}), debounceMs);
    },

    flush() {
      return queue(upload).catch((err) => {
        transport = null;
        onError(err);
        throw err;
      });
    },

    /** Read MongoDB again (other devices' changes); this device's own changes are sent first. */
    pull() {
      return queue(async () => {
        if (!transport) return;
        await upload();
        take(await transport.read());
        onSynced();
        schedulePull();
      }).catch((err) => {
        transport = null;
        onError(err);
        throw err;
      });
    },
  };
  return api;
}

/**
 * The browser version: device token + /api/cloud.
 * @param store     { load(key, fallback), save(key, value) }  localStorage helpers (save() calls changed())
 * @param keys      localStorage keys: { session, api, settings, history, visibleChats, favorites }
 * @param read      (name, account) => this account's value (core.js formats)
 * @param apply     (name, value, account) => take MongoDB's value into the app
 * @param signedIn  () => account id currently signed in, or null
 */
export function createCloudSync({
  store,
  keys,
  read,
  apply,
  signedIn,
  emit = () => {},
  fetchFn = (...a) => fetch(...a),
  timers = globalThis,
  debounceMs = 800,
  retryMs = 60_000,
  pullMs = 30_000,
}) {
  const status = { enabled: false, connected: false, error: null, lastSync: null, kind: "browser" };
  const byKey = {
    [keys.settings]: "settings",
    [keys.history]: "history",
    [keys.visibleChats]: "visibleChats",
    [keys.favorites]: "favorites",
    [keys.recent]: "recent",
    [keys.playlists]: "playlists",
  };
  let account = null; // the token's account, while connected
  let retryTimer = null;
  let sessionWrite = false;

  const set = (patch) => {
    Object.assign(status, patch);
    emit({ ...status });
  };

  async function call(method, action, body, token = store.load(TOKEN_KEY, null)?.token) {
    const res = await fetchFn(`/api/cloud/${action}`, {
      method,
      cache: "no-store",
      headers: {
        ...(body && { "Content-Type": "application/json" }),
        ...(token && { Authorization: `Bearer ${token}` }),
      },
      body: body && JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok)
      throw Object.assign(new Error(data.error || `cloud ${res.status}`), { status: res.status, code: data.code });
    return data;
  }

  function retryLater(acc) {
    timers.clearTimeout(retryTimer);
    retryTimer = timers.setTimeout(() => signedIn() === acc && !status.connected && sync(acc), retryMs);
    retryTimer?.unref?.(); // Node (tests): a pending retry must not keep the process alive
  }

  const shared = createAccountSync({
    read: (name) => read(name, account),
    apply: (name, value) => apply(name, value, account),
    timers,
    debounceMs,
    pullMs,
    onSynced: () => set({ lastSync: Date.now(), error: null }),
    onError: (err) => {
      if (err.status === 401) store.save(TOKEN_KEY, undefined); // next sync signs in again
      set({ connected: false, error: err.message });
      if (account && signedIn() === account) retryLater(account);
    },
  });

  /** /api/cloud for the shared data, with this device's token. */
  const transport = {
    join: async (data) => (await call("POST", "join", { data })).data,
    ops: (name, ops) => call("POST", "ops", { name, ops }),
    read: () => call("GET", "data"),
  };

  async function sync(acc) {
    try {
      let saved = store.load(TOKEN_KEY, null);
      let ok = saved?.account === acc;
      if (ok) {
        try {
          await call("GET", "data", undefined, saved.token); // the token still works
        } catch (err) {
          if (err.status !== 401) throw err; // revoked / expired: sign in to the cloud again below
          ok = false;
        }
      }
      if (!ok) {
        const r = await call(
          "POST",
          "login",
          { session: store.load(keys.session, ""), api: store.load(keys.api, null) },
          null,
        );
        if (r.accountId !== acc) throw new Error("Tài khoản không khớp");
        store.save(TOKEN_KEY, { token: r.token, account: acc });
      }
      if (signedIn() !== acc) return false; // signed out meanwhile
      account = acc;
      await shared.start(transport);
      set({ enabled: true, connected: true, error: null, lastSync: Date.now() });
      return true;
    } catch (err) {
      const off = err.status === 404 || err.code === "CLOUD_OFF"; // no function / not configured
      set({ enabled: !off, connected: false, error: off ? null : err.message });
      if (!off && signedIn() === acc) retryLater(acc);
      return false;
    }
  }

  return {
    status,
    sync,
    flush: () => shared.flush().catch(() => {}),
    /** Read MongoDB now (e.g. the tab came back to the front). */
    pull: () => (shared.connected ? shared.pull().catch(() => {}) : Promise.resolve()),

    changed(key) {
      if (key === keys.session) {
        // GramJS saved a new session: keep MongoDB's copy current (restore on this device)
        if (account && status.connected && !sessionWrite) {
          const session = store.load(keys.session, "");
          if (session) call("POST", "session", { session }).catch(() => {});
        }
        return;
      }
      if (byKey[key]) shared.changed(byKey[key]);
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
        sessionWrite = true;
        store.save(keys.session, r.session);
        if (r.api && !store.load(keys.api, null)) store.save(keys.api, r.api);
        return true;
      } catch (err) {
        if (err.status === 401) store.save(TOKEN_KEY, undefined);
        return false;
      } finally {
        sessionWrite = false;
        timers.clearTimeout(timer);
      }
    },

    /**
     * Signing out: pending changes are sent, then MongoDB forgets the session and the token. Everything
     * that must happen before the app clears its local data is done before the first await.
     */
    async signOut() {
      const saved = store.load(TOKEN_KEY, null);
      const sent = shared.finish(); // stops tracking now; the app may clear its local data right after
      account = null;
      timers.clearTimeout(retryTimer);
      set({ connected: false, error: null });
      // the token is still needed to send those last changes: forgotten only once they are sent
      await Promise.race([sent.catch(() => {}), new Promise((r) => timers.setTimeout(r, 3000))]);
      if (store.load(TOKEN_KEY, null)?.token === saved?.token) store.save(TOKEN_KEY, undefined);
      if (saved?.token) await call("POST", "logout", {}, saved.token).catch(() => {});
    },
  };
}
