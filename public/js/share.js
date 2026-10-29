// The page of a shared playlist (/s/<code>, public/share.html): listened to without signing in.
// The list comes from /api/cloud/share-open; each song plays from a signed URL that lives a few minutes
// (/api/cloud/share-play, see cloud/share.js). There is no download button and no lasting file link; when a
// URL has expired (paused for long, then sought) a new one is asked for and the song goes on where it was.
(() => {
  const $ = (id) => document.getElementById(id);
  const t = window.t || ((s) => s);
  const code =
    /^\/s\/([\w-]{16})\/?$/.exec(location.pathname)?.[1] || new URLSearchParams(location.search).get("code") || "";

  const audio = new Audio();
  audio.preload = "auto";
  let songs = [];
  let current = -1;
  let seeking = false;
  let retried = false; // one new URL per failure, so a broken file does not loop

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

  async function get(action, query) {
    const res = await fetch(`/api/cloud/${action}?${new URLSearchParams(query)}`, { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, code: data.code });
    return data;
  }

  function gone(message) {
    $("shLoading").classList.add("d-none");
    $("shList").classList.add("d-none");
    $("shPlayer").classList.add("d-none");
    $("shGone").classList.remove("d-none");
    if (message) $("shGoneText").textContent = message;
    audio.pause();
    audio.removeAttribute("src");
  }

  function renderList() {
    $("shSongs").innerHTML = songs
      .map(
        (s, i) => `<button class="sh-song${i === current ? " playing" : ""}" type="button" data-i="${i}">
          <span class="num">${i === current && !audio.paused ? '<i class="bi bi-volume-up-fill"></i>' : i + 1}</span>
          <span class="meta"><span class="title">${esc(s.title)}</span>${s.performer ? `<span class="artist">${esc(s.performer)}</span>` : ""}</span>
          <span class="dur">${s.duration ? time(s.duration) : ""}</span></button>`,
      )
      .join("");
  }

  function renderPlayer() {
    const s = songs[current];
    $("shPlayer").classList.toggle("d-none", !s);
    if (!s) return;
    $("shNowTitle").textContent = s.title;
    $("shNowArtist").textContent = s.performer || "";
    const playing = !audio.paused;
    $("shToggleIcon").className = `bi ${playing ? "bi-pause-fill" : "bi-play-fill"}`;
    $("shToggle").title = playing ? t("Tạm dừng") : t("Phát");
    $("shToggle").setAttribute("aria-label", $("shToggle").title);
    $("shPrev").disabled = current <= 0;
    $("shNext").disabled = current >= songs.length - 1;
  }

  function renderTime() {
    const dur = Number.isFinite(audio.duration) ? audio.duration : songs[current]?.duration || 0;
    $("shCur").textContent = time(audio.currentTime);
    $("shDur").textContent = time(dur);
    if (!seeking) $("shSeek").value = dur ? Math.round((audio.currentTime / dur) * 1000) : 0;
  }

  /** Song i from `at` seconds: a fresh signed URL each time. */
  async function play(i, at = 0) {
    if (!songs[i]) return;
    const changed = i !== current;
    current = i;
    if (changed) retried = false;
    renderList();
    renderPlayer();
    try {
      const { url } = await get("share-play", { code, i });
      if (current !== i) return; // another song was chosen meanwhile
      audio.src = url;
      if (at) audio.currentTime = at;
      await audio.play().catch(() => {}); // blocked autoplay: the play button is there
    } catch (err) {
      if (err.code === "SHARE_GONE") return gone(err.message);
      $("shNowArtist").textContent = err.message;
    }
    mediaSession();
  }

  function mediaSession() {
    const s = songs[current];
    if (!("mediaSession" in navigator) || !s) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: s.title,
      artist: s.performer || "",
      album: $("shName").textContent,
      artwork: [{ src: "/img/logo-192.png", sizes: "192x192", type: "image/png" }],
    });
  }
  if ("mediaSession" in navigator) {
    const actions = {
      play: () => audio.play(),
      pause: () => audio.pause(),
      previoustrack: () => current > 0 && play(current - 1),
      nexttrack: () => current < songs.length - 1 && play(current + 1),
      seekto: (d) => (audio.currentTime = d.seekTime),
    };
    for (const [name, fn] of Object.entries(actions)) {
      try {
        navigator.mediaSession.setActionHandler(name, fn);
      } catch {
        // not supported by this browser
      }
    }
  }

  audio.addEventListener("play", () => (renderList(), renderPlayer()));
  audio.addEventListener("pause", () => (renderList(), renderPlayer()));
  audio.addEventListener("timeupdate", renderTime);
  audio.addEventListener("durationchange", renderTime);
  audio.addEventListener("playing", () => (retried = false));
  audio.addEventListener("ended", () => (current < songs.length - 1 ? play(current + 1) : renderPlayer()));
  audio.addEventListener("error", () => {
    if (current < 0 || !audio.getAttribute("src")) return;
    // most likely the signed URL expired: a new one, from the same place
    if (!retried) {
      retried = true;
      return void play(current, audio.currentTime || 0);
    }
    $("shNowArtist").textContent = t("Không phát được bài này");
    if (current < songs.length - 1) setTimeout(() => play(current + 1), 1500);
  });

  $("shSongs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-i]");
    if (!b) return;
    const i = Number(b.dataset.i);
    if (i === current && audio.getAttribute("src")) return void (audio.paused ? audio.play() : audio.pause());
    play(i);
  });
  $("shPlayAll").addEventListener("click", () => play(0));
  $("shToggle").addEventListener("click", () => {
    if (current < 0) return play(0);
    if (!audio.getAttribute("src")) return play(current);
    audio.paused ? audio.play() : audio.pause();
  });
  $("shPrev").addEventListener("click", () => current > 0 && play(current - 1));
  $("shNext").addEventListener("click", () => current < songs.length - 1 && play(current + 1));
  $("shSeek").addEventListener("input", () => {
    seeking = true;
    const dur = Number.isFinite(audio.duration) ? audio.duration : 0;
    $("shCur").textContent = time((Number($("shSeek").value) / 1000) * dur);
  });
  $("shSeek").addEventListener("change", () => {
    seeking = false;
    const dur = Number.isFinite(audio.duration) ? audio.duration : 0;
    if (dur) audio.currentTime = (Number($("shSeek").value) / 1000) * dur;
  });
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, button") || current < 0) return;
    if (e.key === " ") {
      e.preventDefault();
      audio.paused ? audio.play() : audio.pause();
    } else if (e.key === "ArrowRight") audio.currentTime = Math.min(audio.currentTime + 10, audio.duration || 0);
    else if (e.key === "ArrowLeft") audio.currentTime = Math.max(audio.currentTime - 10, 0);
  });

  async function start() {
    if (!/^[\w-]{16}$/.test(code)) return gone();
    let data;
    try {
      data = await get("share-open", { code });
    } catch (err) {
      return gone(err.status === 404 ? null : t("Không mở được playlist, hãy thử lại sau"));
    }
    songs = data.songs;
    document.title = `${data.name} · DLiMusic`;
    $("shName").textContent = data.name;
    const until = new Date(data.expiresAt).toLocaleString(locale(), {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    $("shInfo").textContent = t("{n} bài · hết hạn {date}", { n: songs.length, date: until });
    $("shLoading").classList.add("d-none");
    $("shList").classList.remove("d-none");
    renderList();
  }

  start();
})();
