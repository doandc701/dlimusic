// The data every device of a Telegram account shares (settings, history, visible chats, favourites; see
// core.js), in MongoDB documents "acct:<account id>:<name>". Used by the Vercel functions (cloud/api.js)
// and by the local server directly. Changes arrive as operations applied atomically, so two devices
// writing at the same time never overwrite each other.

import { getValues, setValue, deleteValue, ACCOUNT_DATA } from "./common.js";
import {
  ACCOUNT_NAMES,
  HISTORY_MAX,
  RECENT_MAX,
  accountEmpty,
  mergeAccount,
  isFavoriteId,
  FAVORITES_LIMIT,
  PLAYLISTS_MAX,
  cleanPlaylist,
  ORDERS_MAX,
  cleanOrder,
  isOrderId,
} from "../core.js";

const docId = (acc, name) => `acct:${acc}:${name}`;
const kv = (db) => db.collection("kv");

/** Every shared item of the account (empty when never saved). */
export async function readAccount(db, acc) {
  const got = await getValues(
    db,
    ACCOUNT_NAMES.map((n) => docId(acc, n)),
  );
  return Object.fromEntries(ACCOUNT_NAMES.map((n) => [n, got[docId(acc, n)] ?? accountEmpty(n)]));
}

/** A device joins: its copy and MongoDB's are merged (nothing lost), saved, and returned. */
export async function joinAccount(db, acc, mine) {
  const theirs = await readAccount(db, acc);
  const merged = {};
  for (const name of ACCOUNT_NAMES) {
    const value = ACCOUNT_DATA[name](mine?.[name] ?? accountEmpty(name));
    merged[name] = mergeAccount(name, value === undefined ? accountEmpty(name) : value, theirs[name]);
    if (JSON.stringify(merged[name]) !== JSON.stringify(theirs[name])) {
      if (merged[name] === null) await deleteValue(db, docId(acc, name));
      else await setValue(db, docId(acc, name), merged[name]);
    }
  }
  return merged;
}

/** Check operations sent by a device; returns them cleaned, or undefined when one is not valid. */
export function checkOps(name, ops) {
  if (!ACCOUNT_NAMES.includes(name) || !Array.isArray(ops) || ops.length > 500) return undefined;
  const out = [];
  for (const o of ops) {
    if (!o || typeof o !== "object") return undefined;
    if (o.op === "set" && (name === "settings" || name === "visibleChats")) {
      const value = ACCOUNT_DATA[name](o.value ?? null);
      if (value === undefined) return undefined;
      out.push({ op: "set", value });
    } else if (name === "favorites" && (o.op === "add" || o.op === "remove") && isFavoriteId(o.id)) {
      out.push({ op: o.op, id: o.id });
    } else if (name === "history" && o.op === "add" && Array.isArray(o.entries) && o.entries.length <= HISTORY_MAX) {
      const entries = ACCOUNT_DATA.history(o.entries);
      if (!entries || !entries.every((h) => Number.isSafeInteger(h.id))) return undefined;
      out.push({ op: "add", entries });
    } else if (
      name === "history" &&
      o.op === "remove" &&
      Array.isArray(o.ids) &&
      o.ids.length <= HISTORY_MAX &&
      o.ids.every(Number.isSafeInteger)
    ) {
      out.push({ op: "remove", ids: o.ids });
    } else if (name === "recent" && o.op === "add" && Array.isArray(o.entries) && o.entries.length <= RECENT_MAX) {
      const entries = ACCOUNT_DATA.recent(o.entries);
      if (!entries) return undefined;
      out.push({ op: "add", entries });
    } else if (
      name === "recent" &&
      o.op === "remove" &&
      Array.isArray(o.ids) &&
      o.ids.length <= RECENT_MAX &&
      o.ids.every(isFavoriteId)
    ) {
      out.push({ op: "remove", ids: o.ids });
    } else if (name === "playlists" && o.op === "put") {
      const playlist = cleanPlaylist(o.playlist);
      if (!playlist) return undefined;
      out.push({ op: "put", playlist });
    } else if (
      name === "playlists" &&
      o.op === "remove" &&
      Array.isArray(o.ids) &&
      o.ids.length <= PLAYLISTS_MAX &&
      o.ids.every((id) => typeof id === "string" && id.length <= 24)
    ) {
      out.push({ op: "remove", ids: o.ids });
    } else if (name === "orders" && o.op === "put") {
      const order = cleanOrder(o.order);
      if (!order) return undefined;
      out.push({ op: "put", order });
    } else if (
      name === "orders" &&
      o.op === "remove" &&
      Array.isArray(o.ids) &&
      o.ids.length <= ORDERS_MAX &&
      o.ids.every(isOrderId)
    ) {
      out.push({ op: "remove", ids: o.ids });
    } else if ((name === "history" || name === "recent") && o.op === "clear") {
      out.push({ op: "clear" });
    } else return undefined;
  }
  return out;
}

/** Apply checked operations atomically, one MongoDB update each. */
export async function applyOps(db, acc, name, ops) {
  const _id = docId(acc, name);
  const col = kv(db);
  const now = new Date();
  for (const o of ops) {
    if (o.op === "set") {
      if (o.value === null) await col.deleteOne({ _id });
      else await col.updateOne({ _id }, { $set: { value: o.value, updatedAt: now } }, { upsert: true });
    } else if (o.op === "clear") {
      await col.updateOne({ _id }, { $set: { value: [], updatedAt: now } }, { upsert: true });
    } else if ((name === "playlists" || name === "orders") && o.op === "put") {
      // the playlist (list's order) replaced whole (its name, songs and their order), put first
      const item = name === "playlists" ? o.playlist : o.order;
      await col.updateOne({ _id }, { $pull: { value: { id: item.id } }, $set: { updatedAt: now } }, { upsert: true });
      await col.updateOne(
        { _id },
        {
          $push: {
            value: { $each: [item], $position: 0, $slice: name === "playlists" ? PLAYLISTS_MAX : ORDERS_MAX },
          },
        },
        { upsert: true },
      );
    } else if (name === "favorites") {
      await col.updateOne({ _id }, { $pull: { value: o.id }, $set: { updatedAt: now } }, { upsert: true });
      if (o.op === "add") {
        await col.updateOne(
          { _id },
          { $push: { value: { $each: [o.id], $position: 0, $slice: FAVORITES_LIMIT } } },
          { upsert: true },
        );
      }
    } else if (o.op === "add") {
      const ids = o.entries.map((h) => h.id);
      await col.updateOne(
        { _id },
        { $pull: { value: { id: { $in: ids } } }, $set: { updatedAt: now } },
        { upsert: true },
      );
      await col.updateOne(
        { _id },
        { $push: { value: { $each: o.entries, $position: 0, $slice: name === "recent" ? RECENT_MAX : HISTORY_MAX } } },
        { upsert: true },
      );
    } else if (o.op === "remove") {
      await col.updateOne({ _id }, { $pull: { value: { id: { $in: o.ids } } }, $set: { updatedAt: now } });
    }
  }
}
