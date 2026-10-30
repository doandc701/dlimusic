// The page of a shared playlist (/s/<code>, public/share.html): listened to without signing in.
// The list comes from /api/cloud/share-open; each song plays from a signed URL that lives a few minutes
// (/api/cloud/share-play, see cloud/share.js). There is no download button and no lasting file link; when a
// URL has expired (paused for long, then sought) a new one is asked for and the song goes on where it was.
// The owner's browser uploads the songs after the link is made: those not there yet are greyed, skipped, and
// the list is read again every 15 s until all are there.
//
// The player is the main page's (index.html's dock, styles.css, the same ids) and plays the same way as ui.js:
// shuffle (a shuffled order, a fresh one each round) and repeat (one / all, kept between visits), ⏮ back to the
// start after 3 s, ±10 s, speed and sleep timer (kept / faded like there), the seek bar's colours and time tip,
// Space / ← / → / Shift+← / Shift+→, the lock screen, a reload going on where it was, the silent bridge
// between two songs on a locked phone, and the dancing kittens. Only what needs an account (♥, recent) is not here.
// Like the main page too, the next songs are fetched whole while one plays (3 pieces at a time) and kept in this
// page: the next one starts at once, and plays on with the screen locked even if the network stalls meanwhile.
// The list comes with the songs' signed URLs, so a song starts with a single request.
(() => {
  const $ = (id) => document.getElementById(id);
  const t = window.t || ((s) => s);
  const show = (el, on) => el.classList.toggle("d-none", !on);
  const code =
    /^\/s\/([\w-]{16})\/?$/.exec(location.pathname)?.[1] || new URLSearchParams(location.search).get("code") || "";
  const VOLUME_KEY = "shareVolume"; // this browser's volume on shared pages
  const PLAYBACK_KEY = "tdl.sharePlayback"; // { code, id, time, at }: a reload goes on where it was
  const POLL_MS = 15_000; // while songs are being uploaded
  const POLL_IDLE_MS = 60_000; // else: the owner may sync the playlist (songs added, taken out, moved)

  // the footer, like the main page's: © the visitor's year, the slogan
  // (only "tap to play": nothing is saved from a shared playlist)
  const SLOGAN = "Chạm là nghe";
  for (const el of document.querySelectorAll(".app-slogan")) el.textContent = t(SLOGAN);
  for (const el of document.querySelectorAll(".copy-year")) el.textContent = new Date().getFullYear();

  const player = $("player"); // in the page, like the main page's (index.html)
  let songs = [];
  let current = -1;
  let order = []; // the play order (song indexes): the list's, or shuffled from the song playing
  let seeking = false;
  let retried = false; // one new URL per failure, so a broken file does not loop
  let waiting = null; // the song to play once it is uploaded (the one before it ended meanwhile)
  let shuffle = false;
  let repeat = "off"; // off | one | all
  let expiresAt = 0;
  let until = "";
  let urlTtl = 600; // seconds a song's signed URL lives (share-open's expiresIn)

  const esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  const time = (sec) => {
    if (!Number.isFinite(sec) || sec < 0) return "0:00";
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  };
  const locale = () => window.tdlI18n?.locale || "vi-VN";
  const dateText = (ms) =>
    new Date(ms).toLocaleString(locale(), {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  const duration = () => (Number.isFinite(player.duration) ? player.duration : songs[current]?.duration || 0);
  const load = (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null; // storage blocked
    }
  };
  const store = (key, value) => {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // storage blocked: this visit only
    }
  };

  // ---------- light / dark (theme.js applies it; until the button is used it follows the system), like ui.js ----------

  function renderTheme() {
    const dark = document.documentElement.getAttribute("data-bs-theme") === "dark";
    $("themeIcon").className = `bi ${dark ? "bi-moon-stars-fill" : "bi-sun-fill"}`;
    $("themeBtn").setAttribute("title", dark ? t("Chuyển sang giao diện sáng") : t("Chuyển sang giao diện tối"));
  }
  $("themeBtn").addEventListener("click", () => {
    const dark = document.documentElement.getAttribute("data-bs-theme") === "dark";
    window.tdlTheme?.set(dark ? "light" : "dark");
  });
  document.addEventListener("tdl:theme", renderTheme);
  renderTheme();

  // ---------- interface language (i18n.js translates the page; what this file draws is drawn again) ----------

  const i18n = window.tdlI18n;
  if (i18n) {
    $("langList").innerHTML = Object.entries(i18n.LANGS)
      .map(
        ([
          l,
          v,
        ]) => `<li><button type="button" class="dropdown-item d-flex align-items-center gap-2" data-lang="${esc(l)}"
          lang="${esc(v.html || l)}"><span class="flex-grow-1">${esc(v.name)}</span><i class="bi bi-check2"></i></button></li>`,
      )
      .join("");
    $("langList").addEventListener("click", (e) => {
      const b = e.target.closest("[data-lang]");
      if (!b) return;
      bootstrap.Dropdown.getOrCreateInstance($("langBtn")).hide(); // the page redraws: close it explicitly
      i18n.setLang(b.dataset.lang);
    });
  } else $("langMenu").classList.add("d-none");
  function renderLang() {
    if (!i18n) return;
    $("langCode").textContent = i18n.LANGS[i18n.lang].code;
    for (const b of document.querySelectorAll("#langList [data-lang]")) {
      const on = b.dataset.lang === i18n.lang;
      b.classList.toggle("active", on);
      b.setAttribute("aria-current", String(on));
    }
  }
  renderLang();
  /** After the language changed: what this file built with t() is drawn again, without a reload. */
  function redrawForLang() {
    renderLang();
    renderTheme();
    renderModes();
    setSpeed(player.defaultPlaybackRate, false);
    renderSleep();
    for (const el of document.querySelectorAll(".app-slogan")) el.textContent = t(SLOGAN);
    if (!songs.length) return;
    until = dateText(expiresAt);
    renderInfo();
    setSort(sort); // the size / length header, and the list
  }
  i18n?.onChange(redrawForLang);

  // ---------- toast (the main page's) ----------

  const TOAST_KINDS = { success: "bi-check-lg", error: "bi-x-lg", warn: "bi-exclamation-lg", info: "bi-info-lg" };
  const toastBox = bootstrap.Toast.getOrCreateInstance($("toast"), { delay: 3500 });
  function toast(msg, kind = "success") {
    $("toast").dataset.kind = kind;
    $("toast").setAttribute("role", kind === "error" ? "alert" : "status");
    $("toastIcon").className = `bi ${TOAST_KINDS[kind] || TOAST_KINDS.info}`;
    $("toastBody").textContent = msg;
    toastBox.show();
  }
  // toasts open right under the header (styles.css --nav-h)
  const navBar = document.querySelector(".navbar");
  new ResizeObserver(() => document.documentElement.style.setProperty("--nav-h", `${navBar.offsetHeight}px`)).observe(
    navBar,
  );

  async function get(action, query) {
    const res = await fetch(`/api/cloud/${action}?${new URLSearchParams(query)}`, { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), data, { status: res.status });
    return data;
  }

  // ---------- page load splash (the main page's, ui.js): "DLiMusic" comes in letter by letter ----------
  // The letters come in more and more slowly, the last one is kept back: the name is complete once the playlist is
  // read (or the page says why it cannot be), then the rest come in quickly and the splash fades.
  const splash = (() => {
    const el = $("bootSplash");
    const letters = [...$("bootWord").children];
    let shown = 0;
    let timer = null;
    let finished = false;
    const reveal = () => letters[shown++]?.classList.add("in");
    const creep = () => {
      if (shown >= letters.length - 1) return;
      reveal();
      timer = setTimeout(creep, 140 * 1.3 ** shown);
    };
    timer = setTimeout(creep, 100);
    setTimeout(() => self.finish(), 20_000); // still waiting after that: the page shows where it is
    const self = {
      finish() {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        const rest = () => {
          if (shown < letters.length) {
            reveal();
            return void (timer = setTimeout(rest, 70));
          }
          setTimeout(() => {
            el.classList.add("gone");
            setTimeout(() => el.remove(), 400);
          }, 350);
        };
        rest();
      },
    };
    return self;
  })();

  // ---------- the link can no longer be heard: a page of its own (the headphones cat asleep) ----------

  const GONE_CODES = new Set(["SHARE_GONE", "SHARE_EXPIRED", "SHARE_REVOKED"]);
  const isGone = (err) => GONE_CODES.has(err?.code);

  /**
   * Shows why the link cannot be heard (`err`: the function's answer): expired (the playlist's name and when),
   * revoked, not found; any other error: could not open, with "Thử lại". The music stops, the list goes.
   */
  function gone(err = null) {
    const kind = !err || err.code === "SHARE_GONE" ? "gone" : isGone(err) ? err.code : "error";
    const texts = {
      SHARE_EXPIRED: [
        t("Link này đã hết hạn"),
        err?.name && err?.expiredAt
          ? t("Playlist “{name}” đã hết hạn lúc {date}.", { name: err.name, date: dateText(err.expiredAt) })
          : t("Playlist này không còn nghe được nữa."),
      ],
      SHARE_REVOKED: [t("Link này đã bị thu hồi"), t("Người chia sẻ đã thu hồi link này.")],
      gone: [t("Không tìm thấy link này"), t("Link không đúng, hoặc đã hết hạn từ lâu.")],
      error: [t("Chưa mở được playlist"), t("Kết nối có vấn đề, hãy thử lại sau ít phút.")],
    };
    const [title, text] = texts[kind];
    $("goneTitle").textContent = title;
    $("goneText").textContent = text;
    show($("goneHint"), kind !== "error");
    show($("goneRetry"), kind === "error");
    document.title = `${title} · DLiMusic`;
    for (const id of ["listView", "emptyView", "playerBar"]) $(id).classList.add("d-none");
    $("emptyView").classList.remove("d-flex");
    $("goneView").classList.remove("d-none");
    $("goneView").classList.add("d-flex");
    $("homeLink").setAttribute("href", "/"); // nothing to come back to here: the logo opens DLiMusic
    goneShown = true;
    player.pause();
    player.removeAttribute("src");
    for (const w of wholes.values()) w.ctl.abort(); // the next songs are not fetched any more
    bridgeOn(false);
    store(PLAYBACK_KEY, null);
  }
  let goneShown = false;
  $("goneRetry").addEventListener("click", () => location.reload());

  // ---------- the list: the main page's table (ui.js rowHtml), its search and sorting ----------

  let query = "";
  let sort = "default";
  const collator = new Intl.Collator("vi", { numeric: true, sensitivity: "base" });
  // search key: fancy letters -> plain, no Vietnamese accents, lower case (ui.js norm)
  const norm = (v) =>
    String(v ?? "")
      .normalize("NFKC")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d")
      .replace(/Đ/g, "D")
      .toLowerCase();
  const fmt = (n) => {
    if (!n) return "";
    const u = ["B", "KB", "MB", "GB"];
    const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
    return `${(n / 1024 ** i).toFixed(1)} ${u[i]}`;
  };
  const SORTS = {
    default: (a, b) => a - b,
    reverse: (a, b) => b - a,
    "name-asc": (a, b) => collator.compare(songs[a].title, songs[b].title),
    "name-desc": (a, b) => collator.compare(songs[b].title, songs[a].title),
    "size-desc": (a, b) => (songs[b].size || 0) - (songs[a].size || 0),
    "size-asc": (a, b) => (songs[a].size || 0) - (songs[b].size || 0),
    "dur-desc": (a, b) => (songs[b].duration || 0) - (songs[a].duration || 0),
    "dur-asc": (a, b) => (songs[a].duration || 0) - (songs[b].duration || 0),
  };
  // what each header goes through when pressed again and again (ui.js HEADER_SORTS)
  const HEADER_SORTS = {
    num: ["default", "reverse"],
    name: ["name-asc", "name-desc"],
    size: ["size-desc", "size-asc", "dur-desc", "dur-asc"],
  };
  /** The songs (indexes) in the order shown, not narrowed by the search (the play order follows it). */
  const sortedSongs = () => songs.map((_, i) => i).sort(SORTS[sort]);
  const matches = (i) => !query || norm(`${songs[i].title} ${songs[i].performer || ""}`).includes(norm(query));

  function playCell(i) {
    if (!songs[i].ready)
      return `<button class="btn btn-sm btn-outline-secondary play-btn" disabled title="${t("Đang tải lên…")}">
        <i class="bi bi-hourglass-split"></i></button>`;
    const on = i === current && !player.paused;
    return `<button class="btn btn-sm ${on ? "btn-primary" : "btn-outline-primary"} play-btn" data-play="${i}"
      title="${on ? t("Tạm dừng") : t("Phát")}"><i class="bi ${on ? "bi-pause-fill" : "bi-play-fill"}"></i></button>`;
  }

  function rowHtml(i) {
    const s = songs[i];
    const cls = [i === current && "playing", !s.ready && "pending"].filter(Boolean).join(" ");
    const sizeDur = [fmt(s.size), s.duration ? time(s.duration) : ""].filter(Boolean).join(" · ");
    return `<tr class="${cls}" data-i="${i}">
      <td></td>
      <td class="play">${playCell(i)}</td>
      <td class="text-body-secondary small">${i + 1}</td>
      <td class="text-truncate name-cell"><div class="name-main">${esc(s.title)}</div>
        ${s.performer ? `<div class="small text-body-secondary text-truncate name-file"><i class="bi bi-person"></i>${esc(s.performer)}</div>` : ""}
        <div class="m-meta small text-body-secondary"><span class="m-size">${sizeDur}</span>${s.ready ? "" : `<span class="badge text-bg-secondary">${esc(t("Đang tải lên…"))}</span>`}</div></td>
      <td class="text-end text-body-secondary small">${fmt(s.size)}${s.duration ? `<div>${time(s.duration)}</div>` : ""}</td>
      <td></td></tr>`;
  }

  function renderList() {
    const list = sortedSongs().filter(matches);
    $("files").innerHTML = list.map(rowHtml).join("");
    show($("filesTable"), true);
    $("filesMsg").innerHTML = list.length
      ? ""
      : `<div class="text-center text-body-secondary p-5">${t("Không có bài nào khớp")}</div>`;
    $("fileCount").textContent = t("{n}/{total} bài", { n: list.length, total: songs.length });
  }

  function setSort(value) {
    sort = SORTS[value] ? value : "default";
    $("sortSel").value = sort;
    for (const th of document.querySelectorAll(".file-table th.sortable")) {
      const on = HEADER_SORTS[th.dataset.sort].includes(sort) && !(th.dataset.sort === "num" && sort === "default");
      th.classList.toggle("sorted", on);
      th.querySelector(".sort-ico").className =
        `bi sort-ico ${on ? (/asc$|^reverse$/.test(sort) ? "bi-caret-up-fill" : "bi-caret-down-fill") : "bi-chevron-expand"}`;
      if (th.dataset.sort === "size")
        th.firstChild.textContent = `${on && sort.startsWith("dur") ? t("Thời lượng") : t("Dung lượng")} `;
    }
    if (current >= 0) order = orderFrom(current); // the songs after the playing one follow the new order
    renderList();
    if (current >= 0) renderPlayer();
  }

  function renderInfo() {
    const ready = songs.filter((s) => s.ready).length;
    $("chatMembers").textContent =
      ready < songs.length
        ? t("{ready}/{n} bài sẵn sàng, còn lại đang tải lên · hết hạn {date}", {
            ready,
            n: songs.length,
            date: until,
          })
        : t("{n} bài · hết hạn {date}", { n: songs.length, date: until });
    $("plPlayBtn").disabled = !ready;
  }

  /** The playing song's row brought into view (when it is off screen, under the sticky header row). */
  function revealPlaying() {
    const row = $("files").querySelector(`tr[data-i="${current}"]`);
    if (!row) return; // hidden by the search
    const box = $("filesWrap").getBoundingClientRect();
    const head = $("filesWrap").querySelector("thead")?.getBoundingClientRect().height || 0;
    const r = row.getBoundingClientRect();
    if (r.top < box.top + head || r.bottom > box.bottom) row.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  // ---------- the order: shuffle / repeat (like ui.js orderFrom / playNext / playPrev) ----------

  /** The list's order as shown, or (shuffle) the song `i` first and the others shuffled. */
  function orderFrom(i) {
    const all = sortedSongs();
    if (!shuffle) return all;
    const rest = all.filter((k) => k !== i);
    for (let k = rest.length - 1; k > 0; k--) {
      const j = Math.floor(Math.random() * (k + 1));
      [rest[k], rest[j]] = [rest[j], rest[k]];
    }
    return i >= 0 ? [i, ...rest] : rest;
  }

  /** The song after the playing one (ready ones only); -1 at the end when nothing repeats. */
  function nextSong() {
    const at = order.indexOf(current);
    for (let k = at + 1; k < order.length; k++) if (songs[order[k]].ready) return order[k];
    if (repeat === "off") return -1;
    for (const k of order) if (songs[k].ready) return k;
    return -1;
  }
  function prevSong() {
    const at = order.indexOf(current);
    for (let k = at - 1; k >= 0; k--) if (songs[order[k]].ready) return order[k];
    if (repeat !== "all") return -1;
    for (let k = order.length - 1; k > at; k--) if (songs[order[k]].ready) return order[k];
    return -1;
  }

  /** ⏭ / the end of a song (`auto`): "repeat one" plays it again; at the end of a round, a fresh shuffle. */
  function playNext(auto = false) {
    if (current < 0) return;
    if (auto && repeat === "one") {
      player.currentTime = 0;
      return void player.play().catch(() => {});
    }
    // in the list's order, the next song still being uploaded plays as soon as it is there (no jump past it)
    const at = order.indexOf(current);
    if (auto && !shuffle && order[at + 1] !== undefined && !songs[order[at + 1]].ready) {
      waiting = order[at + 1];
      return renderPlayer();
    }
    let next = nextSong();
    if (next >= 0 && order.indexOf(next) <= at && shuffle) {
      order = orderFrom(-1); // a fresh shuffle for the next round
      next = order.find((k) => songs[k].ready) ?? -1;
    }
    if (next >= 0) play(next, 0, { reveal: true });
    else if (auto) bridgeOn(false);
  }

  /** ⏮: back to the start of the song after 3 s, else the song before. */
  function playPrev() {
    if (current < 0) return;
    const prev = prevSong();
    if (player.currentTime > 3 || prev < 0) {
      player.currentTime = 0;
      return void player.play().catch(() => {});
    }
    play(prev, 0, { reveal: true });
  }

  // ---------- the songs' URLs, and the next songs fetched whole (like the main page's prefetch) ----------

  const PIECE = 3 * 1024 * 1024; // core.js SHARE_CHUNK: one request per piece stored in R2
  const AHEAD = 2; // songs fetched ahead of the one playing
  const KEEP = 4; // whole songs kept in this page (the playing one, the next ones, the one before)
  const PARALLEL = 3; // pieces of a song fetched at a time
  const wholes = new Map(); // song id -> { url (blob:), job, ctl } (ids, not places: the owner may sync the list)

  /** Remember a song's signed URL (from the list or share-play), with when it was given. */
  function setUrl(i, url) {
    if (!songs[i] || !url) return;
    songs[i].url = url;
    songs[i].urlAt = Date.now();
  }
  /** A signed URL for song i still good for a minute at least (asked again otherwise, or when `force`). */
  async function songUrl(i, force = false) {
    const s = songs[i];
    if (!force && s.url && Date.now() - s.urlAt < (urlTtl - 60) * 1000) return s.url;
    const { url, expiresIn } = await get("share-play", { code, i });
    urlTtl = expiresIn || urlTtl;
    setUrl(i, url);
    return url;
  }

  /** Song i fetched whole into this page (a blob: URL), its pieces 3 at a time; resolves when there. */
  function fetchWhole(i) {
    const s = songs[i];
    if (wholes.has(s?.id)) return wholes.get(s.id).job;
    if (!s?.ready || !s.size) return Promise.resolve();
    const w = { url: null, ctl: new AbortController() };
    const piece = async (k, url) => {
      const from = k * PIECE;
      const to = Math.min(s.size, from + PIECE) - 1;
      let res = await fetch(url, { headers: { Range: `bytes=${from}-${to}` }, signal: w.ctl.signal });
      if (res.status === 403)
        res = await fetch(await songUrl(i, true), { headers: { Range: `bytes=${from}-${to}` }, signal: w.ctl.signal });
      if (!res.ok) throw new Error(`piece ${k}: ${res.status}`);
      return res;
    };
    w.job = (async () => {
      const url = await songUrl(i);
      const n = Math.ceil(s.size / PIECE);
      const parts = new Array(n);
      let type = "";
      let next = 0;
      const worker = async () => {
        while (next < n) {
          const k = next++;
          const res = await piece(k, url);
          type ||= res.headers.get("Content-Type") || "";
          parts[k] = await res.blob();
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL, n) }, worker));
      w.url = URL.createObjectURL(new Blob(parts, { type }));
    })().catch(() => wholes.get(s.id) === w && wholes.delete(s.id)); // streamed when it plays; asked next time
    wholes.set(s.id, w);
    return w.job;
  }

  /** The songs after the playing one, in the play order (none with "repeat one"). */
  function aheadOf(i) {
    if (repeat === "one") return [];
    const at = order.indexOf(i);
    const list = [...order.slice(at + 1), ...(repeat === "all" ? order.slice(0, at) : [])];
    return list.filter((k) => songs[k].ready).slice(0, AHEAD);
  }

  /** Only what is wanted now is fetched and kept: the playing song, the next ones (others stop / go). */
  function keepWholes(i) {
    const wanted = new Set([i, ...aheadOf(i)].map((k) => songs[k]?.id));
    const playing = songs[current]?.id;
    const kept = [...wholes.keys()].filter((k) => wanted.has(k) || wholes.get(k).url);
    for (const [k, w] of wholes) {
      if (wanted.has(k)) continue;
      if (!w.url) {
        w.ctl.abort();
        wholes.delete(k);
      } else if (kept.length > KEEP && k !== playing) {
        URL.revokeObjectURL(w.url);
        wholes.delete(k);
        kept.splice(kept.indexOf(k), 1);
      }
    }
  }

  let prefetchFor = -1;
  /** While a song plays: the next ones fetched whole, one after the other. */
  async function prefetch() {
    if (prefetchFor === current) return; // once per song ("playing" also fires after every buffering pause)
    const i = (prefetchFor = current);
    keepWholes(i);
    for (const k of aheadOf(i)) {
      if (prefetchFor !== i) return;
      await fetchWhole(k);
    }
  }

  // ---------- the service worker (web/sw.js): the whole range Safari asks for, from the function's pieces ----------
  // Without it Safari stopped every song at its first 3 MB piece. Waited for (3 s at most) before a song plays.
  const swReady = (async () => {
    if (!("serviceWorker" in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      if (navigator.serviceWorker.controller) return;
      // a hard reload leaves the page uncontrolled: the worker takes it over
      (reg.active || (await navigator.serviceWorker.ready).active)?.postMessage({ type: "claim" });
      await Promise.race([
        new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r, { once: true })),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
    } catch {
      // no worker (private mode…): played straight from the function
    }
  })();

  // ---------- the player (the dock of the main page) ----------

  function renderPlayer() {
    const s = songs[current];
    show($("playerBar"), !!s && !goneShown); // the link gone: no player any more
    if (!s) return;
    $("npTitle").textContent = s.title;
    $("npSub").textContent = s.performer || "";
    const playing = !player.paused;
    $("playBtn").innerHTML = `<i class="bi ${playing ? "bi-pause-fill" : "bi-play-fill"}"></i>`;
    $("prevBtn").disabled = false; // ⏮ always goes back to the song's start
    $("nextBtn").disabled = nextSong() < 0;
  }

  // 1st press repeats the song that is playing, 2nd the whole list (like the main page)
  const REPEAT_NEXT = { off: "one", one: "all", all: "off" };
  const REPEAT_TITLE = { off: "Lặp lại: tắt", one: "Lặp lại bài này", all: "Lặp lại cả danh sách" };
  function renderModes() {
    const sh = $("shuffleBtn");
    sh.classList.toggle("on", shuffle);
    sh.setAttribute("aria-pressed", String(shuffle));
    sh.title = shuffle ? t("Phát ngẫu nhiên: bật") : t("Phát ngẫu nhiên: tắt");
    const rp = $("repeatBtn");
    rp.classList.toggle("on", repeat !== "off");
    rp.setAttribute("aria-pressed", String(repeat !== "off"));
    rp.title = t(REPEAT_TITLE[repeat]);
    rp.innerHTML = `<i class="bi ${repeat === "one" ? "bi-repeat-1" : "bi-repeat"}"></i>`;
    store("playModes", JSON.stringify({ shuffle, repeat })); // the main page's key: one choice everywhere
    if (current >= 0) renderPlayer();
  }

  function renderVolume() {
    const muted = player.muted || player.volume === 0;
    const icon = muted ? "bi-volume-mute-fill" : player.volume < 0.5 ? "bi-volume-down-fill" : "bi-volume-up-fill";
    $("muteBtn").innerHTML = `<i class="bi ${icon}"></i>`;
    $("volRange").value = player.muted ? 0 : player.volume;
  }

  /** The seek bar like the main page's: played in colour, loaded lighter (styles.css --played / --loaded). */
  function paintSeek() {
    const dur = duration();
    let loaded = 0;
    for (let i = 0; dur && i < player.buffered.length; i++)
      if (player.buffered.start(i) <= player.currentTime + 1 && player.buffered.end(i) > loaded)
        loaded = player.buffered.end(i);
    $("seekRange").style.setProperty("--played", `${$("seekRange").value / 10}%`);
    $("seekRange").style.setProperty("--loaded", `${dur ? Math.min(100, (loaded / dur) * 100) : 0}%`);
  }

  function renderTime() {
    if (player.readyState === 0) return; // a new song loading: showStart drew it
    const dur = duration();
    if (!seeking) {
      $("curTime").textContent = time(player.currentTime);
      $("seekRange").value = dur ? Math.round((player.currentTime / dur) * 1000) : 0;
    }
    $("durTime").textContent = time(dur);
    paintSeek();
  }

  /** The seek bar and times of song i at `at` s, at once (the player still holds the song before until it loads). */
  function showStart(i, at = 0) {
    const dur = songs[i]?.duration || 0;
    seeking = false;
    $("curTime").textContent = time(at);
    $("durTime").textContent = time(dur);
    $("seekRange").value = dur ? Math.round((at / dur) * 1000) : 0;
    $("seekRange").style.setProperty("--played", `${$("seekRange").value / 10}%`);
    $("seekRange").style.setProperty("--loaded", "0%");
  }

  /** Song i from `at` seconds: a fresh signed URL each time. `paused`: only loaded (a reload restoring it). */
  async function play(i, at = 0, { reveal = false, paused = false } = {}) {
    if (!songs[i]?.ready) return;
    waiting = null;
    const changed = i !== current;
    current = i;
    if (changed) retried = false;
    if (!order.includes(i)) order = orderFrom(i);
    renderList();
    renderPlayer();
    showStart(i, at);
    mediaSession(); // the lock screen shows the new song at once
    if (reveal) requestAnimationFrame(revealPlaying);
    keepWholes(i);
    try {
      // fetched ahead: from this page, at once; else streamed piece by piece
      const url = wholes.get(songs[i].id)?.url || (await songUrl(i, retried));
      if (!wholes.get(songs[i].id)?.url) await swReady;
      if (current !== i) return; // another song was chosen meanwhile
      player.src = url;
      if (at) player.currentTime = at;
      showStart(i, at);
      if (!paused) await player.play().catch(() => {}); // blocked autoplay: the play button is there
    } catch (err) {
      if (isGone(err)) return gone(err);
      if (err.code === "SHARE_PENDING") songs[i].ready = false;
      $("npSub").textContent = err.message;
      bridgeOn(false);
    }
    mediaSession();
  }

  function togglePlay() {
    if (current < 0) return startList();
    if (!player.getAttribute("src")) return play(current);
    player.paused ? player.play().catch(() => {}) : player.pause();
  }
  function seek(delta) {
    if (!player.getAttribute("src")) return;
    const end = Number.isFinite(player.duration) ? player.duration : Infinity;
    player.currentTime = Math.min(Math.max(0, player.currentTime + delta), end);
  }
  /** ▶ Phát tất cả: from the first song (shuffle on: a random one). */
  function startList() {
    order = orderFrom(-1);
    const first = order.find((k) => songs[k].ready);
    if (first !== undefined) play(first, 0, { reveal: true });
  }

  // Lock screen / headphones / notification: title, playlist, ⏮ ⏭ ±10 s — as the main page does (ui.js): the bar
  // there is the <audio> element's own (where it is, how long), never told by the page. Telling it (setPositionState,
  // playbackState) made iPhones keep what was told: the bar stood still until the next pause / play.
  function mediaSession() {
    const s = songs[current];
    if (!("mediaSession" in navigator) || !s) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: s.title,
        artist: s.performer || $("chatTitle").textContent,
        album: "DLiMusic",
        // square and opaque: the lock screen shows transparent corners as white
        artwork: [{ src: "/img/artwork-512.jpg", sizes: "512x512", type: "image/jpeg" }],
      });
    } catch {
      // MediaMetadata not supported
    }
  }
  if ("mediaSession" in navigator) {
    const handlers = {
      previoustrack: () => playPrev(),
      nexttrack: () => playNext(),
      seekbackward: () => seek(-10),
      seekforward: () => seek(10),
    };
    for (const [action, fn] of Object.entries(handlers)) {
      try {
        navigator.mediaSession.setActionHandler(action, fn);
      } catch {
        // not every browser knows every action
      }
    }
  }

  // ---------- playback speed (the main page's, kept between visits) ----------

  const SPEEDS = [
    [0.5, "Chậm"],
    [1, "Bình thường"],
    [1.2, "Hơi nhanh"],
    [1.5, "Nhanh"],
    [1.7, "Rất nhanh"],
    [2, "Siêu nhanh"],
  ];
  function setSpeed(rate, save = true) {
    rate = Math.min(2, Math.max(0.5, Math.round(Number(rate) * 10) / 10 || 1));
    player.defaultPlaybackRate = rate; // also for the next songs
    $("emptyCatDance").style.setProperty("--cat-rate", rate); // the dancing kittens keep pace
    player.playbackRate = rate;
    $("speedBtn").textContent = `${rate}x`;
    $("speedBtn").classList.toggle("on", rate !== 1);
    $("speedVal").textContent = `${rate.toFixed(1)}x`;
    $("speedRange").value = rate;
    $("speedList").innerHTML = SPEEDS.map(
      ([r, label]) =>
        `<button type="button" class="dropdown-item d-flex align-items-center gap-3${r === rate ? " active" : ""}" data-speed="${r}">
        <small class="speed-tag">${r}x</small><span class="flex-grow-1">${t(label)}</span>${r === rate ? '<i class="bi bi-check2"></i>' : ""}</button>`,
    ).join("");
    if (save) store("speed", String(rate));
  }
  $("speedRange").addEventListener("input", (e) => setSpeed(e.target.value));
  $("speedList").addEventListener("click", (e) => {
    const b = e.target.closest("[data-speed]");
    if (!b) return;
    setSpeed(b.dataset.speed);
    bootstrap.Dropdown.getOrCreateInstance($("speedBtn")).hide();
  });
  player.addEventListener("loadedmetadata", () => (player.playbackRate = player.defaultPlaybackRate));
  setSpeed(Number(load("speed")) || 1, false);

  // ---------- sleep timer: pause after some minutes (across songs), or when the playing song ends ----------

  const SLEEP_MINUTES = [10, 15, 20, 30, 45, 60];
  const SLEEP_FADE = 10_000; // the volume goes down over the last 10 seconds, then the song pauses
  const sleep = { mode: "off", minutes: 0, endsAt: 0, timer: null, fadeFrom: null };

  function songLeft() {
    if (!player.getAttribute("src") || !Number.isFinite(player.duration)) return null;
    return Math.max(0, (player.duration - player.currentTime) / (player.playbackRate || 1));
  }
  function sleepLeft() {
    if (sleep.mode === "min") return Math.max(0, sleep.endsAt - Date.now());
    if (sleep.mode === "end") {
      const s = songLeft();
      return s === null ? null : s * 1000;
    }
    return null;
  }
  function renderSleep() {
    const left = sleepLeft();
    const on = sleep.mode !== "off";
    $("sleepBtn").classList.toggle("on", on);
    show($("sleepLeft"), on && left !== null);
    if (on && left !== null) $("sleepLeft").textContent = time(Math.ceil(left / 1000));
  }
  const sleepKey = () => (sleep.mode === "min" ? String(sleep.minutes) : sleep.mode);
  function renderSleepList() {
    const item = (key, label, sub = "") =>
      `<button type="button" class="dropdown-item d-flex align-items-center gap-2${sleepKey() === key ? " active" : ""}" data-sleep="${key}">
        <span class="flex-grow-1">${label}${sub ? `<small class="d-block sleep-sub">${sub}</small>` : ""}</span>${sleepKey() === key ? '<i class="bi bi-check2"></i>' : ""}</button>`;
    const s = songLeft();
    $("sleepList").innerHTML = [
      item("off", t("Tắt")),
      ...SLEEP_MINUTES.map((n) => item(String(n), t("{n} phút", { n }))),
      item("end", t("Hết bài này"), s !== null ? time(Math.ceil(s)) : ""),
    ].join("");
  }
  function endFade() {
    if (sleep.fadeFrom !== null) player.volume = sleep.fadeFrom;
    sleep.fadeFrom = null;
  }
  function setSleep(mode, minutes = 0) {
    clearInterval(sleep.timer);
    endFade();
    Object.assign(sleep, { mode, minutes, endsAt: mode === "min" ? Date.now() + minutes * 60_000 : 0, timer: null });
    if (mode !== "off") sleep.timer = setInterval(sleepTick, 1000);
    renderSleep();
  }
  function sleepTick() {
    if (sleep.mode === "off") return;
    const left = sleepLeft();
    renderSleep();
    if (left === null) return;
    if (sleep.mode === "min" && left <= 0) return sleepStop();
    if (left <= SLEEP_FADE && !player.paused) {
      sleep.fadeFrom ??= player.volume;
      player.volume = sleep.fadeFrom * Math.max(0, left / SLEEP_FADE);
    } else if (left > SLEEP_FADE) endFade(); // sought back out of the last seconds
  }
  function sleepStop() {
    const playing = !player.paused;
    player.pause();
    setSleep("off");
    if (playing) toast(t("Hết giờ hẹn, nhạc đã tạm dừng"), "info");
  }
  $("sleepBtn").parentElement.addEventListener("show.bs.dropdown", renderSleepList);
  $("sleepList").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sleep]");
    if (!b) return;
    bootstrap.Dropdown.getOrCreateInstance($("sleepBtn")).hide();
    const key = b.dataset.sleep;
    if (key === "off") {
      setSleep("off");
      return toast(t("Hẹn giờ ngủ: tắt"), "info");
    }
    if (key === "end") {
      setSleep("end");
      return toast(t("Nhạc sẽ dừng khi hết bài này"), "info");
    }
    setSleep("min", Number(key));
    toast(t("Nhạc sẽ dừng sau {n} phút", { n: Number(key) }), "info");
  });
  player.addEventListener("timeupdate", sleepTick);
  renderSleep();

  // ---------- the bridge between two songs (screen locked), like the main page ----------
  // While the next song's URL is asked for, nothing plays, and a locked phone puts a silent page to sleep. A second
  // player playing silence in a loop covers that moment. It may start a sound only after a tap: readied on the first.
  const bridge = new Audio("/sounds/silence.wav");
  bridge.loop = true;
  bridge.preload = "auto";
  bridge.setAttribute("playsinline", "");
  let bridgeReady = false;
  let bridgeTimer = 0;
  function readyBridge() {
    if (bridgeReady) return;
    bridgeReady = true;
    bridge.muted = true;
    bridge
      .play()
      .then(() => {
        bridge.pause();
        bridge.muted = false;
      })
      .catch(() => (bridgeReady = false)); // tried again on the next tap
  }
  for (const evt of ["pointerdown", "keydown"]) document.addEventListener(evt, readyBridge, { capture: true });
  function bridgeOn(on) {
    clearTimeout(bridgeTimer);
    if (!on) return void (bridge.paused || bridge.pause());
    if (!bridgeReady) return;
    bridge.currentTime = 0;
    bridge.play().catch(() => {});
    bridgeTimer = setTimeout(() => bridgeOn(false), 120_000); // a song that never starts: not silence for ever
  }
  player.addEventListener("playing", () => bridgeOn(false));
  player.addEventListener("playing", () => prefetch());
  player.addEventListener("pause", () => bridgeOn(false));

  // ---------- the start screen (the main page's): the logo shows it, the music plays on ----------
  // The cat with headphones, the dancing kittens while music plays (their speed follows the playback speed).

  const HOME_CAT = { dance: "/img/cat-dance-grid.webp" };
  let danceReady = null; // resolves once the dancing kittens are downloaded and decoded
  let catDances = false; // what the cat should show now (the last play / pause wins)
  /** Fetch the kittens ahead (a song is loaded in the player), so ▶ swaps the picture at once. */
  function loadDanceCat() {
    if (!danceReady) {
      const img = new Image();
      img.src = HOME_CAT.dance;
      danceReady = img.decode().catch(() => {});
    }
    return danceReady;
  }
  function setHomeCat(playing) {
    catDances = playing && !matchMedia("(prefers-reduced-motion: reduce)").matches;
    // swapped once the kittens are ready (no still frame sliding about meanwhile)
    if (catDances) loadDanceCat().then(() => catDances && showHomeCat(true));
    else showHomeCat(false);
  }
  function showHomeCat(dance) {
    show($("emptyCat"), !dance);
    show($("emptyCatDance"), dance);
  }
  player.addEventListener("loadstart", loadDanceCat);

  /** The start screen (true) or the list of songs; `push`: a step the browser's ← goes back from. */
  function setHome(on, push = true) {
    const home = !$("emptyView").classList.contains("d-none");
    if (home === on) return;
    $("emptyView").classList.toggle("d-none", !on);
    $("emptyView").classList.toggle("d-flex", on);
    show($("listView"), !on);
    if (on && push) history.pushState({ view: "home" }, "");
    else if (!on && push && history.state?.view === "home") history.back(); // ← from here: the list
  }
  $("homeLink").addEventListener("click", (e) => {
    if (goneShown) return; // the link is gone: the logo opens DLiMusic
    e.preventDefault();
    setHome(true);
  });
  $("catBack").addEventListener("click", () => setHome(false));
  $("catBack").addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && setHome(false));
  window.addEventListener("popstate", () => setHome(history.state?.view === "home", false));
  /** The song's name in the player: its list, the row brought into view (like the main page). */
  function showPlayingList() {
    setHome(false);
    requestAnimationFrame(revealPlaying);
  }

  // ---------- a reload goes on where it was (this browser only, for a day) ----------

  let playbackSaved = 0;
  function savePlayback(force = false) {
    if (current < 0 || (!force && Date.now() - playbackSaved < 2000)) return;
    playbackSaved = Date.now();
    store(
      PLAYBACK_KEY,
      JSON.stringify({ code, id: songs[current]?.id, time: player.currentTime || 0, at: Date.now() }),
    );
  }
  player.addEventListener("timeupdate", () => savePlayback());
  for (const evt of ["play", "pause"]) player.addEventListener(evt, () => savePlayback(true));
  window.addEventListener("pagehide", () => savePlayback(true));
  function restorePlayback() {
    let saved = null;
    try {
      saved = JSON.parse(load(PLAYBACK_KEY) || "null");
    } catch {
      // not ours
    }
    const i = songs.findIndex((s) => s.id === saved?.id);
    if (!saved || saved.code !== code || Date.now() - saved.at > 24 * 3600_000 || !songs[i]?.ready) return;
    play(i, saved.time, { reveal: true, paused: true }); // ▶ goes on from there (no sound without a tap)
  }

  // ---------- events ----------

  for (const evt of ["play", "pause", "ended"])
    player.addEventListener(evt, () => {
      renderList();
      renderPlayer();
      setHomeCat(evt === "play");
    });
  player.addEventListener("timeupdate", renderTime);
  player.addEventListener("durationchange", renderTime);
  player.addEventListener("seeked", renderTime);
  player.addEventListener("progress", paintSeek);
  player.addEventListener("volumechange", renderVolume);
  player.addEventListener("playing", () => (retried = false));
  player.addEventListener("ended", () => {
    // sleep timer "Hết bài này": stop here, not even "repeat one" plays it again
    if (sleep.mode === "end") {
      setSleep("off");
      return toast(t("Hết giờ hẹn, nhạc đã tạm dừng"), "info");
    }
    bridgeOn(true);
    playNext(true);
  });
  player.addEventListener("error", () => {
    if (current < 0 || !player.getAttribute("src")) return;
    // most likely the signed URL expired: a new one, from the same place
    if (!retried) {
      retried = true;
      return void play(current, player.currentTime || 0, { paused: player.paused && player.currentTime > 0 });
    }
    toast(t("Không phát được bài này"), "error");
    const next = nextSong();
    if (next >= 0 && next !== current) setTimeout(() => play(next, 0, { reveal: true }), 1500);
  });

  // a row (or its ▶): play it; the one playing: pause / go on
  $("files").addEventListener("click", (e) => {
    const row = e.target.closest("tr[data-i]");
    if (!row || row.classList.contains("pending")) return;
    const i = Number(row.dataset.i);
    if (i === current && player.getAttribute("src")) return void togglePlay();
    order = orderFrom(i);
    play(i);
  });
  $("plPlayBtn").addEventListener("click", startList);
  $("fileSearch").addEventListener("input", (e) => {
    query = e.target.value;
    renderList();
  });
  $("sortSel").addEventListener("change", (e) => setSort(e.target.value));
  document.querySelector(".file-table thead").addEventListener("click", (e) => {
    const th = e.target.closest("th.sortable");
    if (!th) return;
    const cycle = HEADER_SORTS[th.dataset.sort];
    setSort(cycle[(cycle.indexOf(sort) + 1) % cycle.length]);
  });
  $("playBtn").addEventListener("click", togglePlay);
  $("prevBtn").addEventListener("click", playPrev);
  $("nextBtn").addEventListener("click", () => playNext());
  $("backBtn").addEventListener("click", () => seek(-10));
  $("fwdBtn").addEventListener("click", () => seek(10));
  $("shuffleBtn").addEventListener("click", () => {
    shuffle = !shuffle;
    if (current >= 0) order = orderFrom(current); // the playing song stays, the rest re-orders
    renderModes();
    toast(shuffle ? t("Phát ngẫu nhiên: bật") : t("Phát ngẫu nhiên: tắt"), "info");
  });
  $("repeatBtn").addEventListener("click", () => {
    repeat = REPEAT_NEXT[repeat];
    renderModes();
    toast(t(REPEAT_TITLE[repeat]), "info");
  });
  $("npTitle").addEventListener("click", showPlayingList);
  $("npTitle").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    showPlayingList();
  });

  // seek bar: dragging previews the time, letting go jumps; pointing shows the time there (like the main page)
  function pointSeek(x) {
    const wrap = $("seekWrap");
    const bar = $("seekRange");
    const dur = duration();
    const r = bar.getBoundingClientRect();
    if (!dur || !r.width) return unpointSeek();
    const f = Math.min(1, Math.max(0, (x - r.left) / r.width));
    const tip = $("seekTip");
    tip.textContent = time(f * dur);
    const half = tip.offsetWidth / 2;
    const at = Math.min(r.width - half, Math.max(half, f * r.width)) + (r.left - wrap.getBoundingClientRect().left);
    wrap.style.setProperty("--tip-x", `${at}px`);
    bar.style.setProperty("--hover", `${f * 100}%`);
    wrap.classList.add("pointing");
  }
  function unpointSeek() {
    $("seekWrap").classList.remove("pointing");
    $("seekRange").style.setProperty("--hover", "0%");
  }
  $("seekRange").addEventListener("input", () => {
    seeking = true;
    $("curTime").textContent = time((Number($("seekRange").value) / 1000) * duration());
    paintSeek();
  });
  $("seekRange").addEventListener("change", () => {
    if (Number.isFinite(player.duration)) player.currentTime = (Number($("seekRange").value) / 1000) * player.duration;
    seeking = false;
    if (!$("seekRange").matches(":hover")) unpointSeek();
  });
  $("seekRange").addEventListener("pointermove", (e) => pointSeek(e.clientX));
  $("seekRange").addEventListener("pointerdown", (e) => pointSeek(e.clientX));
  $("seekRange").addEventListener("pointerleave", () => !seeking && unpointSeek());
  $("seekRange").addEventListener("pointerup", (e) => e.pointerType !== "mouse" && unpointSeek());
  $("seekRange").addEventListener("pointercancel", unpointSeek);

  // volume, remembered in this browser
  $("volRange").addEventListener("input", (e) => {
    player.volume = Number(e.target.value);
    player.muted = false;
    store(VOLUME_KEY, String(player.volume));
  });
  $("muteBtn").addEventListener("click", () => (player.muted = !player.muted));
  const savedVolume = load(VOLUME_KEY);
  if (savedVolume !== null && Number(savedVolume) >= 0 && Number(savedVolume) <= 1) player.volume = Number(savedVolume);

  // keys like the main page: Space play / pause, ← / → 10 s, Shift + ← / → the song before / after
  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea, select") || document.querySelector(".dropdown-menu.show")) return;
    if (e.altKey || e.ctrlKey || e.metaKey || current < 0) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      e.shiftKey ? playPrev() : seek(-10);
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      e.shiftKey ? playNext() : seek(10);
    }
    if (e.key === " " && !e.target.closest("button")) {
      e.preventDefault();
      togglePlay();
    }
  });

  // shuffle / repeat as chosen last (here or on the main page)
  try {
    const saved = JSON.parse(load("playModes") || "{}");
    shuffle = saved.shuffle === true;
    if (saved.repeat in REPEAT_NEXT) repeat = saved.repeat;
  } catch {
    // nothing saved
  }
  renderModes();
  renderVolume();

  // ---------- open the link, then follow the upload ----------

  /**
   * The list read again: the songs uploaded since are playable (the one waited for starts); a list the owner synced
   * (songs added, taken out, moved) replaces this one, the song playing goes on (or stops, taken out).
   */
  async function poll() {
    if (goneShown) return;
    try {
      const data = await get("share-open", { code });
      const same = data.songs.length === songs.length && data.songs.every((x, i) => x.id === songs[i].id);
      if (same)
        data.songs.forEach((x, i) => {
          songs[i].ready = x.ready;
          songs[i].size = x.size;
          if (x.url) setUrl(i, x.url);
        });
      else relist(data.songs);
    } catch (err) {
      if (isGone(err)) return gone(err);
    }
    renderInfo();
    renderList();
    if (current >= 0) renderPlayer();
    if (waiting !== null && songs[waiting]?.ready) play(waiting, 0, { reveal: true });
    if (Date.now() < expiresAt) setTimeout(poll, songs.some((x) => !x.ready) ? POLL_MS : POLL_IDLE_MS);
  }

  /** A new list (the owner synced): places found again by the songs' ids. */
  function relist(list) {
    const playingId = songs[current]?.id;
    const waitingId = waiting !== null ? songs[waiting]?.id : undefined;
    songs = list;
    songs.forEach((x, i) => x.url && setUrl(i, x.url));
    current = songs.findIndex((x) => x.id === playingId);
    if (playingId !== undefined && current < 0) {
      // the song playing was taken out of the playlist (and its file with it)
      player.pause();
      player.removeAttribute("src");
      show($("playerBar"), false);
      toast(t("Bài đang phát đã được gỡ khỏi playlist"), "info");
    }
    const w = songs.findIndex((x) => x.id === waitingId);
    waiting = w >= 0 ? w : null;
    order = orderFrom(current);
    for (const id of [...wholes.keys()])
      if (!songs.some((x) => x.id === id)) {
        const old = wholes.get(id);
        old.ctl.abort();
        if (old.url) URL.revokeObjectURL(old.url);
        wholes.delete(id);
      }
  }

  async function start() {
    if (!/^[\w-]{16}$/.test(code)) return (gone(), splash.finish());
    let data;
    try {
      data = await get("share-open", { code });
    } catch (err) {
      return (gone(err), splash.finish());
    }
    splash.finish();
    songs = data.songs;
    urlTtl = data.expiresIn || urlTtl;
    songs.forEach((s, i) => s.url && setUrl(i, s.url));
    order = orderFrom(-1);
    expiresAt = data.expiresAt;
    document.title = `${data.name} · DLiMusic`;
    $("chatTitle").textContent = data.name;
    until = dateText(data.expiresAt);
    renderInfo();
    setSort("default");
    restorePlayback();
    setTimeout(poll, songs.some((x) => !x.ready) ? POLL_MS : POLL_IDLE_MS);
    watchExpiry();
  }

  /** The moment the link expires (while listening): asked again then, and the page says so. */
  function watchExpiry() {
    const left = expiresAt - Date.now() + 1000;
    // a timer waits 24.8 days at most: a 30-day link is looked at again on the way
    setTimeout(
      async () => {
        if (goneShown) return;
        if (Date.now() < expiresAt) return watchExpiry();
        try {
          expiresAt = (await get("share-open", { code })).expiresAt; // not yet (the clocks differ a little)
          setTimeout(watchExpiry, 5000);
        } catch (err) {
          if (isGone(err)) gone(err);
          else setTimeout(watchExpiry, 60_000);
        }
      },
      Math.max(1000, Math.min(left, 2 ** 31 - 1)),
    );
  }

  start();
})();
