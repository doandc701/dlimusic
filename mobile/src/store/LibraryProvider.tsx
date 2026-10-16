// What an account keeps on this phone: favourites, the songs played lately, which chats show in the list and how
// they are sorted. Ids are the web's ("<chat id>|<message id>", the chat's own id without -100): favourites, recent
// plays and visible chats are the same as on the web version through its sync server (cloud.ts); the order of the
// chat list stays on this phone.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";

import { RECENT_MAX } from "../../../core.js";
import { MOCK } from "../mock";
import { useAuth } from "../telegram/AuthProvider";
import { createCloud, setActiveCloud, type CloudStatus, type SharedName } from "./cloud";

export type RecentItem = {
  id: string; // "<chat id>|<message id>"
  name: string;
  title?: string;
  performer?: string;
  chat: string; // chat title
  chatId: string; // the list's chat id (-100… for channels)
  duration?: number;
  size?: number;
  at: number;
};
export type ChatSort = "recent" | "az" | "za" | "type";

type Library = {
  favorites: string[]; // newest first
  isFavorite: (id: string) => boolean;
  toggleFavorite: (id: string) => boolean; // → now a favourite
  recent: RecentItem[];
  addRecent: (item: Omit<RecentItem, "at">) => void;
  removeRecent: (id: string) => void;
  clearRecent: () => void;
  visibleChats: string[] | null; // null = all
  setVisibleChats: (ids: string[] | null) => void;
  chatSort: ChatSort;
  setChatSort: (s: ChatSort) => void;
  sync: CloudStatus | null; // null: not tried yet
};

const LibraryContext = createContext<Library | null>(null);
export const useLibrary = () => use(LibraryContext)!;

export { songKey } from "../telegram/ids";

export function LibraryProvider({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const acct = me ? String(me.id) : null;
  const [favorites, setFavorites] = useState<string[]>([]);
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [visibleChats, setVisible] = useState<string[] | null>(null);
  const [chatSort, setSort] = useState<ChatSort>("recent");
  const [sync, setSync] = useState<CloudStatus | null>(null);
  // the shared items as they are now (what the sync reads), and the web's items the app does not use (kept as
  // MongoDB has them, so nothing is sent for them)
  const shared = useRef<Record<SharedName, unknown>>({
    favorites: [],
    recent: [],
    visibleChats: null,
    settings: null,
    history: [],
  });
  const cloud = useRef<ReturnType<typeof createCloud> | null>(null);

  const key = useCallback((name: string) => `acct:${acct}:${name}`, [acct]);

  // this account's data, read when it signs in
  useEffect(() => {
    if (!acct) return;
    let live = true;
    AsyncStorage.multiGet([key("favorites"), key("recent"), key("visibleChats"), key("chatSort")])
      .then((pairs) => {
        if (!live) return;
        const get = (i: number) => {
          try {
            return JSON.parse(pairs[i][1] ?? "null");
          } catch {
            return null;
          }
        };
        setFavorites(Array.isArray(get(0)) ? get(0) : MOCK ? ["1001|12", "1001|14"] : []);
        setRecent(
          Array.isArray(get(1))
            ? get(1)
            : MOCK
              ? [
                  {
                    id: "1001|11",
                    name: "Stitches...!@ - TienNguyen x KenD.mp3",
                    title: "Stitches...!@ - TienNguyen x KenD.mp3",
                    chat: "mixtape house lak 420",
                    chatId: "-1001",
                    duration: 3983,
                    at: Date.now() - 60000,
                  },
                  {
                    id: "1001|12",
                    name: "LEW IN THE HOUSE VOL.1.mp3",
                    title: "LEW IN THE HOUSE VOL.1.mp3",
                    chat: "mixtape house lak 420",
                    chatId: "-1001",
                    duration: 3538,
                    at: Date.now() - 3600000,
                  },
                ]
              : [],
        );
        setVisible(Array.isArray(get(2)) ? get(2) : null);
        setSort(["recent", "az", "za", "type"].includes(get(3)) ? get(3) : "recent");
        if (MOCK) return;
        shared.current = {
          favorites: Array.isArray(get(0)) ? get(0) : [],
          recent: Array.isArray(get(1)) ? get(1) : [],
          visibleChats: Array.isArray(get(2)) ? get(2) : null,
          settings: null,
          history: [],
        };
        // then the same as the web version's (merged on joining)
        const c = createCloud({
          account: acct,
          read: (name) => shared.current[name],
          apply: (name, value) => {
            shared.current[name] = value;
            if (name === "favorites") setFavorites((value as string[]) ?? []);
            else if (name === "recent") setRecent((value as RecentItem[]) ?? []);
            else if (name === "visibleChats") setVisible((value as string[] | null) ?? null);
            else return; // the web's settings / download history: not used here
            AsyncStorage.setItem(`acct:${acct}:${name}`, JSON.stringify(value)).catch(() => {});
          },
          onStatus: (st) => live && setSync(st),
        });
        cloud.current = c;
        setActiveCloud(c);
        c.connect();
      })
      .catch(() => {});
    // back to the front: what the other devices changed meanwhile
    const sub = AppState.addEventListener("change", (s) => s === "active" && cloud.current?.pull());
    return () => {
      live = false;
      sub.remove();
      cloud.current?.detach();
      cloud.current = null;
      setSync(null);
    };
  }, [acct, key]);

  const save = useCallback(
    (name: string, value: unknown) => {
      if (acct) AsyncStorage.setItem(key(name), JSON.stringify(value)).catch(() => {});
      if (name === "favorites" || name === "recent" || name === "visibleChats") {
        shared.current[name] = value;
        cloud.current?.changed(name);
      }
    },
    [acct, key],
  );

  const value = useMemo<Library>(() => {
    const favSet = new Set(favorites);
    return {
      favorites,
      isFavorite: (id) => favSet.has(id),
      toggleFavorite: (id) => {
        const on = !favSet.has(id);
        const next = on ? [id, ...favorites] : favorites.filter((x) => x !== id);
        setFavorites(next);
        save("favorites", next);
        return on;
      },
      recent,
      addRecent: (item) => {
        const next = [{ ...item, at: Date.now() }, ...recent.filter((r) => r.id !== item.id)].slice(0, RECENT_MAX);
        setRecent(next);
        save("recent", next);
      },
      removeRecent: (id) => {
        const next = recent.filter((r) => r.id !== id);
        setRecent(next);
        save("recent", next);
      },
      clearRecent: () => {
        setRecent([]);
        save("recent", []);
      },
      visibleChats,
      setVisibleChats: (ids) => {
        setVisible(ids);
        save("visibleChats", ids);
      },
      chatSort,
      setChatSort: (s) => {
        setSort(s);
        save("chatSort", s);
      },
      sync,
    };
  }, [favorites, recent, visibleChats, chatSort, save, sync]);

  return <LibraryContext value={value}>{children}</LibraryContext>;
}
