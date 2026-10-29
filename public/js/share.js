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
  const PLAYBACK_KEY = "tdl.sharePlayback"; // { code, i, time, at }: a reload goes on where it was
  const POLL_MS = 15_000;

  const player = new Audio();
  player.preload = "auto";
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
    if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, code: data.code });
    return data;
  }

  function gone(message) {
    show($("shLoading"), false);
    show($("shList"), false);
    show($("playerBar"), false);
    show($("shGone"), true);
    if (message) $("shGoneText").textContent = message;
    player.pause();
    player.removeAttribute("src");
    store(PLAYBACK_KEY, null);
  }

  // ---------- the list ----------

  function renderList() {
    $("shSongs").innerHTML = songs
      .map(
        (
          s,
          i,
        ) => `<button class="sh-song${i === current ? " playing" : ""}${s.ready ? "" : " pending"}" type="button" data-i="${i}"${s.ready ? "" : " disabled"}>
          <span class="num">${i === current && !player.paused ? '<i class="bi bi-volume-up-fill"></i>' : i + 1}</span>
          <span class="meta"><span class="title">${esc(s.title)}</span>${s.performer ? `<span class="artist">${esc(s.performer)}</span>` : ""}</span>
          <span class="dur">${s.ready ? (s.duration ? time(s.duration) : "") : esc(t("Đang tải lên…"))}</span></button>`,
      )
      .join("");
  }

  function renderInfo() {
    const ready = songs.filter((s) => s.ready).length;
    $("shInfo").textContent =
      ready < songs.length
        ? t("{ready}/{n} bài đã sẵn sàng, các bài khác đang được tải lên · hết hạn {date}", {
            ready,
            n: songs.length,
            date: until,
          })
        : t("{n} bài · hết hạn {date}", { n: songs.length, date: until });
    $("shPlayAll").disabled = !ready;
  }

  /** The playing song's row brought into view (when it is off screen). */
  function revealPlaying() {
    const row = $("shSongs").querySelector(`[data-i="${current}"]`);
    if (!row) return;
    const box = document.querySelector(".sh-scroll").getBoundingClientRect();
    const r = row.getBoundingClientRect();
    if (r.top < box.top || r.bottom > box.bottom) row.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  // ---------- the order: shuffle / repeat (like ui.js orderFrom / playNext / playPrev) ----------

  /** The list's order, or (shuffle) the song `i` first and the others shuffled. */
  function orderFrom(i) {
    const all = songs.map((_, k) => k);
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
  const wholes = new Map(); // song index -> { url (blob:), job, ctl }

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
    if (wholes.has(i)) return wholes.get(i).job;
    const s = songs[i];
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
    })().catch(() => wholes.get(i) === w && wholes.delete(i)); // streamed when it plays; asked again next time
    wholes.set(i, w);
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
    const wanted = new Set([i, ...aheadOf(i)]);
    const kept = [...wholes.keys()].filter((k) => wanted.has(k) || wholes.get(k).url);
    for (const [k, w] of wholes) {
      if (wanted.has(k)) continue;
      if (!w.url) {
        w.ctl.abort();
        wholes.delete(k);
      } else if (kept.length > KEEP && k !== current) {
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

  // ---------- the player (the dock of the main page) ----------

  function renderPlayer() {
    const s = songs[current];
    show($("playerBar"), !!s);
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
    const dur = duration();
    if (!seeking) {
      $("curTime").textContent = time(player.currentTime);
      $("seekRange").value = dur ? Math.round((player.currentTime / dur) * 1000) : 0;
    }
    $("durTime").textContent = time(dur);
    paintSeek();
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
    renderTime();
    if (reveal) requestAnimationFrame(revealPlaying);
    keepWholes(i);
    try {
      // fetched ahead: from this page, at once; else streamed piece by piece
      const url = wholes.get(i)?.url || (await songUrl(i, retried));
      if (current !== i) return; // another song was chosen meanwhile
      player.src = url;
      if (at) player.currentTime = at;
      if (!paused) await player.play().catch(() => {}); // blocked autoplay: the play button is there
    } catch (err) {
      if (err.code === "SHARE_GONE") return gone(err.message);
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

  // Lock screen / headphones / notification: title, playlist, ⏮ ⏭ ±10 s.
  function mediaSession() {
    const s = songs[current];
    if (!("mediaSession" in navigator) || !s) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: s.title,
        artist: s.performer || $("shName").textContent,
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
      play: () => player.play().catch(() => {}),
      pause: () => player.pause(),
      previoustrack: () => playPrev(),
      nexttrack: () => playNext(),
      seekbackward: () => seek(-10),
      seekforward: () => seek(10),
      seekto: (d) => (player.currentTime = d.seekTime),
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
    player.playbackRate = rate;
    $("shCatDance").style.setProperty("--cat-rate", rate); // the dancing kittens keep pace
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

  // ---------- the cat: with headphones, dancing kittens while music plays ----------

  let danceReady = null;
  let catDances = false;
  function loadDanceCat() {
    if (!danceReady) {
      const img = new Image();
      img.src = "/img/cat-dance-grid.webp";
      danceReady = img.decode().catch(() => {});
    }
    return danceReady;
  }
  function setCat(playing) {
    catDances = playing && !matchMedia("(prefers-reduced-motion: reduce)").matches;
    const swap = (dance) => {
      show($("shCat"), !dance);
      show($("shCatDance"), dance);
    };
    if (catDances) loadDanceCat().then(() => catDances && swap(true));
    else swap(false);
  }
  player.addEventListener("loadstart", loadDanceCat);

  // ---------- a reload goes on where it was (this browser only, for a day) ----------

  let playbackSaved = 0;
  function savePlayback(force = false) {
    if (current < 0 || (!force && Date.now() - playbackSaved < 2000)) return;
    playbackSaved = Date.now();
    store(PLAYBACK_KEY, JSON.stringify({ code, i: current, time: player.currentTime || 0, at: Date.now() }));
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
    if (!saved || saved.code !== code || Date.now() - saved.at > 24 * 3600_000 || !songs[saved.i]?.ready) return;
    play(saved.i, saved.time, { reveal: true, paused: true }); // ▶ goes on from there (no sound without a tap)
  }

  // ---------- events ----------

  for (const evt of ["play", "pause", "ended"])
    player.addEventListener(evt, () => {
      renderList();
      renderPlayer();
      setCat(evt === "play");
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

  $("shSongs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-i]");
    if (!b) return;
    const i = Number(b.dataset.i);
    if (i === current && player.getAttribute("src")) return void togglePlay();
    order = orderFrom(i);
    play(i);
  });
  $("shPlayAll").addEventListener("click", startList);
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
  $("npTitle").addEventListener("click", revealPlaying);
  $("npTitle").addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && revealPlaying());

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

  /** The songs uploaded since: playable now (and the one waited for starts). */
  async function poll() {
    try {
      const data = await get("share-open", { code });
      data.songs.forEach((s, i) => {
        if (!songs[i]) return;
        songs[i].ready = s.ready;
        songs[i].size = s.size;
        if (s.url) setUrl(i, s.url);
      });
    } catch (err) {
      if (err.code === "SHARE_GONE") return gone(err.message);
    }
    renderInfo();
    renderList();
    if (current >= 0) renderPlayer();
    if (waiting !== null && songs[waiting]?.ready) play(waiting, 0, { reveal: true });
    if (songs.some((s) => !s.ready) && Date.now() < expiresAt) setTimeout(poll, POLL_MS);
  }

  async function start() {
    if (!/^[\w-]{16}$/.test(code)) return gone();
    let data;
    try {
      data = await get("share-open", { code });
    } catch (err) {
      return gone(err.status === 404 ? null : t("Không mở được playlist, hãy thử lại sau"));
    }
    songs = data.songs;
    urlTtl = data.expiresIn || urlTtl;
    songs.forEach((s, i) => s.url && setUrl(i, s.url));
    order = orderFrom(-1);
    expiresAt = data.expiresAt;
    document.title = `${data.name} · DLiMusic`;
    $("shName").textContent = data.name;
    until = new Date(data.expiresAt).toLocaleString(locale(), {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    renderInfo();
    show($("shLoading"), false);
    show($("shList"), true);
    renderList();
    restorePlayback();
    if (songs.some((s) => !s.ready)) setTimeout(poll, POLL_MS);
  }

  start();
})();
