// A chat's files (or "Bài hát yêu thích" for id "fav"), like the web's list on a phone: ‹ title "N file", Lọc,
// reload; search; (favourites: which chat); "Tên bài" header with select-all; rows with a checkbox, ▶, name, file
// name, size · duration, ♡; "Tải thêm 500 file". Tap a song to play it. "Lọc" opens type / sort.
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { LinearGradient } from "expo-linear-gradient";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, TextInput, View } from "react-native";

import { PAGE_SIZE, displayName } from "../../../../core.js";
import { DownloadBar } from "@/components/DownloadBar";
import { Icon } from "@/components/Icon";
import { norm } from "@/components/RecentPanel";
import { Sheet } from "@/components/Sheet";
import { useToast } from "@/components/Toast";
import { Checkbox, GradientButton, Pill, RoundButton, T, fmtDur, fmtSize, haptic } from "@/components/ui";
import { download } from "@/download/downloads";
import { useT } from "@/i18n";
import { playable, usePlayer } from "@/player/PlayerProvider";
import { prefetchHead, warmUp } from "@/player/prefetch";
import { useLibrary } from "@/store/LibraryProvider";
import { FavoritesScan, SongScan, chatById, type FileList, type FileType, type Song } from "@/telegram/library";
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
  ["default", "Mặc định (mới nhất trước)"],
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

export default function ChatFiles() {
  const t = useTheme();
  const tr = useT();
  const toast = useToast();
  const params = useLocalSearchParams<{ id: string; title?: string; song?: string }>();
  const fav = params.id === "fav";
  const { favorites, isFavorite, toggleFavorite } = useLibrary();
  const { now, playing, play, toggle } = usePlayer();

  const [type, setType] = useState<FileType>("all");
  const [sort, setSort] = useState<Sort>("default");
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all"); // favourites: one chat or all
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filterOpen, setFilterOpen] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [pick, setPick] = useState<"type" | "sort" | null>(null);

  const [list, setList] = useState<FileList>(() =>
    fav ? new FavoritesScan(favorites) : new SongScan(params.id, "all", params.title),
  );
  const [songs, setSongs] = useState<Song[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const listRef = useRef<FlashListRef<Song>>(null);
  // "near the end" fires again after every render while a short list stays on screen: read more only once per
  // length, or a short page that says there is more would read again and again
  const endFor = useRef(-1);

  const title = fav ? tr("Bài hát yêu thích") : (params.title ?? chatById(params.id)?.title ?? tr("Kênh"));

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
    // the first page; more with "Tải thêm 500 file" or when the list nears its end
    list
      .next((n) => setCount(n))
      .then(() => {
        setSongs([...list.songs]);
        setHasMore(list.more);
        // connect now to where these files are kept, so a tap does not wait for it
        warmUp(list.songs.slice(0, 50).map((s) => list.message(s.id)?.media));
      })
      .catch((err) => setError(String((err as Error)?.message ?? err)))
      .finally(() => setLoading(false));
  }, [list]);

  // a new type, or the reload button: read the chat again
  const rescan = (nextType = type) => {
    setSelected(new Set());
    setCount(0);
    setSongs([]);
    setLoading(true);
    setList(fav ? new FavoritesScan(favorites) : new SongScan(params.id, nextType, params.title));
  };

  // the files shown: favourites still hearted, chat, type, search, sort
  const shown = useMemo(() => {
    let out = songs;
    if (fav) {
      out = out.filter((s) => isFavorite(s.key) && KIND_OF[type](s));
      if (scope !== "all") out = out.filter((s) => s.key.split("|")[0] === scope);
    }
    const q = norm(query.trim());
    if (q) out = out.filter((s) => norm(`${s.title ?? ""} ${s.performer ?? ""} ${s.name} ${s.chat ?? ""}`).includes(q));
    if (sort !== "default") out = [...out].sort(SORT_FN[sort]);
    return out;
  }, [songs, fav, scope, type, query, sort, isFavorite]);

  // opened from the player (tap on the song's name): bring the playing song into view
  useEffect(() => {
    if (!params.song || !shown.length) return;
    const i = shown.findIndex((s) => s.key === params.song);
    if (i >= 0) setTimeout(() => listRef.current?.scrollToIndex({ index: i, viewPosition: 0.5, animated: false }), 50);
  }, [params.song, shown]);

  const filters = (type !== "all" ? 1 : 0) + (sort !== "default" ? 1 : 0);
  const sub =
    shown.length === songs.length || fav
      ? tr("{n} file", { n: `${shown.length}${hasMore && !fav ? "+" : ""}` })
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
          <T size={13} muted>
            {sub}
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

      <FlashList
        ref={listRef}
        data={shown}
        keyExtractor={(s) => s.key}
        extraData={[selected, now?.song.key, playing, favorites, tr.locale]}
        onEndReached={() => {
          if (fav || !hasMore || loading || endFor.current === songs.length) return;
          endFor.current = songs.length;
          read(list);
        }}
        onEndReachedThreshold={0.6}
        ListEmptyComponent={
          loading ? null : (
            <View style={styles.empty}>
              {error ? (
                <T color={t.coral} style={{ textAlign: "center" }}>
                  {tr(error)}
                </T>
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
              ) : (
                <>
                  <Icon name="inbox" size={44} color={t.textMuted} />
                  <T muted style={{ marginTop: 8 }}>
                    {tr("Kênh không có file loại này")}
                  </T>
                </>
              )}
            </View>
          )
        }
        ListFooterComponent={
          loading ? (
            <View style={styles.more}>
              <ActivityIndicator color={t.primary} size="small" />
              <T size={13.6} muted>
                {songs.length
                  ? tr("Đang tải thêm…")
                  : count
                    ? tr("Đang quét kênh… {n} file", { n: count })
                    : tr("Đang quét kênh…")}
              </T>
            </View>
          ) : !fav && hasMore && songs.length ? (
            <View style={styles.more}>
              <Pill
                title={tr("Tải thêm {n} file", { n: PAGE_SIZE })}
                icon="arrow-down-circle"
                color={t.violet}
                onPress={() => read(list)}
              />
            </View>
          ) : !fav && songs.length > PAGE_SIZE ? (
            <T size={13.6} muted style={{ textAlign: "center", padding: 14 }}>
              {tr("Đã tải hết {n} file", { n: songs.length })}
            </T>
          ) : null
        }
        renderItem={({ item }) => {
          const current = now?.song.key === item.key;
          const on = current && playing;
          const sel = selected.has(item.key);
          const heart = isFavorite(item.key);
          const label = displayName(item);
          return (
            <Pressable
              // the finger is down: start fetching the song's first piece before it lifts
              onPressIn={() =>
                playable(item) && !current && prefetchHead(item.key, list.message(item.id)?.media, item.size)
              }
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
                  backgroundColor: sel ? t.selected : pressed ? t.bg : t.surface,
                },
              ]}
            >
              <View style={styles.colCheck}>
                <Checkbox checked={sel} onPress={() => tick(item.key)} label={label} />
              </View>
              <View style={styles.colPlay}>
                {playable(item) ? (
                  current ? (
                    <LinearGradient
                      colors={GRADIENT}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 1 }}
                      style={styles.playBtn}
                    >
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
                {label !== item.name && (
                  <View style={styles.line}>
                    <Icon name="file-earmark-music" size={11} color={t.textMuted} />
                    <T size={12} muted numberOfLines={1} style={{ flexShrink: 1 }}>
                      {item.name}
                    </T>
                  </View>
                )}
                {/* when it was posted in the chat */}
                {item.date > 0 && (
                  <View style={styles.line} accessibilityLabel={tr("Ngày đăng lên kênh")}>
                    <Icon name="clock" size={11} color={t.textMuted} />
                    <T size={12} muted numberOfLines={1} style={{ flexShrink: 1 }}>
                      {postedAt(item.date, tr.locale)}
                    </T>
                  </View>
                )}
                {fav && item.chat ? (
                  <View style={styles.line}>
                    <Icon name="megaphone" size={11} color={t.pink} />
                    <T size={12.5} numberOfLines={1} color={t.pink} style={{ flexShrink: 1 }}>
                      {item.chat}
                    </T>
                  </View>
                ) : null}
                <T size={13} weight="semibold" muted style={{ marginTop: 3 }}>
                  {[fmtSize(item.size), fmtDur(item.duration)].filter(Boolean).join(" · ")}
                </T>
              </View>
              <Pressable
                onPress={() => {
                  haptic();
                  const added = toggleFavorite(item.key);
                  toast(
                    tr(added ? "Đã thêm vào Bài hát yêu thích" : "Đã bỏ khỏi Bài hát yêu thích"),
                    added ? "bye" : "info",
                  );
                }}
                hitSlop={8}
                style={styles.heart}
                accessibilityRole="button"
                accessibilityLabel={tr(heart ? "Bỏ khỏi yêu thích" : "Thêm vào yêu thích")}
              >
                <Icon name={heart ? "heart-fill" : "heart"} size={17} color={heart ? "#ec4899" : t.textMuted} />
              </Pressable>
            </Pressable>
          );
        }}
      />

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
          {tr("{n} file", { n: `${shown.length}/${songs.length}${hasMore && !fav ? "+" : ""}` })}
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
                    if (!fav) rescan(k as FileType);
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
  line: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 1 },
  heart: { width: 34, height: 34, alignItems: "center", justifyContent: "center" },
  empty: { alignItems: "center", padding: 32 },
  more: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, padding: 14 },
  option: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 12 },
});
