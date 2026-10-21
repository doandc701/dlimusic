// The channel list, like the web's sidebar on a phone: search (or paste a t.me link), "Bài hát yêu thích",
// "N hội thoại" with sorting and "Chọn hiển thị", the chats. Tap one to see its files.
// Typing 2+ characters searches like Telegram: "Kết quả tìm kiếm toàn cầu" (the account's own chats, then the
// public ones Telegram found, with "Tham gia"), then "Tìm thấy N bài hát" (songs of every chat, playable).
import { FlashList } from "@shopify/flash-list";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  TextInput,
  View,
} from "react-native";

import { ChatRow, TYPE } from "@/components/ChatRow";
import { ChatsModal } from "@/components/ChatsModal";
import { Icon, type IconName } from "@/components/Icon";
import { norm } from "@/components/RecentPanel";
import { useToast } from "@/components/Toast";
import { Avatar, Pill, T, fmtDur, haptic } from "@/components/ui";
import { useT } from "@/i18n";
import { usePlayer } from "@/player/PlayerProvider";
import { prefetchHead } from "@/player/prefetch";
import { useLibrary, type ChatSort } from "@/store/LibraryProvider";
import type { Chat, Song } from "@/telegram/library";
import {
  SEARCH_MAX,
  SEARCH_MIN,
  chatOfLink,
  inviteHash,
  isChatLink,
  joinFound,
  openableChat,
  searchGlobal,
  songSearch,
  type FoundChat,
  type SongSearch,
} from "@/telegram/search";
import { addChat, reloadChats, useChats } from "@/telegram/useChats";
import { FONT, GRADIENT, tint, useTheme } from "@/theme";

// labels in Vietnamese, translated where shown
const SORTS: Record<ChatSort, { label: string; icon: IconName }> = {
  recent: { label: "Mới hoạt động", icon: "clock-history" }, // Telegram's own order
  az: { label: "Tên A → Z", icon: "sort-alpha-down" },
  za: { label: "Tên Z → A", icon: "sort-alpha-up-alt" },
  type: { label: "Theo loại (Kênh, Nhóm, Người dùng)", icon: "collection" },
};
const TYPE_ORDER = { channel: 0, group: 1, user: 2 };
const collator = new Intl.Collator("vi", { sensitivity: "base", numeric: true });
const SONG_PREVIEW = 5; // songs under the chat results; "Xem tất cả bài hát" opens all of them
const SEARCH_DELAY = 350; // ms after the last key press

/** "12,3 N" / "12.3K" in the picked language (Intl's compact notation, else a K / M of our own). */
function compact(n: number, locale: string) {
  try {
    const s = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(n);
    if (n < 1000 || !/^[\d\s.,\u00a0\u202f]+$/.test(s)) return s; // (an engine without compact notation: plain digits)
  } catch {}
  const fmt = (v: number) => v.toLocaleString(locale, { maximumFractionDigits: 1 });
  return n >= 1e6 ? `${fmt(n / 1e6)}M` : `${fmt(n / 1e3)}K`;
}

/** A Telegram / core.js error as the (Vietnamese) text shown through tr(). */
const errText = (err: unknown) => String((err as Error)?.message ?? err) || "Telegram không trả lời. Vui lòng thử lại.";

type Found = { q: string; status: "loading" | "done" | "error"; chats: FoundChat[]; error?: string };
type Songs = { q: string; status: "loading" | "done" | "error"; list?: SongSearch; songs: Song[]; error?: string };
type Row =
  | { t: "section"; key: string; text: string; translated?: boolean }
  | { t: "chat"; key: string; chat: Chat }
  | { t: "found"; key: string; r: FoundChat }
  | { t: "note"; key: string; text: string; spin?: boolean; error?: boolean }
  | { t: "song"; key: string; song: Song }
  | { t: "all"; key: string; n: string };
const joinKey = (r: FoundChat) => (r.invite ? `+${r.invite}` : (r.id ?? r.title));

export default function Chats() {
  const t = useTheme();
  const tr = useT();
  const toast = useToast();
  const { chats, error, loading } = useChats();
  const { favorites, visibleChats, setVisibleChats, chatSort, setChatSort } = useLibrary();
  const { now, playing, play, toggle } = usePlayer();
  const [found, setFound] = useState<Found | null>(null);
  const [songs, setSongs] = useState<Songs | null>(null);
  const [joins, setJoins] = useState<Map<string, "joining" | "pending">>(new Map());
  const [query, setQuery] = useState("");
  const [sortOpen, setSortOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [menuTop, setMenuTop] = useState(0);
  const bar = useRef<View>(null);

  useEffect(() => {
    if (!chats) reloadChats();
  }, [chats]);

  const shown = useMemo(() => {
    const all = chats ?? [];
    const visible = visibleChats ? all.filter((c) => visibleChats.includes(c.id)) : all;
    // a pasted link / @username finds the chat by its username (t.me/abc, https://t.me/abc/123, @abc)
    const link = /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?:s\/)?([A-Za-z0-9_]{4,})|^@([A-Za-z0-9_]{4,})$/.exec(
      query.trim(),
    );
    const q = norm(link ? (link[1] ?? link[2]) : query.trim());
    const list = visible.filter((c) => !q || norm(`${c.title} ${c.username ?? ""}`).includes(q));
    if (chatSort === "az") return [...list].sort((a, b) => collator.compare(a.title, b.title));
    if (chatSort === "za") return [...list].sort((a, b) => collator.compare(b.title, a.title));
    if (chatSort === "type") return [...list].sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type]);
    return list;
  }, [chats, visibleChats, chatSort, query]);

  const total = chats?.length ?? 0;
  const filtered = !!visibleChats;

  // Telegram's search, ~350 ms after the last key press; an older one still running is dropped
  const typed = query.trim();
  const searching = typed.length >= SEARCH_MIN && typed.length <= SEARCH_MAX;
  useEffect(() => {
    // (no "loading" state to set: results for other words than the box's count as still searching)
    if (!searching) return;
    let live = true;
    let list: SongSearch | null = null;
    const timer = setTimeout(() => {
      searchGlobal(typed)
        .then((res) => live && setFound({ q: typed, status: "done", chats: res }))
        .catch((err) => live && setFound({ q: typed, status: "error", chats: [], error: errText(err) }));
      const l = (list = songSearch(typed, { fresh: true }));
      l.next()
        .then(() => live && setSongs({ q: typed, status: "done", list: l, songs: [...l.songs] }))
        .catch((err) => live && setSongs({ q: typed, status: "error", songs: [], error: errText(err) }));
    }, SEARCH_DELAY);
    return () => {
      live = false;
      clearTimeout(timer);
      list?.abort();
    };
  }, [typed, searching]);

  const openChat = (c: Chat) => router.push({ pathname: "/chat/[id]", params: { id: c.id, title: c.title } });

  /** A found chat was tapped: open it (a public channel can be read without joining). */
  function openFound(r: FoundChat) {
    const mine = r.id ? chats?.find((c) => c.id === r.id) : undefined;
    if (mine) return openChat(mine);
    const c = (r.username || r.joined) && openableChat(r);
    if (c) return openChat(c);
    toast(tr("Kênh riêng tư: hãy bấm Tham gia để xem."), "info");
  }

  const setJoin = (key: string, st?: "joining" | "pending") =>
    setJoins((m) => {
      const next = new Map(m);
      if (st) next.set(key, st);
      else next.delete(key);
      return next;
    });

  /** "Tham gia": join, show it in the list (and in the chosen chats, if a choice is on), open it. */
  async function join(r: FoundChat) {
    const key = joinKey(r);
    if (joins.has(key)) return;
    setJoin(key, "joining");
    try {
      const res = await joinFound(r);
      if (res.pending) {
        setJoin(key, "pending");
        return toast(tr("Đã gửi yêu cầu tham gia {title}, chờ quản trị viên duyệt.", { title: r.title }), "info");
      }
      setJoin(key);
      setFound((f) => f && { ...f, chats: f.chats.map((x) => (x === r ? { ...x, joined: true } : x)) });
      await reloadChats(); // the same Telegram account: Telegram's own apps show it too
      const c = res.chat;
      if (c) {
        addChat(c);
        if (visibleChats && !visibleChats.includes(c.id)) setVisibleChats([...visibleChats, c.id]);
      }
      toast(tr("Đã tham gia {title}", { title: c?.title || r.title }));
      if (c) openChat(c);
    } catch (err) {
      setJoin(key);
      toast(tr(errText(err)), "error");
    }
  }

  /** Enter: a link / @username opens its chat; anything else only puts the keyboard away (the results stay). */
  function submit() {
    Keyboard.dismiss();
    if (!isChatLink(typed)) return;
    if (inviteHash(typed)) {
      // its chat is in the results, with "Tham gia" when not joined yet
      const r = found?.q === typed ? found.chats[0] : undefined;
      if (r) openFound(r);
      return;
    }
    chatOfLink(typed)
      .then(openChat)
      .catch((err) => toast(tr(errText(err)), "error"));
  }

  const rows = useMemo<Row[]>(() => {
    if (!searching) return [];
    const out: Row[] = [{ t: "section", key: "s-chats", text: "Kết quả tìm kiếm toàn cầu" }];
    for (const c of shown) out.push({ t: "chat", key: `c${c.id}`, chat: c });
    const f = found?.q === typed ? found : null;
    if (!f || f.status === "loading") out.push({ t: "note", key: "n-chats", text: "Đang tìm…", spin: true });
    else if (f.status === "error") out.push({ t: "note", key: "n-chats", text: f.error ?? "", error: true });
    else {
      const mine = new Set(shown.map((c) => c.id));
      f.chats.forEach((r, i) => {
        if (!(r.id && mine.has(r.id))) out.push({ t: "found", key: `g${r.id ?? r.invite ?? i}`, r });
      });
      if (out.length === 1) out.push({ t: "note", key: "n-chats", text: "Không tìm thấy kết quả" });
    }
    const s = songs?.q === typed ? songs : null;
    if (!s || s.status !== "done" || !s.songs.length) {
      out.push({ t: "section", key: "s-songs", text: "Bài hát" });
      out.push(
        !s || s.status === "loading"
          ? { t: "note", key: "n-songs", text: "Đang tìm…", spin: true }
          : s.status === "error"
            ? { t: "note", key: "n-songs", text: s.error ?? "", error: true }
            : { t: "note", key: "n-songs", text: "Không tìm thấy bài hát" },
      );
      return out;
    }
    const n = `${s.songs.length}${s.list?.more ? "+" : ""}`;
    // like Telegram's "72 messages found": how many Telegram counted (else what is loaded, "50+")
    const total = s.list?.total ? s.list.total.toLocaleString(tr.locale) : n;
    out.push({ t: "section", key: "s-songs", text: tr("Tìm thấy {n} bài hát", { n: total }), translated: true });
    for (const song of s.songs.slice(0, SONG_PREVIEW)) out.push({ t: "song", key: `m${song.key}`, song });
    out.push({ t: "all", key: "all", n });
    return out;
  }, [searching, shown, found, songs, typed, tr]);

  function renderRow(row: Row) {
    switch (row.t) {
      case "section":
        return (
          <View style={[styles.section, { backgroundColor: t.bg, borderBottomColor: t.border }]}>
            <T size={12.5} weight="semibold" muted numberOfLines={1}>
              {row.translated ? row.text : tr(row.text)}
            </T>
          </View>
        );
      case "note":
        return (
          <View style={styles.note}>
            {row.spin && <ActivityIndicator size="small" color={t.textMuted} />}
            <T size={13} muted color={row.error ? t.coral : undefined} style={{ textAlign: "center", flexShrink: 1 }}>
              {tr(row.text)}
            </T>
          </View>
        );
      case "chat":
        return <ChatRow chat={row.chat} onPress={() => openChat(row.chat)} />;
      case "found":
        return (
          <FoundRow
            r={row.r}
            state={joins.get(joinKey(row.r))}
            onPress={() => openFound(row.r)}
            onJoin={() => join(row.r)}
          />
        );
      case "song": {
        const song = row.song;
        const list = songs?.list;
        const current = now?.song.key === song.key && now.list === list;
        return (
          <Pressable
            onPressIn={() => !current && list && prefetchHead(song.key, list.message(song.id)?.media, song.size)}
            onPress={() => {
              if (!list) return;
              haptic();
              if (current) toggle();
              else play(list, song);
            }}
            style={({ pressed }) => [
              styles.songRow,
              { borderBottomColor: t.border, backgroundColor: pressed ? t.surfaceAlt : t.surface },
            ]}
            accessibilityRole="button"
            accessibilityLabel={song.title || song.name}
          >
            {current ? (
              <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.songPlay}>
                <Icon name={playing ? "pause-fill" : "play-fill"} size={16} color="#fff" />
              </LinearGradient>
            ) : (
              <View style={[styles.songPlay, { borderWidth: 1, borderColor: tint(t.pink, 0.4) }]}>
                <Icon name="play-fill" size={16} color={t.pink} style={{ marginLeft: 2 }} />
              </View>
            )}
            <View style={{ flex: 1, minWidth: 0 }}>
              <T numberOfLines={1} color={current ? (t.dark ? "#c4b5fd" : t.primary) : undefined}>
                {song.title || song.name}
                {song.title && song.performer ? <T muted>{` – ${song.performer}`}</T> : null}
              </T>
              <View style={styles.sub}>
                <Icon name="megaphone" size={12} color={t.textMuted} />
                <T size={13} muted numberOfLines={1} style={{ flexShrink: 1 }}>
                  {song.chat ?? ""}
                </T>
              </View>
            </View>
            {song.duration ? (
              <T size={12.5} muted>
                {fmtDur(song.duration)}
              </T>
            ) : null}
          </Pressable>
        );
      }
      case "all":
        return (
          <Pressable
            onPress={() => {
              haptic();
              if (songs?.list) router.push({ pathname: "/chat/[id]", params: { id: "search", q: songs.list.query } });
            }}
            style={({ pressed }) => [
              styles.songRow,
              { borderBottomColor: t.border, backgroundColor: pressed ? t.surfaceAlt : t.surface },
            ]}
            accessibilityRole="button"
          >
            <View style={styles.songPlay}>
              <Icon name="music-note-list" size={17} color={t.violet} />
            </View>
            <T numberOfLines={1} color={t.violet} style={{ flex: 1 }}>
              {tr("Xem tất cả bài hát ({n})", { n: row.n })}
            </T>
            <Icon name="chevron-right" size={13} color={t.textMuted} />
          </Pressable>
        );
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.surface }}>
      <View style={[styles.searchWrap, { borderBottomColor: t.border }]}>
        <View style={[styles.search, { borderColor: t.border }]}>
          <View style={[styles.searchIco, { borderRightColor: t.border, backgroundColor: t.bg }]}>
            <Icon name="search" size={15} color={t.text} />
          </View>
          <TextInput
            allowFontScaling={false}
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={submit}
            accessibilityLabel={tr("Tìm kiếm")}
            style={[styles.searchInput, { color: t.text }]}
            returnKeyType="search"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
      </View>

      <Pressable
        onPress={() => {
          haptic();
          router.push({ pathname: "/chat/[id]", params: { id: "fav" } });
        }}
        style={({ pressed }) => [
          styles.fav,
          { borderBottomColor: t.border, backgroundColor: pressed ? t.bg : t.surface },
        ]}
        accessibilityRole="button"
        accessibilityLabel={tr("Bài hát yêu thích")}
      >
        <LinearGradient
          colors={["#ec4899", "#8b5cf6"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.favAvatar}
        >
          <Icon name="heart-fill" size={16} color="#fff" />
        </LinearGradient>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T weight="semibold">{tr("Bài hát yêu thích")}</T>
          <View style={styles.sub}>
            <Icon name="music-note-beamed" size={12} color={t.textMuted} />
            <T size={13} muted>
              {tr("{n} bài · từ mọi kênh", { n: favorites.length })}
            </T>
          </View>
        </View>
      </Pressable>

      <View
        ref={bar}
        style={[styles.bar, { borderBottomColor: t.border, backgroundColor: t.bg }]}
        onLayout={() => bar.current?.measureInWindow((_x, y, _w, h) => setMenuTop(y + h))}
      >
        <Icon name={filtered ? "funnel-fill" : "chat-dots"} size={12} color={filtered ? t.violet : t.textMuted} />
        <T size={12.5} muted style={{ flex: 1 }}>
          <T size={12.5} weight="bold">
            {filtered ? `${shown.length}/${total}` : total}
          </T>{" "}
          {tr("hội thoại", { n: filtered ? shown.length : total })}
        </T>
        <Pill
          icon="arrow-down-up"
          color={t.pink}
          small
          active={chatSort !== "recent"}
          onPress={() => setSortOpen(true)}
          label={tr("Sắp xếp hội thoại")}
        />
        <Pill
          title={tr(filtered ? "Chọn lại" : "Chọn hiển thị")}
          icon="sliders"
          color={t.pink}
          small
          onPress={() => setPicking(true)}
        />
      </View>

      {searching ? (
        <FlashList
          data={rows}
          keyExtractor={(r) => r.key}
          getItemType={(r) => r.t}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          extraData={[joins, now?.song.key, now?.list, playing, tr.locale]}
          renderItem={({ item }) => renderRow(item)}
        />
      ) : (
        <FlashList
          data={shown}
          keyExtractor={(c) => c.id}
          refreshControl={
            <RefreshControl refreshing={loading && !!chats} tintColor={t.violet} onRefresh={reloadChats} />
          }
          ListEmptyComponent={
            <T muted size={13} style={{ textAlign: "center", padding: 24 }}>
              {tr(
                error ??
                  (chats
                    ? query
                      ? "Không có hội thoại khớp"
                      : "Không có hội thoại"
                    : "Đang tải danh sách hội thoại…"),
              )}
            </T>
          }
          renderItem={({ item }) => <ChatRow chat={item} onPress={() => openChat(item)} />}
        />
      )}

      <Modal visible={sortOpen} transparent animationType="fade" onRequestClose={() => setSortOpen(false)}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => setSortOpen(false)} />
        <View style={[styles.menu, { top: menuTop + 2, backgroundColor: t.surface, borderColor: t.border }]}>
          <T size={12.5} muted style={{ paddingHorizontal: 12, paddingVertical: 6 }}>
            {tr("Sắp xếp hội thoại")}
          </T>
          {(Object.keys(SORTS) as ChatSort[]).map((k) => {
            const on = k === chatSort;
            return (
              <Pressable
                key={k}
                onPress={() => {
                  haptic();
                  setChatSort(k);
                  setSortOpen(false);
                }}
                style={[styles.menuItem, on && { backgroundColor: t.primary }]}
              >
                <Icon name={SORTS[k].icon} size={13} color={on ? "#fff" : t.text} />
                <T size={13.6} style={{ flex: 1 }} color={on ? "#fff" : undefined}>
                  {tr(SORTS[k].label)}
                </T>
                {on && <Icon name="check2" size={14} color="#fff" />}
              </Pressable>
            );
          })}
        </View>
      </Modal>
      <ChatsModal open={picking} onClose={() => setPicking(false)} />
    </View>
  );
}

/** A chat Telegram's search found: avatar, title ✓, "@username · 12,3 N người theo dõi", "Tham gia". */
function FoundRow({
  r,
  state,
  onPress,
  onJoin,
}: {
  r: FoundChat;
  state?: "joining" | "pending";
  onPress: () => void;
  onJoin: () => void;
}) {
  const t = useTheme();
  const tr = useT();
  const parts: string[] = [];
  if (r.username) parts.push(`@${r.username}`);
  if (r.members != null) {
    const n = compact(r.members, tr.locale);
    parts.push(tr(r.type === "channel" ? "{n} người theo dõi" : "{n} thành viên", { n }));
  } else if (!r.username || r.type === "user" || r.type === "bot")
    parts.push(tr(r.type === "bot" ? "Bot" : TYPE[r.type].label));
  const canJoin = !r.joined && r.type !== "user" && r.type !== "bot";
  return (
    <Pressable
      onPress={() => {
        haptic();
        onPress();
      }}
      style={({ pressed }) => [
        styles.found,
        { borderBottomColor: t.border, backgroundColor: pressed ? t.surfaceAlt : t.surface },
      ]}
      accessibilityRole="button"
      accessibilityLabel={r.title}
    >
      <Avatar name={r.title} id={String(r.id ?? r.invite ?? r.title)} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={styles.sub}>
          <T numberOfLines={1} style={{ flexShrink: 1 }}>
            {r.title}
          </T>
          {r.verified && (
            <View accessible accessibilityLabel={tr("Đã xác minh")}>
              <Icon name="patch-check-fill" size={13} color={t.sky} />
            </View>
          )}
        </View>
        <View style={styles.sub}>
          <Icon name={r.type === "bot" ? "robot" : TYPE[r.type].icon} size={12} color={t.textMuted} />
          <T size={13} muted numberOfLines={1} style={{ flexShrink: 1 }}>
            {parts.join(" · ")}
          </T>
        </View>
      </View>
      {canJoin &&
        (state === "pending" ? (
          <T size={12.5} muted accessibilityLabel={tr("Chờ quản trị viên duyệt")}>
            {tr("Đã gửi yêu cầu")}
          </T>
        ) : (
          <Pressable
            onPress={() => {
              haptic();
              onJoin();
            }}
            disabled={state === "joining"}
            hitSlop={6}
            style={({ pressed }) => [
              styles.join,
              { borderColor: t.primary, backgroundColor: pressed ? tint(t.primary, 0.15) : "transparent" },
            ]}
            accessibilityRole="button"
            accessibilityLabel={tr(state === "joining" ? "Đang tham gia…" : "Tham gia")}
          >
            {state === "joining" ? (
              <ActivityIndicator size="small" color={t.primary} />
            ) : (
              <T size={13} weight="semibold" color={t.primary}>
                {tr("Tham gia")}
              </T>
            )}
          </Pressable>
        ))}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: { paddingHorizontal: 16, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  note: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  found: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: 3,
    borderLeftColor: "transparent",
  },
  join: {
    minWidth: 76,
    height: 28,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  songRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  songPlay: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  searchWrap: { padding: 16, paddingBottom: 16, borderBottomWidth: StyleSheet.hairlineWidth },
  search: { flexDirection: "row", height: 38, borderWidth: 1, borderRadius: 6 },
  searchIco: {
    width: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRightWidth: 1,
    borderTopLeftRadius: 5,
    borderBottomLeftRadius: 5,
  },
  searchInput: { flex: 1, paddingHorizontal: 12, fontSize: 16, fontFamily: FONT.regular },
  fav: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  favAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#ec4899",
    shadowOpacity: 0.6,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 4 },
  },
  sub: { flexDirection: "row", alignItems: "center", gap: 4 },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  menu: {
    position: "absolute",
    left: 8,
    width: 290,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 6,
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  menuItem: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 7 },
});
