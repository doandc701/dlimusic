// What changes on Telegram while the app is open (core.js readUpdate): new / edited / deleted posts, their
// reactions and views pushed, chats joined / left / renamed. The open lists take them in (FileList.apply); the chat
// list is read again. Started once signed in (AuthProvider).
import type { TelegramClient } from "telegram";

import { readUpdate } from "../../../core.js";
import { MOCK } from "../mock";
import { getClient } from "./client";
import type { LiveChange } from "./library";
import { reloadChats } from "./useChats";

const listeners = new Set<(c: LiveChange) => void>();
let listening: TelegramClient | null = null;
let chatsSoon: ReturnType<typeof setTimeout> | undefined;

/** Hear the changes (a screen showing a list); returns the way to stop. */
export function onLive(fn: (c: LiveChange) => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Start hearing Telegram's changes (once per connection). */
export async function startLive() {
  if (MOCK) return;
  const client = await getClient();
  if (listening === client) return;
  listening = client;
  client.addEventHandler((u: unknown) => {
    const c = readUpdate(u) as LiveChange | null;
    if (!c) return;
    if (c.op === "chats") {
      // joined, left, renamed: the chat list read again (once for a burst)
      clearTimeout(chatsSoon);
      chatsSoon = setTimeout(() => reloadChats(), 1500);
      return;
    }
    listeners.forEach((l) => l(c));
  });
}
