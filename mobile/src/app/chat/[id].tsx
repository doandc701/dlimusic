// A chat's files (or "Bài hát yêu thích" for id "fav", a playlist for id "pl:<id>", or the songs of a search
// "Tìm: “…”" for id "search" with `q`), like the web's list on a phone: ‹ title, "2.402 người theo dõi", "N file", Lọc, reload; search;
// (favourites: which chat); "Tên bài" header with select-all; rows with a checkbox, ▶, name, file
// name, size · duration, ♡; "Tải thêm 500 file". Tap a song to play it. "Lọc" opens type / sort.
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { LinearGradient } from "expo-linear-gradient";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, TextInput, View } from "react-native";
import ReorderableList, { useReorderableDrag } from "react-native-reorderable-list";

import { PAGE_SIZE, SONG_PAGE, displayName } from "../../../../core.js";
import { DownloadBar } from "@/components/DownloadBar";
import { Icon } from "@/components/Icon";
import { NameSheet, PlaylistPicker } from "@/components/Playlists";
import { norm } from "@/components/RecentPanel";
import { Sheet } from "@/components/Sheet";
import { useToast } from "@/components/Toast";
import { Checkbox, GradientButton, Pill, RoundButton, T, fmtDur, fmtSize, haptic } from "@/components/ui";
import { download } from "@/download/downloads";
import { useT } from "@/i18n";
import { playable, usePlayer } from "@/player/PlayerProvider";
import { prefetchHead, warmUp } from "@/player/prefetch";
import { useLibrary } from "@/store/LibraryProvider";
import { MOCK } from "@/mock";
import { FavoritesScan, SongScan, chatById, type FileList, type FileType, type Song } from "@/telegram/library";
import { chatMembers, knownMembers, songSearch } from "@/telegram/search";
import { FONT, GRADIENT, tint, useTheme } from "@/theme";

// labels in Vietnamese, translated where shown
const TYPES: [FileType, string][] = [
  ["all", "Tất cả"],
  ["music", "Nhạc"],
  ["video", "Video"],
  ["photo", "Ảnh"],
  ["document", "Tài liệu"],
  ["voice", "Voice"],
];
type Sort = "default" | "oldest" | "name-asc" | "name-desc" | "size-desc" | "size-asc" | "dur-desc" | "dur-asc";
const SORTS: [Sort, string][] = [
  ["default", "Mặc định (mới nhất)"],
  ["oldest", "Cũ nhất trước"],
  ["name-asc", "Tên A → Z"],
  ["name-desc", "Tên Z → A"],
  ["size-desc", "Dung lượng lớn → nhỏ"],
  ["size-asc", "Dung lượng nhỏ → lớn"],
  ["dur-desc", "Thời lượng dài → ngắn"],
  ["dur-asc", "Thời lượng ngắn → dài"],
];
const collator = new Intl.Collator("vi", { sensitivity: "base", numeric: true });
const nameOf = (s: Song) => norm(displayName(s));
/** When a song was posted in its chat: "16/09/2024 21:04" in the picked language's date format. */
const postedAt = (date: number, locale: string) => {
  const d = new Date(date * 1000);
  return `${d.toLocaleDateString(locale, { day: "2-digit", month: "2-digit", year: "numeric" })} ${d.toLocaleTimeString(
    locale,
    { hour: "2-digit", minute: "2-digit" },
  )}`;
};
const SORT_FN: Record<Exclude<Sort, "default">, (a: Song, b: Song) => number> = {
  oldest: (a, b) => a.date - b.date || a.id - b.id,
  "name-asc": (a, b) => collator.compare(nameOf(a), nameOf(b)),
  "name-desc": (a, b) => collator.compare(nameOf(b), nameOf(a)),
  "size-desc": (a, b) => (b.size || 0) - (a.size || 0),
  "size-asc": (a, b) => (a.size || 0) - (b.size || 0),
  "dur-desc": (a, b) => (b.duration ?? -1) - (a.duration ?? -1),
  "dur-asc": (a, b) => (a.duration ?? Infinity) - (b.duration ?? Infinity),
};
// favourites hold every kind: the type filter is applied to them here (a chat is read with Telegram's filter)
const KIND_OF: Record<FileType, (s: Song) => boolean> = {
  all: () => true,
  music: (s) => s.kind === "audio",
  video: (s) => s.kind === "video",
  photo: (s) => s.kind === "photo" || s.kind === "image",
  document: (s) => s.kind === "document",
  voice: (s) => s.kind === "voice",
};

type Members = { chatId: string; members: number | null; type: string };

/** One of them, at random (a playlist's shuffled start). */
const anyOf = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)];

/** A playlist's row grip: pressed, the row follows the finger to its new place (react-native-reorderable-list). */
function DragGrip({ label }: { label: string }) {
  const t = useTheme();
  const drag = useReorderableDrag();
  return (
    <Pressable onPressIn={drag} hitSlop={6} style={styles.rowBtn} accessibilityRole="button" accessibilityLabel={label}>
      <Icon name="grip-vertical" size={17} color={t.textMuted} />
    </Pressable>
  );
}

/** One screen per list: another chat (or search) opened in its place starts afresh, nothing of the last one shown. */
export default function ChatScreen() {
  const { id, q } = useLocalSearchParams<{ id: string; q?: string }>();
  return <ChatFiles key={`${id}|${q ?? ""}`} />;
}

function ChatFiles() {
  const t = useTheme();
  const tr = useT();
  const toast = useToast();
  const params = useLocalSearchParams<{ id: string; title?: string; song?: string; q?: string }>();
  const fav = params.id === "fav";
  const plId = params.id.startsWith("pl:") ? params.id.slice(3) : null; // a playlist
  const search = params.id === "search" ? (params.q ?? "") : null; // the words of a song search
  const isSearch = search !== null;
  const multi = fav || plId !== null; // songs of several chats, read by their keys (no more pages)
  // a chat of the account (or one found by the search): its subscribers / members under the title
  const plainChat = !multi && !isSearch;
  const { favorites, isFavorite, toggleFavorite, playlists, editPlaylist } = useLibrary();
  const playlist = plId !== null ? (playlists.find((p) => p.id === plId) ?? null) : null;
  const { now, playing, play, toggle, shuffle: shuffling, setShuffle } = usePlayer();

  const [type, setType] = useState<FileType>("all");
  const [sort, setSort] = useState<Sort>("default");
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all"); // favourites: one chat or all
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filterOpen, setFilterOpen] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [pick, setPick] = useState<"type" | "sort" | null>(null);
  const [adding, setAdding] = useState<string[] | null>(null); // songs being added to a playlist (the picker)
  const [renaming, setRenaming] = useState(false);

  const newList = (nextType: FileType = "all", fresh = false): FileList =>
    fav
      ? new FavoritesScan(favorites)
      : plId !== null
        ? new FavoritesScan(playlist?.songs ?? [], "playlist", plId)
        : isSearch
          ? songSearch(search, { fresh })
          : new SongScan(params.id, nextType, params.title);
  const [list, setList] = useState<FileList>(() => newList());
  const [songs, setSongs] = useState<Song[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const listRef = useRef<FlashListRef<Song>>(null);
  // "near the end" fires again after every render while a short list stays on screen: read more only once per
  // length, or a short page that says there is more would read again and again
  const endFor = useRef(-1);

  const title = fav
    ? tr("Bài hát yêu thích")
    : plId !== null
      ? (playlist?.name ?? tr("Playlist"))
      : isSearch
        ? tr("Tìm: “{q}”", { q: search })
        : (params.title ?? chatById(params.id)?.title ?? tr("Kênh"));

  // "2.402 người theo dõi" / "35 thành viên": known (asked < 10 min ago) at once, else asked beside the songs;
  // an answer for another chat is never shown, an error leaves the line empty
  const chatType = plainChat ? chatById(params.id)?.type : undefined;
  const [members, setMembers] = useState<Members | null>(() => {
    const m = plainChat ? knownMembers(params.id) : undefined;
    return m ? { chatId: params.id, ...m } : null;
  });
  useEffect(() => {
    if (!plainChat || chatType === "user" || MOCK) return;
    let live = true;
    const chatId = params.id;
    chatMembers(chatId)
      .then((m) => live && setMembers({ chatId, ...m }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [plainChat, chatType, params.id]);
  const membersText =
    members?.chatId === params.id && members.members && members.type !== "user" && members.type !== "bot"
      ? tr(members.type === "channel" ? "{n} người theo dõi" : "{n} thành viên", {
          n: members.members.toLocaleString(tr.locale),
        })
      : "";

  function read(l: FileList) {
    setLoading(true);
    setError(undefined);
    l.next((n) => setCount(n))
      .then(() => {
        setSongs([...l.songs]);
        setHasMore(l.more);
      })
      .catch((err) => setError(String((err as Error)?.message ?? err)))
      .finally(() => setLoading(false));
  }
  useEffect(() => {
    // the first page; more with "Tải thêm 500 file" or when the list nears its end. A song search opened from
    // the chat list already has its first page: shown as it is, not asked again
    (isSearch && list.songs.length ? Promise.resolve() : list.next((n) => setCount(n)))
      .then(() => {
        setSongs([...list.songs]);
        setHasMore(list.more);
        // connect now to where these files are kept, so a tap does not wait for it
        warmUp(list.songs.slice(0, 50).map((s) => list.message(s.id)?.media));
      })
      .catch((err) => setError(String((err as Error)?.message ?? err)))
      .finally(() => setLoading(false));
    // (isSearch never changes on this screen: it is drawn again with a new key for another list)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list]);

  // a new type, or the reload button: read the chat again
  const rescan = (nextType = type) => {
    setSelected(new Set());
    setCount(0);
    setSongs([]);
    setLoading(true);
    setList(newList(nextType, true));
  };

  // the files shown: favourites still hearted, chat, type, search, sort
  const shown = useMemo(() => {
    let out = songs;
    if (fav) {
      out = out.filter((s) => isFavorite(s.key) && KIND_OF[type](s));
      if (scope !== "all") out = out.filter((s) => s.key.split("|")[0] === scope);
    } else if (plId !== null) {
      // the playlist as it is now: a song taken out leaves, its order is followed (changed here or elsewhere)
      const at = new Map((playlist?.songs ?? []).map((k, i) => [k, i]));
      out = out.filter((s) => at.has(s.key) && KIND_OF[type](s)).sort((a, b) => at.get(a.key)! - at.get(b.key)!);
    } else if (isSearch && type !== "all") out = out.filter(KIND_OF[type]); // read once, for every type
    const q = norm(query.trim());
    if (q) out = out.filter((s) => norm(`${s.title ?? ""} ${s.performer ?? ""} ${s.name} ${s.chat ?? ""}`).includes(q));
    if (sort !== "default") out = [...out].sort(SORT_FN[sort]);
    return out;
  }, [songs, fav, plId, playlist, isSearch, scope, type, query, sort, isFavorite]);

  // a playlist: songs added to it (from another list, or on another device) are read; deleted: back
  const plSongs = playlist?.songs;
  const hadPlaylist = useRef(false); // it was there (gone now: deleted) — not just not read yet at start
  useEffect(() => {
    if (plId === null || loading) return;
    if (!plSongs) {
      if (!hadPlaylist.current) return;
      if (router.canGoBack()) router.back();
      else router.replace("/playlists");
      return;
    }
    hadPlaylist.current = true;
    // only songs never asked for (a song of a chat left since is asked once, not again and again)
    const asked = new Set((list as FavoritesScan).keys);
    if (plSongs.some((k) => !asked.has(k))) queueMicrotask(() => rescan()); // (after this render)
    // rescan is this screen's own loader
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plId, plSongs, loading]);
  // dragged by their grip: only in the playlist's own order, nothing hidden by the search
  const sortable = plId !== null && sort === "default" && !query.trim() && type === "all";

  // opened on a song (a tap on the playing song's name, or on a song found by the search): read on until it is
  // there (a few pages at most), bring it into view and flash it
  const [flash, setFlash] = useState<string | null>(null);
  const sought = useRef({ key: "", pages: 0, done: false });
  useEffect(() => {
    if (!params.song) return;
    if (sought.current.key !== params.song) sought.current = { key: params.song, pages: 0, done: false };
    if (sought.current.done) return;
    const i = shown.findIndex((s) => s.key === params.song);
    if (i >= 0) {
      sought.current.done = true;
      const key = params.song;
      setTimeout(() => {
        listRef.current?.scrollToIndex({ index: i, viewPosition: 0.5, animated: false });
        setFlash(key);
      }, 50);
      return;
    }
    if (!multi && hasMore && !loading && songs.length && sought.current.pages < 20) {
      sought.current.pages++;
      read(list);
    }
    // read() is this screen's own loader, the same on every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.song, shown, hasMore, loading]);
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(timer);
  }, [flash]);

  const filters = (type !== "all" ? 1 : 0) + (sort !== "default" ? 1 : 0);
  const sub =
    shown.length === songs.length || multi
      ? tr("{n} file", { n: `${shown.length}${hasMore && !multi ? "+" : ""}` })
      : tr("{n}/{total} file đang hiện", { n: shown.length, total: `${songs.length}${hasMore ? "+" : ""}` });
  const chosen = shown.filter((s) => selected.has(s.key));
  const allTicked = shown.length > 0 && chosen.length === shown.length;
  const tick = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelected(next);
  };

  // favourites: the chats that have hearts, with how many
  const scopes = useMemo(() => {
    if (!fav) return [];
    const m = new Map<string, { name: string; count: number }>();
    for (const s of songs) {
      if (!isFavorite(s.key)) continue;
      const id = s.key.split("|")[0];
      const c = m.get(id) ?? { name: s.chat ?? "", count: 0 };
      c.count++;
      m.set(id, c);
    }
    return [...m].sort((a, b) => collator.compare(a[1].name, b[1].name));
  }, [fav, songs, isFavorite]);
  const favTotal = scopes.reduce((n, [, c]) => n + c.count, 0);
  const scopeChat = scopes.find(([id]) => id === scope)?.[1];
  const scopeLabel =
    scope === "all" || !scopeChat
      ? `${tr("Tất cả kênh — theo danh sách")} (${favTotal})`
      : `${scopeChat.name} (${scopeChat.count})`;

  const emptyView = loading ? null : (
    <View style={styles.empty}>
      {error ? (
        <T color={t.coral} style={{ textAlign: "center" }}>
          {tr(error)}
        </T>
      ) : plId !== null && !playlist?.songs.length ? (
        <>
          <Icon name="music-note-list" size={44} color={t.primary} />
          <T style={{ marginTop: 8 }}>{tr("Playlist chưa có bài nào")}</T>
          <T size={13} muted style={{ textAlign: "center", marginTop: 4 }}>
            {tr("Mở một kênh và bấm + ở mỗi bài để thêm vào đây.")}
          </T>
        </>
      ) : fav && !favorites.length ? (
        <>
          <Icon name="heart" size={44} color="#ec4899" />
          <T style={{ marginTop: 8 }}>{tr("Chưa có bài hát yêu thích")}</T>
          <T size={13} muted style={{ textAlign: "center", marginTop: 4 }}>
            {tr("Mở một kênh và bấm ♡ ở cuối mỗi dòng để thêm vào đây.")}
          </T>
        </>
      ) : songs.length ? (
        <T muted>{tr("Không có file khớp bộ lọc")}</T>
      ) : isSearch ? (
        <>
          <Icon name="search" size={40} color={t.textMuted} />
          <T muted style={{ marginTop: 8 }}>
            {tr("Không tìm thấy bài hát")}
          </T>
        </>
      ) : (
        <>
          <Icon name="inbox" size={44} color={t.textMuted} />
          <T muted style={{ marginTop: 8 }}>
            {tr("Kênh không có file loại này")}
          </T>
        </>
      )}
    </View>
  );
  const footerView = loading ? (
    <View style={styles.more}>
      <ActivityIndicator color={t.primary} size="small" />
      <T size={13.6} muted>
        {songs.length
          ? tr("Đang tải thêm…")
          : isSearch
            ? tr("Đang tìm…")
            : count
              ? tr("Đang quét kênh… {n} file", { n: count })
              : tr("Đang quét kênh…")}
      </T>
    </View>
  ) : !multi && hasMore && songs.length ? (
    <View style={styles.more}>
      <Pill
        title={tr("Tải thêm {n} file", { n: isSearch ? SONG_PAGE : PAGE_SIZE })}
        icon="arrow-down-circle"
        color={t.violet}
        onPress={() => read(list)}
      />
    </View>
  ) : !multi && songs.length > PAGE_SIZE ? (
    <T size={13.6} muted style={{ textAlign: "center", padding: 14 }}>
      {tr("Đã tải hết {n} file", { n: songs.length })}
    </T>
  ) : null;
  const renderSong = ({ item }: { item: Song }) => {
    const current = now?.song.key === item.key;
    const on = current && playing;
    const sel = selected.has(item.key);
    const heart = isFavorite(item.key);
    const label = displayName(item);
    return (
      <Pressable
        // the finger is down: start fetching the song's first piece before it lifts
        onPressIn={() => playable(item) && !current && prefetchHead(item.key, list.message(item.id)?.media, item.size)}
        onPress={() => {
          if (!playable(item)) return tick(item.key);
          haptic();
          if (current) toggle();
          else play(list, item);
        }}
        style={({ pressed }) => [
          styles.row,
          {
            borderBottomColor: t.border,
            backgroundColor: flash === item.key ? tint(t.primary, 0.18) : sel ? t.selected : pressed ? t.bg : t.surface,
          },
        ]}
      >
        <View style={styles.colCheck}>
          <Checkbox checked={sel} onPress={() => tick(item.key)} label={label} />
        </View>
        <View style={styles.colPlay}>
          {playable(item) ? (
            current ? (
              <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.playBtn}>
                <Icon name={on ? "pause-fill" : "play-fill"} size={15} color="#fff" />
              </LinearGradient>
            ) : (
              <View style={[styles.playBtn, { borderWidth: 1, borderColor: tint(t.pink, 0.4) }]}>
                <Icon name="play-fill" size={15} color={t.pink} style={{ marginLeft: 2 }} />
              </View>
            )
          ) : (
            <Icon
              name={item.kind === "video" ? "play-btn" : item.kind === "document" ? "file-earmark" : "eye"}
              size={17}
              color={t.textMuted}
            />
          )}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T
            weight="medium"
            numberOfLines={2}
            style={{ lineHeight: 19.5 }}
            color={current ? (t.dark ? "#c4b5fd" : t.primary) : undefined}
          >
            {label}
          </T>
          {/* the lines under the name: one small size and line height, evenly spaced */}
          <View style={styles.meta}>
            {label !== item.name && (
              <View style={styles.line}>
                <Icon name="file-earmark-music" size={11} color={t.textMuted} />
                <T size={12} muted numberOfLines={1} style={styles.lineText}>
                  {item.name}
                </T>
              </View>
            )}
            {/* when it was posted in the chat */}
            {item.date > 0 && (
              <View style={styles.line} accessibilityLabel={tr("Ngày đăng lên kênh")}>
                <Icon name="clock" size={11} color={t.textMuted} />
                <T size={12} muted numberOfLines={1} style={styles.lineText}>
                  {postedAt(item.date, tr.locale)}
                </T>
              </View>
            )}
            {(multi || isSearch) && item.chat ? (
              <View style={styles.line}>
                <Icon name="megaphone" size={11} color={t.pink} />
                <T size={12} numberOfLines={1} color={t.pink} style={styles.lineText}>
                  {item.chat}
                </T>
              </View>
            ) : null}
            <T size={12} weight="semibold" muted numberOfLines={1} style={styles.lineText}>
              {[fmtSize(item.size), fmtDur(item.duration)].filter(Boolean).join(" · ")}
            </T>
          </View>
        </View>
        {plId !== null && playable(item) && (
          <Pressable
            onPress={() => {
              haptic();
              const r = editPlaylist({ op: "remove", id: plId, songs: [item.key] });
              if (r.error) toast(tr(r.error), "error");
              else toast(tr("Đã bỏ “{song}” khỏi “{name}”", { song: label, name: playlist?.name ?? "" }), "info");
            }}
            hitSlop={6}
            style={styles.rowBtn}
            accessibilityRole="button"
            accessibilityLabel={tr("Bỏ khỏi playlist")}
          >
            <Icon name="x-lg" size={14} color={t.textMuted} />
          </Pressable>
        )}
        {playable(item) && (
          <Pressable
            onPress={() => {
              haptic();
              setAdding([item.key]);
            }}
            hitSlop={6}
            style={styles.rowBtn}
            accessibilityRole="button"
            accessibilityLabel={tr("Thêm vào playlist")}
          >
            <Icon name="plus-lg" size={16} color={t.textMuted} />
          </Pressable>
        )}
        <Pressable
          onPress={() => {
            haptic();
            const added = toggleFavorite(item.key);
            toast(tr(added ? "Đã thêm vào Bài hát yêu thích" : "Đã bỏ khỏi Bài hát yêu thích"), added ? "bye" : "info");
          }}
          hitSlop={8}
          style={styles.heart}
          accessibilityRole="button"
          accessibilityLabel={tr(heart ? "Bỏ khỏi yêu thích" : "Thêm vào yêu thích")}
        >
          <Icon name={heart ? "heart-fill" : "heart"} size={17} color={heart ? "#ec4899" : t.textMuted} />
        </Pressable>
        {sortable && <DragGrip label={tr("Kéo để đổi thứ tự")} />}
      </Pressable>
    );
  };

  /** "Phát tất cả" / "Phát ngẫu nhiên": the playlist from its first song, or a random one (shuffle on). */
  function playAll(random: boolean) {
    const tracks = shown.filter(playable);
    if (!tracks.length) return toast(tr("Playlist chưa có bài nào"), "info");
    if (random && !shuffling) setShuffle(true);
    haptic();
    play(list, random ? anyOf(tracks) : tracks[0]);
  }

  function deletePlaylist() {
    if (!playlist) return;
    Alert.alert(
      tr("Xoá playlist"),
      tr("Xoá playlist “{name}”? Các bài hát vẫn còn trong kênh của chúng.", { name: playlist.name }),
      [
        { text: tr("Huỷ"), style: "cancel" },
        {
          text: tr("Xoá"),
          style: "destructive",
          onPress: () => {
            const r = editPlaylist({ op: "delete", id: playlist.id });
            if (r.error) return toast(tr(r.error), "error");
            toast(tr("Đã xoá playlist “{name}”", { name: playlist.name }), "info");
            // (the screen goes back by itself once it is gone)
          },
        },
      ],
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.surface }}>
      <View style={[styles.head, { borderBottomColor: t.border }]}>
        <RoundButton
          icon="chevron-left"
          color={t.violet}
          label={tr("Danh sách kênh")}
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/chats"))}
        />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T weight="semibold" size={20} numberOfLines={1} style={{ letterSpacing: -0.2 }}>
            {title}
          </T>
          {plainChat && chatType !== "user" && (
            <T size={13} muted numberOfLines={1} style={styles.headLine}>
              {membersText}
            </T>
          )}
          <T size={13} muted numberOfLines={1} style={styles.headLine}>
            {loading && !songs.length ? "" : sub}
          </T>
        </View>
        <Pill
          title={tr("Lọc")}
          icon="sliders"
          color={t.pink}
          badge={filters || undefined}
          onPress={() => setFilterOpen(true)}
        />
        <RoundButton
          icon="arrow-clockwise"
          color={t.green}
          square
          label={tr(loading ? "Đang quét kênh…" : "Quét lại")}
          onPress={() => !loading && rescan()}
        />
      </View>

      <View style={[styles.searchWrap, { borderBottomColor: t.border }]}>
        <View style={[styles.search, { borderColor: t.border }]}>
          <View style={[styles.searchIco, { borderRightColor: t.border, backgroundColor: t.bg }]}>
            <Icon name="search" size={15} color={t.text} />
          </View>
          <TextInput
            allowFontScaling={false}
            value={query}
            onChangeText={setQuery}
            placeholder={tr("Tìm tên bài, ca sĩ, tên file…")}
            placeholderTextColor={t.textMuted}
            style={[styles.searchInput, { color: t.text }]}
            returnKeyType="search"
          />
        </View>
      </View>

      {fav && (
        <View style={[styles.searchWrap, { borderBottomColor: t.border }]}>
          <Pressable
            onPress={() => setScopeOpen(true)}
            style={[styles.select, { borderColor: t.border }]}
            accessibilityRole="button"
            accessibilityLabel={tr("Chọn kênh")}
          >
            <View style={[styles.searchIco, { borderRightColor: t.border, backgroundColor: t.bg }]}>
              <Icon name="collection-play" size={15} color={t.text} />
            </View>
            <T numberOfLines={1} style={{ flex: 1, paddingHorizontal: 12 }}>
              {scopeLabel}
            </T>
            <Icon name="chevron-down" size={13} color={t.text} style={{ marginRight: 12 }} />
          </Pressable>
        </View>
      )}

      {plId !== null && playlist && (
        <View style={[styles.searchWrap, styles.plBar, { borderBottomColor: t.border }]}>
          <GradientButton
            title={tr("Phát tất cả")}
            icon="play-fill"
            radius={999}
            height={34}
            size={14}
            onPress={() => playAll(false)}
          />
          <Pill title={tr("Phát ngẫu nhiên")} icon="shuffle" color={t.violet} onPress={() => playAll(true)} />
          <View style={{ flex: 1 }} />
          <RoundButton
            icon="pencil"
            color={t.violet}
            label={tr("Đổi tên playlist")}
            onPress={() => setRenaming(true)}
          />
          <RoundButton icon="trash3" color={t.coral} label={tr("Xoá playlist")} onPress={deletePlaylist} />
        </View>
      )}

      <DownloadBar />

      {chosen.length > 0 && (
        <View style={styles.selBar}>
          <View style={[styles.selCount, { backgroundColor: t.violet }]}>
            <T size={11} weight="bold" color="#fff">
              {chosen.length}
            </T>
          </View>
          <T size={13} muted style={{ flex: 1 }}>
            {tr("bài · {size}", { n: chosen.length, size: fmtSize(chosen.reduce((n, s) => n + (s.size || 0), 0)) })}
          </T>
          {chosen.some(playable) && (
            <Pill
              icon="plus-lg"
              color={t.violet}
              small
              label={tr("Thêm vào playlist")}
              onPress={() => setAdding(chosen.filter(playable).map((x) => x.key))}
            />
          )}
          <GradientButton
            title={tr("Tải xuống ({n})", { n: chosen.length })}
            icon="download"
            colors={["#10b981", "#06b6d4"]}
            radius={999}
            height={30}
            size={13}
            onPress={async () => {
              const r = await download(chosen.map((song) => ({ song, media: list.message(song.id)?.media })));
              if (!r) return toast(tr("Chưa chọn thư mục để lưu"), "warn");
              setSelected(new Set());
              if (!r.added && r.already) return toast(tr("{n} file đã có sẵn trong thư mục", { n: r.already }), "info");
              toast(
                tr("Đã thêm {n} file vào hàng chờ", { n: r.added }) +
                  (r.already ? tr(" · {n} file đã có sẵn", { n: r.already }) : ""),
              );
            }}
          />
        </View>
      )}

      <View style={[styles.th, { backgroundColor: t.bg, borderBottomColor: t.border }]}>
        <View style={styles.colCheck}>
          <Checkbox
            checked={allTicked}
            mixed={!allTicked && chosen.length > 0}
            onPress={() => setSelected(allTicked ? new Set() : new Set(shown.map((s) => s.key)))}
            label={tr("Chọn tất cả")}
          />
        </View>
        <View style={styles.colPlay} />
        <Pressable
          onPress={() => {
            haptic();
            setSort(sort === "name-asc" ? "name-desc" : sort === "name-desc" ? "default" : "name-asc");
          }}
          style={styles.thName}
          accessibilityRole="button"
          accessibilityLabel={tr("Sắp theo tên")}
        >
          <T weight="bold" color={sort.startsWith("name") ? t.primary : undefined}>
            {tr("Tên bài")}
          </T>
          <Icon
            name={
              sort === "name-asc" ? "sort-alpha-down" : sort === "name-desc" ? "sort-alpha-up-alt" : "chevron-expand"
            }
            size={11}
            color={sort.startsWith("name") ? t.primary : t.textMuted}
          />
        </Pressable>
      </View>

      {sortable ? (
        // a playlist: rows dragged by their grip to a new place
        <ReorderableList
          data={shown}
          keyExtractor={(s) => s.key}
          extraData={[selected, now?.song.key, playing, favorites, tr.locale, flash]}
          ListEmptyComponent={emptyView}
          ListFooterComponent={footerView}
          renderItem={renderSong}
          onReorder={({ from, to }) => {
            const keys = shown.map((x) => x.key);
            const [moved] = keys.splice(from, 1);
            keys.splice(to, 0, moved);
            const r = editPlaylist({ op: "order", id: plId!, songs: keys });
            if (r.error) toast(tr(r.error), "error");
          }}
        />
      ) : (
        <FlashList
          ref={listRef}
          data={shown}
          keyExtractor={(s) => s.key}
          extraData={[selected, now?.song.key, playing, favorites, tr.locale, flash, playlists]}
          onEndReached={() => {
            if (multi || !hasMore || loading || endFor.current === songs.length) return;
            endFor.current = songs.length;
            read(list);
          }}
          onEndReachedThreshold={0.6}
          ListEmptyComponent={emptyView}
          ListFooterComponent={footerView}
          renderItem={renderSong}
        />
      )}

      <Sheet
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        title={tr("Bộ lọc & sắp xếp")}
        icon="sliders"
        bottom
        footer={<GradientButton title={tr("Xong")} radius={999} height={42} onPress={() => setFilterOpen(false)} />}
      >
        <Field
          label={tr("Loại file")}
          value={tr(TYPES.find(([k]) => k === type)?.[1] ?? "")}
          onPress={() => setPick("type")}
        />
        <Field
          label={tr("Sắp xếp")}
          value={tr(SORTS.find(([k]) => k === sort)?.[1] ?? "")}
          onPress={() => setPick("sort")}
        />
        <T size={13} muted style={{ textAlign: "center" }}>
          {tr("{n} file", { n: `${shown.length}/${songs.length}${hasMore && !multi ? "+" : ""}` })}
        </T>
      </Sheet>

      <Sheet
        open={pick !== null}
        onClose={() => setPick(null)}
        title={tr(pick === "type" ? "Loại file" : "Sắp xếp")}
        icon={pick === "type" ? "funnel" : "sort-down"}
        bottom
      >
        <FlatList
          data={(pick === "type" ? TYPES : SORTS) as [string, string][]}
          keyExtractor={([k]) => k}
          style={{ marginHorizontal: -16 }}
          renderItem={({ item: [k, label] }) => {
            const active = pick === "type" ? k === type : k === sort;
            return (
              <Pressable
                onPress={() => {
                  haptic();
                  setPick(null);
                  if (pick === "type") {
                    setType(k as FileType);
                    if (!fav && !isSearch) rescan(k as FileType);
                  } else setSort(k as Sort);
                }}
                style={[styles.option, active && { backgroundColor: t.primary }]}
              >
                <T style={{ flex: 1 }} color={active ? "#fff" : undefined}>
                  {tr(label)}
                </T>
                {active && <Icon name="check2" size={15} color="#fff" />}
              </Pressable>
            );
          }}
        />
      </Sheet>

      <Sheet open={scopeOpen} onClose={() => setScopeOpen(false)} title={tr("Kênh")} icon="collection-play" bottom>
        <FlatList
          data={[["all", { name: tr("Tất cả kênh — theo danh sách"), count: favTotal }] as const, ...scopes]}
          keyExtractor={([id]) => id}
          style={{ marginHorizontal: -16 }}
          renderItem={({ item: [id, c] }) => {
            const active = id === scope;
            return (
              <Pressable
                onPress={() => {
                  haptic();
                  setScope(id);
                  setScopeOpen(false);
                }}
                style={[styles.option, active && { backgroundColor: t.primary }]}
              >
                <T style={{ flex: 1 }} numberOfLines={1} color={active ? "#fff" : undefined}>
                  {c.name} ({c.count})
                </T>
                {active && <Icon name="check2" size={15} color="#fff" />}
              </Pressable>
            );
          }}
        />
      </Sheet>

      <PlaylistPicker
        songs={adding ?? []}
        open={adding !== null}
        onDone={(added) => {
          if (added && (adding?.length ?? 0) > 1) setSelected(new Set()); // added from the ticked rows: unticked
          setAdding(null);
        }}
      />
      <NameSheet
        open={renaming}
        title={tr("Đổi tên playlist")}
        initial={playlist?.name ?? ""}
        except={playlist?.id ?? null}
        onClose={() => setRenaming(false)}
        onSave={(name) => {
          const r = playlist ? editPlaylist({ op: "rename", id: playlist.id, name }) : { error: undefined };
          if (r.error) return toast(tr(r.error), "error");
          toast(tr("Đã đổi tên playlist"));
          setRenaming(false);
        }}
      />
    </View>
  );
}

function Field({ label, value, onPress }: { label: string; value: string; onPress: () => void }) {
  const t = useTheme();
  return (
    <View>
      <T size={13} weight="semibold" style={{ marginBottom: 6 }}>
        {label}
      </T>
      <Pressable
        onPress={() => {
          haptic();
          onPress();
        }}
        style={[styles.select, { borderColor: t.border, backgroundColor: t.surface }]}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${value}`}
      >
        <T style={{ flex: 1, paddingHorizontal: 12 }}>{value}</T>
        <Icon name="chevron-down" size={13} color={t.text} style={{ marginRight: 12 }} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  searchWrap: { paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  search: { flexDirection: "row", height: 36, borderWidth: 1, borderRadius: 6 },
  searchIco: {
    width: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRightWidth: 1,
    borderTopLeftRadius: 5,
    borderBottomLeftRadius: 5,
    alignSelf: "stretch",
  },
  searchInput: { flex: 1, paddingHorizontal: 10, fontSize: 16, fontFamily: FONT.regular },
  select: { flexDirection: "row", alignItems: "center", height: 40, borderWidth: 1, borderRadius: 6 },
  selBar: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16, paddingVertical: 6 },
  selCount: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 5,
  },
  th: { flexDirection: "row", alignItems: "center", height: 32, borderBottomWidth: StyleSheet.hairlineWidth },
  thName: { flexDirection: "row", alignItems: "center", gap: 4, flex: 1 },
  colCheck: { width: 40, paddingLeft: 12, justifyContent: "center" },
  colPlay: { width: 46, alignItems: "center", justifyContent: "center" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 9,
    paddingRight: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  playBtn: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  meta: { marginTop: 4, gap: 2 },
  line: { flexDirection: "row", alignItems: "center", gap: 4 },
  lineText: { flexShrink: 1, lineHeight: 16 },
  headLine: { lineHeight: 17, minHeight: 17 },
  heart: { width: 34, height: 34, alignItems: "center", justifyContent: "center" },
  rowBtn: { width: 30, height: 34, alignItems: "center", justifyContent: "center" },
  plBar: { flexDirection: "row", alignItems: "center", gap: 8 },
  empty: { alignItems: "center", padding: 32 },
  more: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, padding: 14 },
  option: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 12 },
});
