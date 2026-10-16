// The account's chats, read once and shared by every screen (the channel list, "Hội thoại hiển thị", Cài đặt).
import { useSyncExternalStore } from "react";

import { authErrorText } from "../../../core.js";
import { listChats, type Chat } from "./library";

type State = { chats: Chat[] | null; error?: string; loading: boolean };
let state: State = { chats: null, loading: false };
const listeners = new Set<() => void>();
const set = (s: Partial<State>) => {
  state = { ...state, ...s };
  listeners.forEach((l) => l());
};

export function reloadChats() {
  if (state.loading) return Promise.resolve();
  set({ loading: true });
  return listChats()
    .then((chats) => set({ chats, error: undefined, loading: false }))
    .catch((err) => set({ error: authErrorText(err), loading: false }));
}

/** Forget the chats (signed out). */
export const resetChats = () => set({ chats: null, error: undefined, loading: false });

export function useChats() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      // a screen needing them before the channel list read them (Cài đặt opened from a chat: "Hiện 17/0")
      if (!state.chats && !state.loading && !state.error) queueMicrotask(reloadChats);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
