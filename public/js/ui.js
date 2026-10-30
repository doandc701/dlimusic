// DLiMusic UI: talks to /api (local server) or to window.TDL_BACKEND (browser build).

const $ = (id) => document.getElementById(id);
const FAV_CHAT = "fav"; // state.chat value of the "Bài hát yêu thích" list (all favourites, every chat)
const PAGE_ID = Math.random().toString(36).slice(2, 10); // tells this tab's scans apart from other tabs

// Brand line shown across the app (login footer, sidebar footer, start screen, tab title).
const SLOGAN = "Chạm là nghe, nhấn là tải";
for (const el of document.querySelectorAll(".app-slogan")) el.textContent = SLOGAN;
// © year follows the visitor's clock, never a fixed number in the page.
for (const el of document.querySelectorAll(".copy-year")) el.textContent = new Date().getFullYear();

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const fmt = (n) => {
  if (!n) return "";
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return `${(n / 1024 ** i).toFixed(1)} ${u[i]}`;
};
// Search key: fancy Unicode letters (𝙉𝙝ạ𝙘) -> plain, strip Vietnamese accents, lower case.
const norm = (s) =>
  String(s ?? "")
    .normalize("NFKC")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
const fmtDur = (sec) => {
  if (!sec) return "";
  const h = Math.floor(sec / 3600),
    m = Math.floor((sec % 3600) / 60),
    s = Math.floor(sec % 60);
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(s).padStart(2, "0")}`;
};
// The name Telegram apps show: "Performer – Title" from the audio tags, else the file name.
const displayName = (f) => (f.title ? (f.performer ? `${f.performer} – ${f.title}` : f.title) : f.name);
const show = (el, on) => el.classList.toggle("d-none", !on);
const COLORS = ["#e57373", "#f06292", "#ba68c8", "#7986cb", "#4fc3f7", "#4db6ac", "#81c784", "#ffb74d", "#a1887f"];

const confirmModal = new bootstrap.Modal($("confirm"));
const askModal = new bootstrap.Modal($("askModal"));
const settingsModal = new bootstrap.Modal($("settingsModal"));
const pickerModal = new bootstrap.Modal($("pickerModal"));
const previewModal = new bootstrap.Modal($("previewModal"));
const chatsModal = new bootstrap.Modal($("chatsModal"));

// ---------- dropdowns: one open at a time, and a tap anywhere else closes it ----------
// Bootstrap closes them on a click outside, but iPhones send no click for a tap on something that is not
// clickable (the page, a picture…): close on the press itself instead, wherever it lands.
const openDropdowns = () =>
  [...document.querySelectorAll('[data-bs-toggle="dropdown"].show')]
    .map((toggle) => ({ toggle, dd: bootstrap.Dropdown.getInstance(toggle) }))
    .filter((x) => x.dd);
document.addEventListener(
  "pointerdown",
  (e) => {
    for (const { toggle, dd } of openDropdowns()) {
      if (toggle.contains(e.target) || dd._menu?.contains(e.target)) continue; // its own button / menu
      if (dd._config.autoClose === false || dd._config.autoClose === "inside") continue;
      dd.hide();
    }
  },
  true,
);
document.addEventListener("show.bs.dropdown", (e) => {
  for (const { toggle, dd } of openDropdowns()) if (toggle !== e.target && !dd._menu?.contains(e.target)) dd.hide();
});

// ---------- Bootstrap look for every <select> and every tooltip ----------
//
// A <select>'s open list is drawn by the browser / OS and cannot be styled, so each <select class="form-select">
// gets a Bootstrap dropdown in front of it. The <select> stays (hidden) as the source of truth: code keeps
// reading / setting .value, rebuilding its options and listening to "change" exactly as before.

function bsSelect(select) {
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "form-select bs-select text-start text-truncate";
  toggle.setAttribute("data-bs-toggle", "dropdown");
  toggle.setAttribute("aria-expanded", "false");
  if (select.getAttribute("aria-label")) toggle.setAttribute("aria-label", select.getAttribute("aria-label"));
  if (select.id) select.labels?.forEach((l) => (l.htmlFor = toggle.id = `${select.id}Btn`));
  const menu = document.createElement("ul");
  menu.className = "dropdown-menu bs-select-menu";

  const render = () => {
    const opt = select.options[select.selectedIndex];
    toggle.textContent = opt ? opt.textContent : "";
    menu.innerHTML = [...select.options]
      .map(
        (o, i) =>
          `<li><button type="button" class="dropdown-item d-flex align-items-center gap-2${i === select.selectedIndex ? " active" : ""}" data-index="${i}">
        <span class="flex-grow-1 text-truncate">${esc(o.textContent)}</span>${i === select.selectedIndex ? '<i class="bi bi-check2"></i>' : ""}</button></li>`,
      )
      .join("");
  };
  menu.addEventListener("click", (e) => {
    const item = e.target.closest("[data-index]");
    if (!item) return;
    const i = Number(item.dataset.index);
    if (i !== select.selectedIndex) {
      select.selectedIndex = i;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    render();
  });
  // keep the button in step when code sets .value or replaces the options
  const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  Object.defineProperty(select, "value", {
    configurable: true,
    get() {
      return proto.get.call(this);
    },
    set(v) {
      proto.set.call(this, v);
      render();
    },
  });
  new MutationObserver(render).observe(select, { childList: true, subtree: true, characterData: true });
  select.addEventListener("change", render);

  // In an .input-group the dropdown takes the select's place (Bootstrap rounds the group's ends by position).
  select.after(toggle, menu);
  const group = select.closest(".input-group");
  if (group) group.after(select);
  select.hidden = true;
  select.tabIndex = -1;
  render();
}
document.querySelectorAll("select.form-select").forEach(bsSelect);

// Tooltips (icon-only controls): Bootstrap's instead of the browser's yellow / grey box, for every element with a title — also
// ones added later and titles changed later. Mouse / trackpad only: on touch screens they would stick.
if (matchMedia("(hover: hover)").matches) {
  new bootstrap.Tooltip(document.body, {
    selector: "[title], [data-bs-original-title]",
    trigger: "hover",
    container: "body",
    title(el) {
      const tip = el.getAttribute("title");
      if (tip) {
        el.setAttribute("data-bs-original-title", tip);
        el.removeAttribute("title");
      } // a title changed since last time
      return el.getAttribute("data-bs-original-title") || "";
    },
  });
  // Only for icon-only controls: a button that already shows words (e.g. "Đăng xuất", "Nhạc") needs no
  // tooltip. innerText skips hidden parts, so when a label is hidden on a narrow screen the tooltip comes back.
  document.addEventListener("show.bs.tooltip", (e) => {
    if (/\p{L}{2,}/u.test(e.target.innerText || "")) e.preventDefault();
  });
  // a click (e.g. on ▶ or ♥) changes the button: hide its tooltip instead of leaving the old text up
  document.addEventListener(
    "click",
    (e) => {
      const el = e.target.closest?.("[data-bs-original-title]");
      if (el) bootstrap.Tooltip.getInstance(el)?.hide();
    },
    true,
  );

  // A tooltip whose element is replaced while it shows (the list is redrawn after a heart, a download's
  // progress, another device's change, the next page…) never gets its "mouse left" and would stay on
  // screen until the page is reloaded. Any change of the page removes such orphans.
  const tipOwners = new Set();
  document.addEventListener("inserted.bs.tooltip", (e) => tipOwners.add(e.target));
  document.addEventListener("hidden.bs.tooltip", (e) => tipOwners.delete(e.target));
  let sweeping = false;
  const sweepTooltips = () => {
    if (sweeping) return;
    sweeping = true;
    requestAnimationFrame(() => {
      sweeping = false;
      for (const el of tipOwners) {
        if (el.isConnected) continue;
        const tip = bootstrap.Tooltip.getInstance(el);
        tip?.tip?.remove();
        tip?.dispose();
        tipOwners.delete(el);
      }
      // a tooltip no element points at any more
      for (const tip of document.querySelectorAll("body > .tooltip")) {
        if (!document.querySelector(`[aria-describedby="${CSS.escape(tip.id)}"]`)) tip.remove();
      }
    });
  };
  new MutationObserver(sweepTooltips).observe(document.body, { childList: true, subtree: true });
  // scrolling moves things away from the pointer, leaving the window leaves them: hide what shows
  const hideTooltips = () => tipOwners.forEach((el) => bootstrap.Tooltip.getInstance(el)?.hide());
  document.addEventListener("scroll", hideTooltips, { capture: true, passive: true });
  window.addEventListener("blur", hideTooltips);
}
const toastBox = bootstrap.Toast.getOrCreateInstance($("toast"), { delay: 3500 });

const state = {
  auth: null,
  dialogs: [],
  recent: [], // songs played lately: { id: "<chat id>|<message id>", at, name, title, performer, chat, duration }
  cloud: null, // status of the MongoDB copy { enabled, connected, host, error, lastSync }
  visibleChats: null, // Set of chat ids this account chose to show, or null = all
  favorites: new Set(), // "<chat id>|<message id>" of this account's favourite files
  playlists: [], // this account's playlists { id, name, songs, at, up }, newest first (core.js)
  orders: [], // lists dragged to an order of their own { id: "<chat id>" | "fav", songs }, while the page is open
  favScope: "all", // "Bài hát yêu thích": "all" chats, or one chat id (list + what plays)
  playScan: null, // the list the playing song belongs to (may differ from the open one)
  playQueue: [], // ids of that list, in order, played one after another
  playOrder: [], // the order actually used: playQueue, or a shuffled copy of it
  shuffle: false, // play the queue in random order
  repeat: "off", // "off" | "one" (the same song again) | "all" (start the list again)
  scanning: false, // a chat scan is running (the reload button is locked)
  loadingMore: false, // the next page of the open list is being read (infinite scroll)
  scanCtrl: null, // AbortController of that scan
  scanId: null, // id of that scan, matched against its progress events
  hidden: new Set(), // songs ("<chat>|<message>") hidden by "Lọc trùng" ③: this visit only, never saved
  keyChat: new Map(), // scan key -> the chat it was opened with (to find what belongs to a hidden chat)
  chat: null, // chat identifier sent to the server
  type: "all",
  scan: null, // { key, title, outDir, files }
  selected: new Set(), // file ids
  lastClicked: null,
  query: "",
  sort: "default", // default = channel order (newest first), not persisted on purpose
  jobs: new Map(),
  loadToken: 0,
  settings: { downloadDir: null, subfolderPerChat: true },
  history: [],
  panelOpen: true,
  dlTarget: null, // folder chosen for the current download only: { path, remember }
};
state.panelOpen = false; // "Phát gần đây" starts closed; the "Gần đây" button opens it

try {
  state.type = localStorage.getItem("type") || "all";
} catch {}

// Browser build (Vercel): web/backend.js runs Telegram inside this page and answers the same /api/*
// routes; the local version talks to server.js over HTTP.
const BACKEND = window.TDL_BACKEND || null;
const CAPS = BACKEND ? BACKEND.caps : { pickFolder: true, openFolder: true };

/** Call the API (local server or in-browser backend). `signal` cancels it (switching chats stops a scan). */
async function api(path, body, { signal } = {}) {
  if (BACKEND) {
    const { status, data } = await BACKEND.request(body === undefined ? "GET" : "POST", path, body, { signal });
    if (status >= 400) throw Object.assign(new Error(data.error || t("Lỗi")), { code: data.code, status });
    return data;
  }
  const res = await fetch(
    path,
    body === undefined
      ? { signal }
      : {
          signal,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await res.json().catch(() => ({}));
  if (data.code === "NEED_TOKEN") location.reload(); // cookie gone: show the "open the token link" page
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { code: data.code, status: res.status });
  return data;
}

// Keep --nav-h = the top bar's height, so toasts open right under it (it is slimmer on short screens).
const navBar = document.querySelector(".navbar");
new ResizeObserver(() => document.documentElement.style.setProperty("--nav-h", `${navBar.offsetHeight}px`)).observe(
  navBar,
);

const TOAST_KINDS = {
  success: "bi-check-lg",
  error: "bi-x-lg",
  warn: "bi-exclamation-lg",
  info: "bi-info-lg",
  bye: "bi-heart-fill",
  welcome: "bi-emoji-heart-eyes-fill",
};

/** Short message at the top: kind = "success" (default) | "error" | "warn" | "info" | "bye" (heart) | "welcome". */
function toast(msg, kind = "success", { oneLine = false } = {}) {
  if (!TOAST_KINDS[kind]) kind = "info";
  $("toast").dataset.kind = kind;
  $("toast").classList.toggle("one-line", !!oneLine);
  $("toast").setAttribute("role", kind === "error" ? "alert" : "status");
  $("toastIcon").className = `bi ${TOAST_KINDS[kind]}`;
  $("toastBody").textContent = msg;
  toastBox.show();
}

// ---------- light / dark (theme.js applies it; until the button is used it follows the system) ----------

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

// the menu: one item per language file (js/lang/), each name in its own language
$("langList").innerHTML = Object.entries(tdlI18n.LANGS)
  .map(
    ([l, v]) => `<li><button type="button" class="dropdown-item d-flex align-items-center gap-2" data-lang="${esc(l)}"
      lang="${esc(v.html || l)}"><span class="flex-grow-1">${esc(v.name)}</span><i class="bi bi-check2"></i></button></li>`,
  )
  .join("");

function renderLang() {
  $("langCode").textContent = tdlI18n.LANGS[tdlI18n.lang].code;
  for (const b of document.querySelectorAll("#langList [data-lang]")) {
    const on = b.dataset.lang === tdlI18n.lang;
    b.classList.toggle("active", on);
    b.setAttribute("aria-current", String(on));
  }
}
$("langList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-lang]");
  if (!b) return;
  bootstrap.Dropdown.getOrCreateInstance($("langBtn")).hide(); // the page redraws below: close it explicitly
  tdlI18n.setLang(b.dataset.lang);
});
renderLang();

/** After the language changed: what this file built with t() is drawn again, without a reload. */
function redrawForLang() {
  renderLang();
  renderTheme();
  renderModes();
  setSpeed($("player").defaultPlaybackRate, false);
  setPhoneCode(phoneCode());
  if (state.auth) {
    if ($("floodLeft")) $("loginError").textContent = ""; // the countdown's sentence is built again
    renderAuth(state.auth);
  }
  if (state.auth?.step !== "ready") return;
  renderFavEntry();
  if (state.dialogs.length) renderDialogs();
  renderChatsInfo();
  renderUserSync();
  setScanning(state.scanning);
  setSort(state.sort); // the size / length column header, and the open list
  renderMembers();
  if (state.scan) $("chatTitle").textContent = scanTitle(state.scan); // "Tìm: “…”", favourites
  if (!state.scan) updateSelection();
  renderJobs();
  renderRecent();
  renderPlayerFav();
  fitBrand(); // the words got longer or shorter
}
tdlI18n.onChange(redrawForLang);

// ---------- auth ----------

const LOGIN_STEPS = {
  api_id: {
    title: "Tự tạo API ID",
    html: `Mở <a href="https://my.telegram.org/apps" target="_blank" rel="noopener noreferrer" class="fw-semibold">my.telegram.org <i class="bi bi-box-arrow-up-right"></i></a>,
      đăng nhập bằng số điện thoại → <b>API development tools</b> → tạo ứng dụng (tên tuỳ ý), rồi nhập <b>App api_id</b> (dãy số) vào đây.`,
    type: "text",
    placeholder: "App api_id, vd 12345678",
  },
  api_hash: {
    title: "Tự tạo API ID",
    html: `Nhập <b>App api_hash</b> (32 ký tự) ở cùng trang
      <a href="https://my.telegram.org/apps" target="_blank" rel="noopener noreferrer" class="fw-semibold">my.telegram.org <i class="bi bi-box-arrow-up-right"></i></a>.`,
    type: "text",
    placeholder: "App api_hash (32 ký tự)",
  },
  phone: { title: "Đăng nhập DLiMusic", desc: "Nhập số điện thoại của bạn.", type: "tel", placeholder: "912 345 678" },
  code: {
    title: "Nhập mã xác nhận",
    desc: "DLiMusic vừa gửi mã vào ứng dụng Telegram của bạn (không phải SMS).",
    type: "text",
    placeholder: "12345",
  },
  password: {
    title: "Mật khẩu xác minh 2 bước",
    desc: "Tài khoản bật xác minh 2 bước, nhập mật khẩu.",
    type: "password",
    placeholder: "Mật khẩu",
  },
};

// ---------- header: the logo shrinks to the icon when space runs out; the account card ----------

const navbar = document.querySelector("nav.navbar");
/** Only the logo (no "DLiMusic") when the name would be cut or the header would overflow. */
function fitBrand() {
  navbar.classList.remove("brand-compact");
  const brand = $("homeLink");
  if (brand.scrollWidth > brand.clientWidth + 1 || navbar.scrollWidth > navbar.clientWidth + 1)
    navbar.classList.add("brand-compact");
}
new ResizeObserver(fitBrand).observe(navbar);

/** "+84912345678" -> "+84 912 345 678" */
const fmtPhone = (p) =>
  p ? String(p).replace(/^\+(84|1|7|\d{2})(\d{3})(\d{3})(\d+)$/, "+$1 $2 $3 $4") : t("Không có");

function renderUser(me) {
  const color = COLORS[Math.abs([...me.id].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % COLORS.length];
  const initial = [...me.name.replace(/[^\p{L}\p{N}]/gu, "")][0]?.toUpperCase() || "?";
  for (const el of [$("userAvatar"), $("userCardAvatar")]) {
    el.textContent = initial;
    el.style.background = color;
  }
  $("userMenu").style.setProperty("--user-color", color); // the card's name band takes this account's colour
  $("userBtn").setAttribute("aria-label", t("Tài khoản: {name}", { name: me.name }));
  $("userCardName").textContent = me.name;
  $("userCardUsername").textContent = me.username ? `@${me.username}` : t("Chưa đặt username");
  $("userCardPhone").textContent = fmtPhone(me.phone);
  $("userCardId").textContent = me.id;
  renderUserSync();
}

/** " · 13:52" (today) or " · 13:52 12/10" (an earlier day) of the last sync. */
function fmtSyncTime(at) {
  if (!at) return "";
  const d = new Date(at);
  const time = d.toLocaleTimeString(tdlI18n.locale, { hour: "2-digit", minute: "2-digit" });
  const day =
    d.toDateString() === new Date().toDateString()
      ? ""
      : ` ${d.toLocaleDateString(tdlI18n.locale, { day: "2-digit", month: "2-digit" })}`;
  return `<span class="text-body-secondary"> · ${time}${day}</span>`;
}

function renderUserSync() {
  const c = state.cloud;
  $("userCardSync").innerHTML =
    !c || !c.enabled
      ? `<span class="text-body-secondary">${t("Chỉ lưu trên thiết bị này")}</span>`
      : c.connected
        ? `<span class="text-success"><i class="bi bi-check-circle-fill"></i> ${t("Đã đồng bộ")}</span>${fmtSyncTime(c.lastSync)}`
        : `<span class="text-warning"><i class="bi bi-exclamation-triangle-fill"></i> ${t("Mất kết nối, đang thử lại")}</span>`;
}

$("userMenu").addEventListener("show.bs.dropdown", () => {
  renderUserSync();
  refreshCloud().then(renderUserSync); // the latest state, not the one from when the page loaded
});
$("userSettingsBtn").addEventListener("click", () => {
  bootstrap.Dropdown.getInstance($("userBtn"))?.hide();
  openSettings();
});
$("userLogoutBtn").addEventListener("click", () => {
  bootstrap.Dropdown.getInstance($("userBtn"))?.hide();
  signOut();
});

// ---------- page load splash: "DLiMusic" comes in letter by letter while the session reconnects ----------

/**
 * The letters come in more and more slowly, the last one is kept back: how long connecting takes is not
 * known, so the name is only complete once it is done (then the rest come in quickly and the splash fades).
 */
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
  setTimeout(() => self.finish(), 20_000); // still connecting after that: the login card says so
  const self = {
    get active() {
      return !finished;
    },
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

function renderAuth(auth) {
  if (splash.active && auth.step !== "connecting") splash.finish(); // signed in, or a step to show
  const prev = state.auth?.step;
  state.auth = auth;
  const ready = auth.step === "ready";
  show($("loginView"), !ready);
  $("mainView").classList.toggle("d-none", !ready);
  $("pageCopy").classList.toggle("d-none", !ready);
  $("mainView").classList.toggle("d-flex", ready);
  show($("recentBtn"), ready);
  show($("userMenu"), ready);
  if (ready) renderUser(auth.me);
  fitBrand();

  if (ready) {
    if (prev !== "ready") {
      loadDialogs();
      restorePlayback(); // a reload while a song played: it goes on where it was
    }
    // Only right after signing in here, not when a saved session reconnects on page load.
    if (LOGIN_STEPS[prev] || prev === "waiting" || prev === "qr") {
      // typed a code / password, or scanned the QR code
      // one line on a phone too: a long name is shortened ("Nguyễn Thị Phương Th…")
      const full = auth.me?.name || t("bạn");
      const name = [...full].length > 18 ? [...full].slice(0, 17).join("").trimEnd() + "…" : full;
      toast(t("Chào mừng {name} quay trở lại 🥰", { name }), "welcome", { oneLine: true });
    }
    return;
  }

  const choosing = auth.step === "api_choice";
  show($("loginChoice"), choosing);
  show($("choiceError"), choosing && !!auth.error);
  $("choiceError").textContent = choosing ? auth.error || "" : "";
  if (choosing) {
    show($("loginForm"), false);
    show($("loginBack"), false); // first screen: nothing to go back to
    $("loginTitle").textContent = t("Chào mừng đến DLiMusic");
    $("loginDesc").textContent = t("Kết nối tài khoản Telegram để nghe và tải nhạc từ các kênh của bạn:");
    for (const b of document.querySelectorAll("#loginChoice button")) b.disabled = false;
    return;
  }

  // QR sign-in: the code (refreshed every 30 s by the backend) instead of the form
  const qr = auth.step === "qr" && auth.qr;
  show($("loginQr"), !!qr);
  if (qr) {
    show($("loginForm"), false);
    show($("loginBack"), false);
    show($("loginError"), false);
    $("loginTitle").textContent = t("Quét mã QR để đăng nhập");
    $("loginDesc").textContent = t("Dùng ứng dụng Telegram trên điện thoại");
    renderQr(qr);
    return;
  }
  stopQrTimer();

  const step = LOGIN_STEPS[auth.step];
  show($("loginForm"), !!step);
  show($("qrOr"), auth.step === "phone");
  show($("qrLoginBtn"), auth.step === "phone");
  $("qrLoginBtn").disabled = false;
  show($("phoneCode"), auth.step === "phone");
  // "← choose again" on the API ID / hash steps and on the phone step (browser build with a built-in API)
  show($("loginBack"), !!step && !!auth.apiChoice && (auth.step.startsWith("api_") || auth.step === "phone"));
  // Telegram's wait after too many codes: the time left, counted from when it ends (right after a reload too)
  const flood = auth.error && auth.floodUntil > Date.now();
  // On the phone step a rejected number is shown on the field itself (Bootstrap validation).
  const fieldError = auth.step === "phone" && !flood && auth.error;
  show($("loginError"), !!auth.error && !fieldError);
  const waited = auth.error && auth.floodUntil && auth.floodUntil <= Date.now(); // the wait is over meanwhile
  if (flood) showFloodCountdown(auth.floodUntil);
  else {
    stopFloodCountdown();
    $("loginError").textContent = fieldError ? "" : waited ? t(FLOOD_OVER) : auth.error || "";
  }
  if (step) {
    $("loginTitle").textContent = t(step.title);
    if (step.html)
      $("loginDesc").innerHTML = t(step.html); // fixed text from this file, never user data
    else $("loginDesc").textContent = t(step.desc);
    const input = $("loginInput");
    if (prev !== auth.step) {
      input.type = step.type;
      input.placeholder = t(step.placeholder);
      input.value = "";
      if (auth.step === "phone") fillPhone(auth.phone);
      input.inputMode = auth.step === "phone" || auth.step === "code" || auth.step === "api_id" ? "numeric" : "text";
      setOtpMode(auth.step === "code");
      setFieldError(null);
      phoneChecked = false;
      setTimeout(() => (auth.step === "code" ? otpInputs()[0] : input).focus(), 0);
    }
    if (fieldError) setFieldError(auth.error);
    $("loginBtn").disabled = false;
  } else if (auth.step === "error") {
    $("loginTitle").textContent = t("Lỗi kết nối");
    $("loginDesc").textContent = auth.error;
  } else {
    $("loginTitle").textContent = auth.step === "waiting" ? t("Đang xác thực…") : t("Đang kết nối…");
    $("loginDesc").innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
  }
}

// ---------- Telegram's wait after too many codes: a live hh:mm:ss countdown ----------

const FLOOD_OVER = "Đã hết thời gian chờ của Telegram, bạn có thể thử lại.";
let floodTimer = null;

const hms = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, "0")).join(":");
};

function showFloodCountdown(until) {
  const box = $("loginError");
  if (!box.querySelector("#floodLeft")) {
    // fixed text from this file only
    box.innerHTML = `<div>${t("Telegram tạm khoá đăng nhập bằng mã cho số này vì thử quá nhiều lần.")}
      <div class="flood-row">${t("Thử lại sau {time}", { time: '<strong class="flood-left" id="floodLeft"></strong>' })}</div>
      ${t("Bạn vẫn có thể đăng nhập ngay bằng <b>mã QR</b> bên dưới.")}</div>`;
  }
  const tick = () => {
    if (Date.now() >= until) {
      stopFloodCountdown();
      box.textContent = t(FLOOD_OVER);
      return;
    }
    $("floodLeft").textContent = hms(until - Date.now());
  };
  tick();
  clearInterval(floodTimer);
  floodTimer = setInterval(tick, 1000);
}

function stopFloodCountdown() {
  clearInterval(floodTimer);
  floodTimer = null;
}

// ---------- sign-in with a QR code ----------

const QR_LOGIN = "__qr__"; // same value as core.js QR_LOGIN
let qrTimer = null;
let qrShown = null;

function renderQr(qr) {
  if (qrShown !== qr.url) {
    qrShown = qr.url;
    $("qrBox").innerHTML = qr.svg; // SVG made by the backend (qrcode-generator) from the login token
  }
  const tick = () => {
    const left = Math.ceil((qr.expires - Date.now()) / 1000);
    $("qrTimer").textContent = left > 0 ? t("Mã tự làm mới sau {n} giây", { n: left }) : t("Đang lấy mã mới…");
  };
  tick();
  clearInterval(qrTimer);
  qrTimer = setInterval(tick, 1000);
}

function stopQrTimer() {
  clearInterval(qrTimer);
  qrTimer = null;
  qrShown = null;
}

$("qrLoginBtn").addEventListener("click", () => {
  $("qrLoginBtn").disabled = true;
  sendLogin("phone", QR_LOGIN);
});
$("qrBackBtn").addEventListener("click", () => sendLogin("qr", "__back__"));

async function sendLogin(kind, value) {
  try {
    await api("/api/login", { kind, value });
  } catch (err) {
    toast(err.message, "error");
  }
}

$("loginChoice").addEventListener("click", (e) => {
  const b = e.target.closest("[data-choice]");
  if (!b) return;
  for (const x of document.querySelectorAll("#loginChoice button")) x.disabled = true;
  sendLogin("api_choice", b.dataset.choice);
});
$("loginBack").addEventListener("click", () => sendLogin(state.auth.step, "__back__"));

// ---------- phone number: the country code is fixed in front (+84 by default) ----------

const PHONE_CODES = [
  ["84", "vn", "Việt Nam"],
  ["1", "us", "Mỹ / Canada"],
  ["44", "gb", "Anh"],
  ["61", "au", "Úc"],
  ["65", "sg", "Singapore"],
  ["66", "th", "Thái Lan"],
  ["81", "jp", "Nhật Bản"],
  ["82", "kr", "Hàn Quốc"],
  ["86", "cn", "Trung Quốc"],
  ["852", "hk", "Hồng Kông"],
  ["855", "kh", "Campuchia"],
  ["856", "la", "Lào"],
  ["886", "tw", "Đài Loan"],
  ["33", "fr", "Pháp"],
  ["49", "de", "Đức"],
  ["7", "ru", "Nga"],
];

$("phoneMenu").innerHTML = PHONE_CODES.map(
  ([code, cc, name]) =>
    `<li><button type="button" class="dropdown-item d-flex align-items-center gap-2" data-code="${code}">
     <span class="fi fi-${cc}"></span><span>${t(name)}</span><span class="ms-auto text-body-secondary small">+${code}</span></button></li>`,
).join("");

/** The selected country code ("84"), kept on the button. */
const phoneCode = () => $("phoneCode").dataset.code || "84";

function setPhoneCode(code, remember) {
  const entry = PHONE_CODES.find(([c]) => c === code) || PHONE_CODES[0];
  $("phoneCode").dataset.code = entry[0];
  $("phoneFlag").className = `fi fi-${entry[1]}`;
  $("phoneDial").textContent = `+${entry[0]}`;
  $("phoneCode").title = `${t(entry[2])} (+${entry[0]})`;
  for (const b of document.querySelectorAll("#phoneMenu [data-code]"))
    b.classList.toggle("active", b.dataset.code === entry[0]);
  if (remember)
    try {
      localStorage.setItem("phoneCode", entry[0]);
    } catch {}
}

let savedCode = "84";
try {
  savedCode = localStorage.getItem("phoneCode") || "84";
} catch {}
setPhoneCode(savedCode);
$("phoneMenu").addEventListener("click", (e) => {
  const b = e.target.closest("[data-code]");
  if (!b) return;
  setPhoneCode(b.dataset.code, true);
  $("loginInput").focus();
});

/** Show a known full number (e.g. "+84912345678" from .env) as code + local part. */
function fillPhone(full) {
  const digits = String(full || "").replace(/\D/g, "");
  if (!digits) return;
  const codes = PHONE_CODES.map(([c]) => c).sort((a, b) => b.length - a.length);
  const code = codes.find((c) => digits.startsWith(c));
  if (code) {
    setPhoneCode(code);
    $("loginInput").value = digits.slice(code.length);
  }
}

/**
 * "+<code><number>" from what was typed. Accepts the usual ways of writing it: with the national
 * leading 0 (0912 345 678), with spaces/dots/dashes, or pasted with the country code (+84912..., 84912...).
 * Returns null when it cannot be a phone number.
 */
function composePhone(code, typed) {
  let digits = String(typed || "").replace(/[\s.\-()]/g, "");
  if (digits.startsWith("+")) {
    digits = digits.slice(1);
    if (digits.startsWith(code))
      digits = digits.slice(code.length); // pasted with the same country code
    else return /^\d{7,15}$/.test(digits) ? `+${digits}` : null; // another country's full number
  } else if (digits.startsWith("00" + code)) {
    digits = digits.slice(2 + code.length);
  } else if (digits.startsWith(code) && digits.length - code.length >= 8) {
    digits = digits.slice(code.length); // typed the code again without "+"
  }
  digits = digits.replace(/^0+/, ""); // national trunk prefix: 0382... -> 382...
  if (!/^\d+$/.test(digits)) return null;
  const total = code.length + digits.length;
  if (digits.length < 6 || total > 15) return null;
  if (code === "84" && digits.length !== 9) return null; // Vietnamese mobile numbers: +84 + 9 digits
  return `+${code}${digits}`;
}

// ---------- verification code: one box per digit ----------
const OTP_LEN = 5; // Telegram login codes are 5 digits
const otpInputs = () => [...$("otpBoxes").querySelectorAll("input")];

$("otpBoxes").innerHTML = Array.from(
  { length: OTP_LEN },
  (_, i) =>
    `<input class="form-control otp-box" inputmode="numeric" pattern="[0-9]*" maxlength="1"
     ${i === 0 ? 'autocomplete="one-time-code"' : 'autocomplete="off"'} aria-label="${t("Số thứ {n}", { n: i + 1 })}">`,
).join("");

/** The code step shows the digit boxes instead of the single input (which then only carries the value). */
function setOtpMode(on) {
  show($("loginField"), !on);
  show($("otpBoxes"), on);
  $("loginInput").required = !on;
  for (const b of otpInputs()) {
    b.value = "";
    b.classList.remove("filled");
  }
}

/** Write digits into the boxes from box `from` on (typing, pasting or the phone's autofill). */
function fillOtp(from, text) {
  const boxes = otpInputs();
  const digits = String(text).replace(/\D/g, "").split("");
  let i = from;
  for (const d of digits) {
    if (i >= boxes.length) break;
    boxes[i].value = d;
    i++;
  }
  boxes.forEach((b) => b.classList.toggle("filled", !!b.value));
  const code = boxes.map((b) => b.value).join("");
  $("loginInput").value = code;
  if (code.length === boxes.length) {
    boxes[boxes.length - 1].focus();
    if (!$("loginBtn").disabled) $("loginForm").requestSubmit();
  } else boxes[Math.min(i, boxes.length - 1)].focus();
}

$("otpBoxes").addEventListener("input", (e) => {
  const box = e.target;
  const i = otpInputs().indexOf(box);
  const typed = box.value;
  box.value = "";
  if (typed.replace(/\D/g, "")) fillOtp(i, typed);
  else fillOtp(i, ""); // a letter: drop it
});

$("otpBoxes").addEventListener("keydown", (e) => {
  const boxes = otpInputs();
  const i = boxes.indexOf(e.target);
  if (e.key === "Backspace" && !e.target.value && i > 0) {
    e.preventDefault();
    boxes[i - 1].value = "";
    fillOtp(i - 1, "");
  } else if (e.key === "ArrowLeft" && i > 0) {
    e.preventDefault();
    boxes[i - 1].focus();
  } else if (e.key === "ArrowRight" && i < boxes.length - 1) {
    e.preventDefault();
    boxes[i + 1].focus();
  }
});

$("otpBoxes").addEventListener("paste", (e) => {
  e.preventDefault();
  fillOtp(0, e.clipboardData.getData("text"));
});

$("otpBoxes").addEventListener("focusin", (e) => e.target.select());

// ---------- phone number: Bootstrap validation states on the field ----------

let phoneChecked = false; // after the first "Tiếp tục", the field re-validates while typing

/** Mark the login field invalid with a message under it (null = clear). */
function setFieldError(msg) {
  const input = $("loginInput");
  input.classList.toggle("is-invalid", !!msg);
  input.classList.remove("is-valid");
  input.setAttribute("aria-invalid", msg ? "true" : "false");
  $("loginFeedback").textContent = msg || "";
}

const phoneMessage = () =>
  phoneCode() === "84"
    ? t("Số điện thoại Việt Nam gồm 9 số sau +84 (có thể gõ kèm số 0 ở đầu, vd 0912 345 678).")
    : t("Số điện thoại không hợp lệ.");

/** Validate the phone field; returns "+<code><number>" or null (and shows why). */
function checkPhone() {
  const input = $("loginInput");
  if (!input.value.trim()) {
    setFieldError(t("Hãy nhập số điện thoại."));
    return null;
  }
  const value = composePhone(phoneCode(), input.value);
  setFieldError(value ? null : phoneMessage());
  input.classList.toggle("is-valid", !!value);
  return value;
}

$("loginInput").addEventListener("input", () => {
  if (state.auth?.step === "phone" && phoneChecked) checkPhone();
  else if ($("loginInput").classList.contains("is-invalid")) setFieldError(null);
});
$("phoneMenu").addEventListener("click", () => state.auth?.step === "phone" && phoneChecked && checkPhone());

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  let value = $("loginInput").value;
  if (state.auth.step === "code" && value.length < OTP_LEN) {
    $("loginError").textContent = t("Nhập đủ {n} số của mã xác nhận.", { n: OTP_LEN });
    show($("loginError"), true);
    otpInputs()[value.length]?.focus();
    return;
  }
  // novalidate: the browser's own bubbles are off, empty fields are flagged Bootstrap-style instead
  if (state.auth.step !== "code" && state.auth.step !== "phone" && !value.trim()) {
    setFieldError(t("Không được để trống."));
    $("loginInput").focus();
    return;
  }
  if (state.auth.step === "phone") {
    phoneChecked = true;
    value = checkPhone();
    if (!value) {
      show($("loginError"), false);
      $("loginInput").focus();
      return;
    }
  }
  $("loginBtn").disabled = true;
  try {
    await api("/api/login", { kind: state.auth.step, value });
  } catch (err) {
    $("loginError").textContent = err.message;
    show($("loginError"), true);
    $("loginBtn").disabled = false;
  }
});

/** "Đăng xuất" (in the account card): confirm, then back to the login screen. */
async function signOut() {
  const ok = await ask({
    title: `<i class="bi bi-box-arrow-right text-danger"></i> ${t("Đăng xuất")}`,
    body: t("Bạn có muốn đăng xuất tài khoản khỏi DLiMusic?"),
    ok: t("Đăng xuất"),
    okClass: "btn-danger",
  });
  if (!ok) return;
  // Go to the login screen right away; the server finishes signing out in the background.
  resetWorkspace();
  renderAuth({ step: "phone", error: null, me: null, phone: state.auth?.phone || "" });
  api("/api/logout", {})
    .then(() => toast(t("Xin chào và hẹn gặp lại"), "bye"))
    .catch((e) => toast(e.message, "error"));
}

/** Stop and hide the player. */
function stopPlayer() {
  forgetPlayback();
  const p = $("player");
  p.pause();
  p.removeAttribute("src");
  p.load();
  state.playingId = null;
  state.playingKey = null;
  state.playScan = null;
  state.playQueue = [];
  state.playOrder = [];
  show($("playerBar"), false);
}

/** Forget everything tied to the signed-out account (chat, files, selection, player, queue view). */
function resetWorkspace() {
  setView(homeView(), false);
  state.loadToken++; // ignore a scan that is still in flight
  stopScan();
  setScanning(false);
  state.scan = null;
  state.chat = null;
  state.dialogs = [];
  state.visibleChats = null;
  forgetAvatars();
  state.favorites.clear();
  state.playlists = [];
  state.selected.clear();
  state.jobs.clear();
  renderJobs();
  stopPlayer();
  state.keyChat.clear();
  $("dialogSearch").value = "";
  resetGlobalSearch();
  resetSongSearch();
  show($("chatsBar"), false);
  $("dialogs").innerHTML =
    `<div class="text-center p-4"><span class="spinner-border spinner-border-sm text-primary"></span></div>`;
  showChat(false);
  updateSelection();
}

// ---------- dialogs ----------

const TYPE_ICON = { channel: "bi-megaphone", group: "bi-people", user: "bi-person", bot: "bi-robot" };
const TYPE_LABEL = { channel: "Kênh", group: "Nhóm", user: "Người dùng", bot: "Bot" };

/**
 * Coloured circle with the first letter of the chat title; with the chat's Telegram picture on top
 * once it is known (d.photo = the picture's id, from /api/dialogs or /api/search).
 */
function dialogAvatar(d) {
  const color = COLORS[Math.abs([...d.id].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % COLORS.length];
  const initial = esc([...d.title.replace(/[^\p{L}\p{N}]/gu, "")][0] || "#").toUpperCase();
  const photo = /^-?\d{1,20}$/.test(d.id) && /^-?\d{1,25}$/.test(String(d.photo || "")) ? d.photo : null;
  if (!photo) return `<span class="avatar rounded-circle" style="background:${color}">${initial}</span>`;
  const url = avatarPhotos.get(`${d.id}:${photo}`);
  return `<span class="avatar rounded-circle" style="background:${color}" data-avatar="${d.id}" data-photo="${photo}">${initial}${url ? avatarImg(url) : ""}</span>`;
}

// ---------- chat pictures (Telegram's small profile photos), loaded for the rows on screen ----------

const avatarImg = (url) => `<img class="avatar-img" src="${esc(url)}" alt="" loading="lazy" decoding="async">`;
const avatarPhotos = new Map(); // "id:photoId" -> data: URL (this page; filled from IndexedDB at start)
const avatarMissing = new Map(); // "id:photoId" -> when the server had no picture for it (asked again later)
const AVATAR_RETRY_MS = 5 * 60_000;
const avatarPending = new Map(); // "id:photoId" -> [id, photoId] waiting for the next batch
const avatarAsked = new Set(); // "id:photoId" asked for (pending or in flight)
let avatarTimer = null;
const AVATAR_BATCH = 40;
const AVATAR_STORE_MAX = 400;

/** The pictures of earlier visits, kept in IndexedDB so the list shows them at once next time. */
const avatarDb = (() => {
  const open = new Promise((resolve) => {
    try {
      const req = indexedDB.open("tdl-avatars", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("photos");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null); // private mode / storage blocked: only this page remembers them
    }
  });
  const tx = (mode, fn) =>
    open.then(
      (d) =>
        d &&
        new Promise((resolve) => {
          try {
            const t = d.transaction("photos", mode);
            const r = fn(t.objectStore("photos"));
            t.oncomplete = () => resolve(r?.result);
            t.onerror = t.onabort = () => resolve(null);
          } catch {
            resolve(null);
          }
        }),
    );
  // { k: "id:photoId", url, at } records, newest kept when there are too many
  const ready = tx("readonly", (st) => st.getAll()).then((rows) => {
    for (const r of rows || []) if (r?.k && r.url && !avatarPhotos.has(r.k)) avatarPhotos.set(r.k, r.url);
    if ((rows || []).length > AVATAR_STORE_MAX) {
      const old = rows.sort((a, b) => (a.at || 0) - (b.at || 0)).slice(0, rows.length - AVATAR_STORE_MAX);
      tx("readwrite", (st) => old.forEach((r) => st.delete(r.k)));
    }
    fillAvatars();
  });
  return {
    ready,
    put(k, url) {
      const id = k.split(":")[0];
      tx("readwrite", (st) => {
        // a chat changed its picture: drop the old one
        for (const old of avatarPhotos.keys()) if (old !== k && old.split(":")[0] === id) st.delete(old);
        st.put({ k, url, at: Date.now() }, k);
      });
    },
    clear: () => tx("readwrite", (st) => st.clear()),
  };
})();

/** Put the known pictures into the avatars on the page that still show only their letter. */
function fillAvatars(root = document) {
  for (const el of root.querySelectorAll(".avatar[data-avatar]")) {
    if (el.querySelector(".avatar-img")) continue;
    const url = avatarPhotos.get(`${el.dataset.avatar}:${el.dataset.photo}`);
    if (url) el.insertAdjacentHTML("beforeend", avatarImg(url));
  }
}

/** An avatar came on screen: ask for its picture with the others of the next ~150 ms (40 per request). */
function wantAvatar(el) {
  const { avatar: id, photo } = el.dataset;
  const k = `${id}:${photo}`;
  if (avatarPhotos.has(k) || avatarAsked.has(k) || Date.now() - (avatarMissing.get(k) || 0) < AVATAR_RETRY_MS) return;
  avatarAsked.add(k);
  avatarPending.set(k, [id, photo]);
  clearTimeout(avatarTimer);
  avatarTimer = setTimeout(flushAvatars, 150);
}

async function flushAvatars() {
  await avatarDb.ready; // what an earlier visit kept is not asked again
  const batch = [...avatarPending].slice(0, AVATAR_BATCH);
  for (const [k] of batch) avatarPending.delete(k);
  if (avatarPending.size) avatarTimer = setTimeout(flushAvatars, 50);
  const todo = batch.filter(([k]) => !avatarPhotos.has(k));
  if (!todo.length || state.auth?.step !== "ready") {
    for (const [k] of batch) avatarAsked.delete(k);
    return;
  }
  let got = {};
  try {
    got = await api(`/api/avatars?ids=${todo.map(([, [id]]) => encodeURIComponent(id)).join(",")}`);
  } catch {
    // offline / signed out: letters stay; tried again when the rows are shown again
  }
  for (const [k, [id]] of todo) {
    avatarAsked.delete(k);
    const url = got?.[id];
    if (typeof url === "string" && url.startsWith("data:image/")) {
      avatarPhotos.set(k, url);
      avatarDb.put(k, url);
    } else avatarMissing.set(k, Date.now());
  }
  fillAvatars();
}

// Avatars are watched as soon as a list puts them on the page (lists are rebuilt with innerHTML).
const avatarSeen = new IntersectionObserver(
  (entries) => {
    for (const e of entries)
      if (e.isIntersecting) {
        avatarSeen.unobserve(e.target);
        avatarWatched.delete(e.target);
        wantAvatar(e.target);
      }
  },
  { rootMargin: "200px 0px" },
);
const avatarWatched = new Set();
let avatarScan = 0;
new MutationObserver(() => {
  if (avatarScan) return;
  avatarScan = requestAnimationFrame(() => {
    avatarScan = 0;
    for (const el of avatarWatched)
      if (!el.isConnected) {
        avatarSeen.unobserve(el); // the list was rebuilt
        avatarWatched.delete(el);
      }
    for (const el of document.querySelectorAll(".avatar[data-avatar]:not([data-watched])")) {
      el.dataset.watched = "";
      if (el.querySelector(".avatar-img")) continue;
      avatarWatched.add(el);
      avatarSeen.observe(el);
    }
  });
}).observe(document.body, { childList: true, subtree: true });

// A picture that cannot be shown (broken data): back to the letter.
document.addEventListener(
  "error",
  (e) => {
    if (e.target instanceof HTMLImageElement && e.target.classList.contains("avatar-img")) {
      const el = e.target.closest(".avatar");
      const k = `${el?.dataset.avatar}:${el?.dataset.photo}`;
      avatarMissing.set(k, Date.now());
      avatarPhotos.delete(k);
      e.target.remove();
    }
  },
  true,
);

/** Signed out: this browser may be used by someone else next. */
function forgetAvatars() {
  avatarPhotos.clear();
  avatarMissing.clear();
  avatarPending.clear();
  avatarDb.clear();
}

const dialogSub = (d) =>
  `<i class="bi ${TYPE_ICON[d.type]}"></i> ${t(TYPE_LABEL[d.type])}${d.username ? " · @" + esc(d.username) : ""}`;

async function loadDialogs() {
  try {
    const [dialogs, visible, favs] = await Promise.all([
      api("/api/dialogs"),
      api("/api/visible-chats"),
      api("/api/favorites"),
    ]);
    state.favorites = new Set(favs.ids);
    state.dialogs = dialogs;
    state.visibleChats = visible.ids ? new Set(visible.ids) : null;
    renderDialogs();
    loadRecent();
    loadPlaylists();
  } catch (err) {
    $("dialogs").innerHTML = `<div class="alert alert-danger m-3">${esc(err.message)}</div>`;
  }
}

/**
 * Another device changed the favourites / visible chats (shared through MongoDB): show them without
 * asking Telegram for the chat list again. Several changes in a row = one refresh.
 */
let accountRefresh = null;
function refreshAccountData() {
  clearTimeout(accountRefresh);
  accountRefresh = setTimeout(async () => {
    if (state.auth?.step !== "ready") return;
    try {
      const [visible, favs] = await Promise.all([api("/api/visible-chats"), api("/api/favorites")]);
      state.favorites = new Set(favs.ids);
      state.visibleChats = visible.ids ? new Set(visible.ids) : null;
      renderDialogs();
      loadRecent(); // another device played something
      loadPlaylists(); // …or changed a playlist
      if (state.chat === FAV_CHAT)
        loadFiles(); // the favourites list itself changed
      else if (state.scan) renderFiles(); // hearts on the open list
      renderPlayerFav?.();
    } catch {
      // next change or the next page load shows it
    }
  }, 300);
}

/** The chats the account chose to show (all of them while nothing was chosen). */
const shownDialogs = () =>
  state.visibleChats ? state.dialogs.filter((d) => state.visibleChats.has(d.id)) : state.dialogs;

// ---------- sorting the chat list (remembered in this browser) ----------

const DIALOG_SORTS = {
  recent: { label: "Mới hoạt động", icon: "bi-clock-history" }, // Telegram's own order
  az: { label: "Tên A → Z", icon: "bi-sort-alpha-down" },
  za: { label: "Tên Z → A", icon: "bi-sort-alpha-up-alt" },
  type: { label: "Theo loại (Kênh, Nhóm, Người dùng)", icon: "bi-collection" },
};
let dialogSort = "recent";
try {
  if (DIALOG_SORTS[localStorage.getItem("dialogSort")]) dialogSort = localStorage.getItem("dialogSort");
} catch {}

const TYPE_RANK = { channel: 0, group: 1, user: 2 };
const byTitle = (a, b) => a.title.localeCompare(b.title, "vi", { sensitivity: "base", numeric: true });

/** Chats in the chosen order; "recent" keeps the order Telegram returned (latest activity first). */
function sortDialogs(list) {
  if (dialogSort === "recent") return list;
  const order = list.map((d, i) => [d, i]);
  const cmp = {
    az: ([a], [b]) => byTitle(a, b),
    za: ([a], [b]) => byTitle(b, a),
    type: ([a, i], [b, j]) => TYPE_RANK[a.type] - TYPE_RANK[b.type] || i - j,
  }[dialogSort];
  return order.sort((x, y) => cmp(x, y) || x[1] - y[1]).map(([d]) => d);
}

function setDialogSort(key) {
  if (!DIALOG_SORTS[key]) return;
  dialogSort = key;
  try {
    localStorage.setItem("dialogSort", key);
  } catch {}
  renderDialogs();
  if ($("chatsModal").classList.contains("show")) renderChatsModal();
}

/** Small ⇅ menu in the bar above the list. */
function dialogSortMenu() {
  const cur = DIALOG_SORTS[dialogSort];
  return `<div class="dropdown flex-none">
    <button class="btn btn-sm chats-bar-btn chats-sort-btn${dialogSort !== "recent" ? " is-sorted" : ""}" type="button" data-bs-toggle="dropdown"
      aria-expanded="false" title="${t("Sắp xếp: {label}", { label: t(cur.label) })}" aria-label="${t("Sắp xếp hội thoại: {label}", { label: t(cur.label) })}"><i class="bi bi-arrow-down-up"></i></button>
    <ul class="dropdown-menu dropdown-menu-end shadow-sm">
      <li><h6 class="dropdown-header">${t("Sắp xếp hội thoại")}</h6></li>
      ${Object.entries(DIALOG_SORTS)
        .map(
          ([
            k,
            s,
          ]) => `<li><button class="dropdown-item d-flex align-items-center gap-2${k === dialogSort ? " active" : ""}" type="button" data-dialog-sort="${k}">
        <i class="bi ${s.icon}"></i><span class="flex-grow-1">${t(s.label)}</span>${k === dialogSort ? '<i class="bi bi-check2"></i>' : ""}</button></li>`,
        )
        .join("")}
    </ul></div>`;
}

function renderDialogs() {
  renderFavEntry();
  renderPlEntry();
  const q = norm($("dialogSearch").value.trim());
  const shown = shownDialogs();
  const list = sortDialogs(shown.filter((d) => !q || norm(d.title).includes(q) || norm(d.username).includes(q)));
  // Bar above the list: how many chats are shown, and a button to choose them.
  const total = state.dialogs.length;
  show($("chatsBar"), total > 0);
  $("chatsBar").innerHTML = total
    ? `
    <span class="text-truncate"><i class="bi ${state.visibleChats ? "bi-funnel-fill text-primary" : "bi-chat-dots"}"></i>
      ${state.visibleChats ? t("<strong>{n}</strong>/{total} hội thoại", { n: shown.length, total }) : t("<strong>{n}</strong> hội thoại", { n: total })}</span>
    <span class="ms-auto"></span>${dialogSortMenu()}
    <button class="btn btn-sm chats-bar-btn flex-none" data-chats-edit>
      <i class="bi bi-sliders"></i> ${state.visibleChats ? t("Chọn lại") : t("Chọn hội thoại")}</button>`
    : "";
  if (!shown.length && state.dialogs.length && !q) {
    $("dialogs").innerHTML = `<div class="text-center text-body-secondary small p-4">
      <i class="bi bi-eye-slash fs-3 d-block mb-2"></i>${t("Chưa chọn hội thoại nào để hiển thị.")}
      <div class="mt-2"><button class="btn btn-sm btn-primary" data-chats-edit><i class="bi bi-sliders"></i> ${t("Chọn hội thoại")}</button></div></div>`;
    return;
  }
  const rows = list
    .map((d) => {
      const active = state.chat === d.id ? " active" : "";
      return `<a class="list-group-item list-group-item-action dialog-item d-flex align-items-center gap-2${active}" data-id="${esc(d.id)}" title="${esc(d.title)}">
      ${dialogAvatar(d)}
      <span class="min-w-0 side-text"><span class="d-block text-truncate">${esc(d.title)}</span>
      <small class="d-block text-truncate ${active ? "" : "text-body-secondary"}">${dialogSub(d)}</small></span></a>`;
    })
    .join("");
  const typed = $("dialogSearch").value.trim();
  const none = q
    ? `<div class="text-body-secondary small p-3 text-center">${isChatLink(typed) ? t("Không tìm thấy. Nhấn Enter để mở “{q}”.", { q: esc(typed) }) : t("Không tìm thấy kết quả")}</div>`
    : `<div class="text-body-secondary small p-3 text-center">${t("Chưa có hội thoại nào. Dán link / username kênh vào ô tìm kiếm rồi nhấn Enter.")}</div>`;
  // Typing in the search box (like Telegram): one list of chats — yours first, then the public ones
  // Telegram found — and the songs under it.
  const global = globalSearchActive();
  if (!global) {
    $("dialogs").innerHTML = rows || none;
    return;
  }
  const found = renderGlobalResults(list);
  $("dialogs").innerHTML =
    `<div class="dialog-section">${t("Kết quả tìm kiếm toàn cầu")}</div>` +
    (rows || found.rows ? rows + found.rows : "") +
    (found.note ?? (rows || found.rows ? "" : none)) +
    renderSongResults();
  updateSongRows();
}

// ---------- global search: public channels / groups / people, and joining them ----------

const gsearch = {
  q: "", // what was (or is being) searched
  status: "idle", // idle | loading | done | error
  chats: [], // the results of `q`, as /api/search sends them
  error: null,
  timer: null,
  ctrl: null, // AbortController of the request in flight
  seq: 0,
  joins: new Map(), // result key -> "joining" | "pending" (join request waiting for an admin)
};
const SEARCH_MIN = 2;
const SEARCH_MAX = 64;
const joinKey = (r) => (r.invite ? `+${r.invite}` : r.id);

/** Is the search box asking Telegram (2–64 characters)? */
function globalSearchActive() {
  const q = $("dialogSearch").value.trim();
  return state.auth?.step === "ready" && q.length >= SEARCH_MIN && q.length <= SEARCH_MAX;
}

function resetGlobalSearch() {
  clearTimeout(gsearch.timer);
  gsearch.ctrl?.abort();
  Object.assign(gsearch, { q: "", status: "idle", chats: [], error: null, ctrl: null });
  gsearch.seq++;
}

/** Ask Telegram ~350 ms after the last key press; an older request still running is cancelled. */
function scheduleGlobalSearch() {
  const q = $("dialogSearch").value.trim();
  if (!globalSearchActive()) return resetGlobalSearch();
  if (q === gsearch.q && gsearch.status !== "idle") return; // e.g. only a space was added
  resetGlobalSearch();
  Object.assign(gsearch, { q, status: "loading" });
  const seq = gsearch.seq;
  gsearch.timer = setTimeout(async () => {
    const ctrl = (gsearch.ctrl = new AbortController());
    try {
      const data = await api(`/api/search?q=${encodeURIComponent(q)}`, undefined, { signal: ctrl.signal });
      if (seq !== gsearch.seq) return;
      Object.assign(gsearch, { status: "done", chats: Array.isArray(data.chats) ? data.chats : [] });
    } catch (err) {
      if (seq !== gsearch.seq || err.name === "AbortError") return;
      Object.assign(gsearch, { status: "error", error: err.message });
    }
    gsearch.ctrl = null;
    renderDialogs();
  }, 350);
}

/** "12,3K" in the chosen language. */
function compactNumber(n) {
  try {
    return new Intl.NumberFormat(tdlI18n.locale, { notation: "compact", maximumFractionDigits: 1 }).format(n);
  } catch {
    return String(n);
  }
}

function globalSub(r) {
  const parts = [];
  if (r.username) parts.push(`@${esc(r.username)}`);
  if (r.members != null) {
    const n = compactNumber(r.members);
    parts.push(esc(r.type === "channel" ? t("{n} người theo dõi", { n }) : t("{n} thành viên", { n })));
  } else if (!r.username || r.type === "user" || r.type === "bot") parts.push(t(TYPE_LABEL[r.type] || "Kênh"));
  return `<i class="bi ${TYPE_ICON[r.type] || "bi-chat-dots"}"></i> ${parts.join(" · ")}`;
}

function globalJoinButton(r, i) {
  if (r.joined || r.type === "user" || r.type === "bot") return "";
  const st = gsearch.joins.get(joinKey(r));
  if (st === "pending")
    return `<span class="dialog-join is-pending" title="${t("Chờ quản trị viên duyệt")}">${t("Đã gửi yêu cầu")}</span>`;
  if (st === "joining")
    return `<button type="button" class="btn btn-sm dialog-join" disabled aria-label="${t("Đang tham gia…")}"><span class="spinner-border spinner-border-sm"></span></button>`;
  return `<button type="button" class="btn btn-sm dialog-join" data-join="${i}">${t("Tham gia")}</button>`;
}

/**
 * What Telegram's global search adds under the account's own matches: { rows } (chats not already
 * listed), and a { note } while it is searching or when it failed (null otherwise).
 */
function renderGlobalResults(localList) {
  const q = $("dialogSearch").value.trim();
  if (gsearch.q !== q || gsearch.status === "loading" || gsearch.status === "idle")
    return {
      rows: "",
      note: `<div class="dialog-note"><span class="spinner-border spinner-border-sm"></span> ${t("Đang tìm…")}</div>`,
    };
  if (gsearch.status === "error") return { rows: "", note: `<div class="dialog-note">${esc(gsearch.error)}</div>` };
  const mine = new Set(localList.map((d) => d.id));
  const rows = gsearch.chats.map((r, i) => [r, i]).filter(([r]) => !(r.id && mine.has(r.id)));
  return {
    note: null,
    rows: rows
      .map(
        ([
          r,
          i,
        ]) => `<a class="list-group-item list-group-item-action dialog-item global-item d-flex align-items-center gap-2" data-global="${i}" title="${esc(r.title)}">
      ${dialogAvatar({ id: String(r.id || r.invite || r.title), title: String(r.title || ""), photo: r.id ? r.photo : null })}
      <span class="min-w-0 side-text flex-grow-1"><span class="d-flex align-items-center gap-1 min-w-0"><span class="text-truncate">${esc(r.title)}</span>${r.verified ? `<i class="bi bi-patch-check-fill text-primary flex-none" title="${t("Đã xác minh")}"></i>` : ""}</span>
      <small class="d-block text-truncate text-body-secondary">${globalSub(r)}</small></span>${globalJoinButton(r, i)}</a>`,
      )
      .join(""),
  };
}

/** A result was clicked: open it like Enter does (a public channel can be read without joining). */
function openGlobalResult(r) {
  if (r.joined && r.id && state.dialogs.some((d) => d.id === r.id)) return openChat(r.id);
  if (r.username) return openChat(r.username);
  if (r.joined && r.id) return openChat(r.id);
  toast(t("Kênh riêng tư: hãy bấm Tham gia để xem."), "info");
}

/** Join a channel / group found by the search, then show it in the list and open it. */
async function joinGlobalResult(r) {
  const key = joinKey(r);
  if (gsearch.joins.has(key)) return;
  gsearch.joins.set(key, "joining");
  renderDialogs();
  try {
    const res = await api("/api/join", r.invite ? { invite: r.invite } : { chat: r.username || r.id });
    if (res.pending) {
      gsearch.joins.set(key, "pending");
      renderDialogs();
      return toast(t("Đã gửi yêu cầu tham gia {title}, chờ quản trị viên duyệt.", { title: r.title }), "info");
    }
    gsearch.joins.delete(key);
    const d = res.dialog?.id
      ? res.dialog
      : r.id
        ? { id: r.id, title: r.title, type: r.type, username: r.username }
        : null;
    r.joined = true;
    await loadDialogs(); // it is the same Telegram account: Telegram's own apps show it too
    if (d) {
      if (!state.dialogs.some((x) => x.id === d.id)) state.dialogs.unshift(d); // Telegram may list it a moment later
      if (state.visibleChats && !state.visibleChats.has(d.id)) {
        // a chat filter is on: the new chat is added to it, or it would be hidden right away
        try {
          const v = await api("/api/visible-chats", { ids: [...state.visibleChats, d.id] });
          state.visibleChats = v.ids ? new Set(v.ids) : null;
        } catch {}
      }
    }
    renderDialogs();
    renderChatsInfo();
    toast(t("Đã tham gia {title}", { title: d?.title || r.title }));
    if (d) openChat(d.id);
    else if (r.username) openChat(r.username);
  } catch (err) {
    gsearch.joins.delete(key);
    renderDialogs();
    toast(err.message, "error");
  }
}

// ---------- song search: songs in every chat of the account (like Telegram's "messages found") ----------

const SEARCH_CHAT = "search:"; // state.chat of a song search list: "search:<words>" (never a chat id or username)
const isSearchChat = (chat) => typeof chat === "string" && chat.startsWith(SEARCH_CHAT);
const SONG_PAGE = 50; // same as core.js

const ssearch = {
  q: "",
  status: "idle", // idle | loading | done | error
  scan: null, // the list /api/search/songs sent (key "search:…"), playable as it is
  error: null,
  timer: null,
  ctrl: null,
  seq: 0,
  loadingMore: false, // the next page of results is being read (scrolled near the end of the sidebar)
};

function resetSongSearch() {
  clearTimeout(ssearch.timer);
  ssearch.ctrl?.abort();
  Object.assign(ssearch, { q: "", status: "idle", scan: null, error: null, ctrl: null, loadingMore: false });
  ssearch.seq++;
}

/** Its own request, on the same rhythm as the chat search; an older one still running is cancelled. */
function scheduleSongSearch() {
  const q = $("dialogSearch").value.trim();
  if (!globalSearchActive()) return resetSongSearch();
  if (q === ssearch.q && ssearch.status !== "idle") return;
  resetSongSearch();
  Object.assign(ssearch, { q, status: "loading" });
  const seq = ssearch.seq;
  ssearch.timer = setTimeout(async () => {
    const ctrl = (ssearch.ctrl = new AbortController());
    try {
      const scan = await api(`/api/search/songs?q=${encodeURIComponent(q)}`, undefined, { signal: ctrl.signal });
      if (seq !== ssearch.seq) return;
      Object.assign(ssearch, { status: "done", scan });
    } catch (err) {
      if (seq !== ssearch.seq || err.name === "AbortError") return;
      Object.assign(ssearch, { status: "error", error: err.message });
    }
    ssearch.ctrl = null;
    renderDialogs();
  }, 350);
}

/** The title of a list: favourites and song searches are named in the chosen language. */
function scanTitle(scan) {
  if (scan?.fav) return t("Bài hát yêu thích");
  if (scan?.search) return t("Tìm: “{q}”", { q: scan.query });
  if (scan?.playlist) return playlistById(scan.playlist)?.name || scan.title || "";
  return scan?.title || "";
}

/** The songs part of the search results: every song found, more read as the sidebar scrolls to its end. */
function renderSongResults() {
  const head = `<div class="dialog-section">${t("Bài hát")}</div>`;
  const q = $("dialogSearch").value.trim();
  if (ssearch.q !== q || ssearch.status === "loading" || ssearch.status === "idle")
    return `${head}<div class="dialog-note"><span class="spinner-border spinner-border-sm"></span> ${t("Đang tìm…")}</div>`;
  if (ssearch.status === "error") return `${head}<div class="dialog-note">${esc(ssearch.error)}</div>`;
  const songs = ssearch.scan.files.filter(playable);
  if (!songs.length) return `${head}<div class="dialog-note">${t("Không tìm thấy bài hát")}</div>`;
  const n = `${songs.length}${ssearch.scan.more ? "+" : ""}`;
  // like Telegram's "72 messages found": how many Telegram counted (else what is loaded, "50+")
  const found = ssearch.scan.total ? ssearch.scan.total.toLocaleString(tdlI18n.locale) : n;
  return (
    `<div class="dialog-section">${t("Tìm thấy {n} bài hát", { n: found })}</div>` +
    songs
      .map((f) => {
        // like Telegram's "messages found": the chat (avatar, name, date), then the song with the words found
        const chat = chatOfSong(f);
        const date = f.date
          ? new Date(f.date * 1000).toLocaleDateString(tdlI18n.locale, {
              day: "2-digit",
              month: "2-digit",
              year: "2-digit",
            })
          : "";
        const song = `${f.title || f.name}${f.title && f.performer ? ` – ${f.performer}` : ""}`;
        return `<a class="list-group-item list-group-item-action dialog-item song-item d-flex align-items-center gap-2" data-song="${f.id}" title="${esc(displayName(f))}">
      ${dialogAvatar({ id: chat?.id || String(f.fav || "").split("|")[0], title: f.chat || "", photo: chat?.photo })}
      <span class="min-w-0 side-text flex-grow-1">
        <span class="d-flex align-items-center gap-2 min-w-0"><span class="text-truncate fw-semibold"><i class="bi ${TYPE_ICON[chat?.type] || "bi-megaphone"}"></i> ${esc(f.chat || "")}</span><small class="song-date ms-auto flex-none">${date}</small></span>
        <small class="d-flex align-items-center gap-1 min-w-0 song-line"><span class="song-play" role="button" data-song-play title="${t("Phát")}"><i class="bi bi-play-circle"></i></span><span class="text-truncate">${markWords(song, $("dialogSearch").value)}</span></small>
      </span></a>`;
      })
      .join("") +
    (ssearch.loadingMore
      ? `<div class="dialog-note"><span class="spinner-border spinner-border-sm"></span> ${t("Đang tải thêm…")}</div>`
      : "")
  );
}

/** The next page of found songs (50), when the sidebar is scrolled near its end; they join the queue too. */
async function loadMoreSongs() {
  const scan = ssearch.scan;
  if (!scan?.more || ssearch.loadingMore || ssearch.status !== "done") return;
  const seq = ssearch.seq;
  ssearch.loadingMore = true;
  renderDialogs();
  try {
    const r = await api(`/api/files/more?key=${encodeURIComponent(scan.key)}`);
    if (seq !== ssearch.seq || ssearch.scan !== scan) return;
    const have = new Set(scan.files.map((f) => f.id));
    const added = r.files.filter((f) => !have.has(f.id));
    scan.files.push(...added);
    scan.more = r.more;
    if (state.playScan === scan) {
      // playing from these results: the new songs come after the others
      const ids = added.filter(playable).map((f) => f.id);
      state.playQueue.push(...ids);
      state.playOrder.push(...ids);
      updateNavButtons();
    }
  } catch {
    scan.more = false; // not important enough for an error: what is there stays
  } finally {
    if (seq === ssearch.seq) {
      ssearch.loadingMore = false;
      renderDialogs();
    }
  }
}
$("dialogs").addEventListener(
  "scroll",
  (e) => {
    const el = e.currentTarget;
    if (globalSearchActive() && el.scrollTop + el.clientHeight >= el.scrollHeight - 300) loadMoreSongs();
  },
  { passive: true },
);

/** The chat (from the account's list) a song of the search results comes from, or undefined. */
function chatOfSong(f) {
  const raw = String(f.fav || "").split("|")[0];
  return raw ? state.dialogs.find((d) => [raw, `-${raw}`, `-100${raw}`].includes(d.id)) : undefined;
}

/** `text` escaped, with the searched words (accents and case ignored) marked like Telegram does. */
function markWords(text, q) {
  const plain = [...String(text)].map((c) => norm(c) || c); // one entry per character: positions stay the same
  const flat = plain.join("");
  const marks = new Array(plain.length).fill(false);
  for (const word of norm(q)
    .split(/\s+/)
    .filter((w) => w.length >= 2)) {
    // where each character starts in `flat` (a normalized character can be 0 or 2 letters long)
    let at = 0;
    const starts = plain.map((c) => ((at += c.length), at - c.length));
    for (let i = flat.indexOf(word); i >= 0; i = flat.indexOf(word, i + 1))
      starts.forEach((st, k) => st >= i && st < i + word.length && (marks[k] = true));
  }
  let out = "";
  [...String(text)].forEach((c, k) => {
    if (marks[k] && !marks[k - 1]) out += '<mark class="song-hit">';
    out += esc(c);
    if (marks[k] && !marks[k + 1]) out += "</mark>";
  });
  return out;
}

/** ▶ / ⏸ and the highlight on the song rows of the search results (the player changed). */
function updateSongRows() {
  const key = ssearch.scan?.key;
  for (const row of $("dialogs").querySelectorAll("[data-song]")) {
    const on = !!key && state.playingKey === key && state.playingId === Number(row.dataset.song);
    row.classList.toggle("playing", on);
    row.querySelector(".song-play").innerHTML =
      `<i class="bi ${on && state.isPlaying ? "bi-pause-circle-fill" : on ? "bi-play-circle-fill" : "bi-play-circle"}"></i>`;
  }
}

/** A song of the results: the whole result list becomes the queue, from that song (the open list stays). */
function playSearchSong(id) {
  const scan = ssearch.scan;
  if (!scan) return;
  if (state.playingKey === scan.key && state.playingId === id && state.playScan === scan) return togglePlay();
  state.keyChat.set(scan.key, SEARCH_CHAT + scan.query); // the player's title opens this list
  state.playQueue = scan.files.filter(playable).map((f) => f.id);
  state.playOrder = orderFrom(id);
  playFrom(scan, id);
  updateSongRows();
}

// ---------- choosing the chats shown in the list (per Telegram account) ----------

let chatsDraft = null; // Set of chat ids being edited

function renderChatsModal() {
  const q = norm($("chatsSearch").value.trim());
  const list = sortDialogs(
    state.dialogs.filter((d) => !q || norm(d.title).includes(q) || norm(d.username).includes(q)),
  );
  $("chatsCount").textContent = t("Đã chọn {n}/{total}", {
    n: state.dialogs.filter((d) => chatsDraft.has(d.id)).length,
    total: state.dialogs.length,
  });
  $("chatsList").innerHTML = list.length
    ? list
        .map(
          (d) => `
    <label class="list-group-item list-group-item-action d-flex align-items-center gap-2 chats-row">
      <input class="form-check-input flex-none m-0" type="checkbox" data-chat="${esc(d.id)}" ${chatsDraft.has(d.id) ? "checked" : ""}>
      ${dialogAvatar(d)}
      <span class="min-w-0"><span class="d-block text-truncate">${esc(d.title)}</span>
      <small class="d-block text-truncate text-body-secondary">${dialogSub(d)}</small></span></label>`,
        )
        .join("")
    : `<div class="text-body-secondary small p-3">${t("Không có hội thoại nào khớp.")}</div>`;
}

async function openChatsModal() {
  if (!state.dialogs.length) await loadDialogs();
  await hideOpenModals();
  chatsDraft = new Set(state.visibleChats || state.dialogs.map((d) => d.id));
  $("chatsSearch").value = "";
  renderChatsModal();
  chatsModal.show();
}

/** Is this chat (dialog id, or a username / link typed in the search box) hidden by the filter? */
function isHiddenChat(chat) {
  if (!state.visibleChats || !chat) return false;
  const name = String(chat)
    .replace(/^(https?:\/\/)?(t\.me\/|telegram\.me\/)?@?/i, "")
    .toLowerCase();
  const d = state.dialogs.find((x) => x.id === chat || (x.username && x.username.toLowerCase() === name));
  return !!d && !state.visibleChats.has(d.id);
}

/**
 * After the filter changed: whatever belongs to a chat that is now hidden stops — the open chat goes
 * back to the start screen, its song stops playing, its queued and running downloads are cancelled.
 * Returns what was stopped, for the message.
 */
async function stopHiddenChats() {
  const hiddenKeys = new Set([...state.keyChat].filter(([, chat]) => isHiddenChat(chat)).map(([key]) => key));
  const stopped = [];
  if (isHiddenChat(state.chat)) {
    stopped.push(t("đóng “{title}”", { title: state.scan?.title || $("chatTitle").textContent }));
    state.loadToken++; // a scan still in flight must not reopen it
    stopScan();
    setScanning(false);
    state.chat = null;
    state.scan = null;
    state.selected.clear();
    state.dlTarget = null;
    showChat(false);
    setView("chats", false);
    if (history.state?.view === "files") history.replaceState(null, "");
    updateSelection();
  }
  if (state.playingKey && hiddenKeys.has(state.playingKey)) {
    stopPlayer();
    stopped.push(t("dừng phát nhạc"));
  }
  const busy = [...state.jobs.values()].some(
    (j) => hiddenKeys.has(j.scanKey) && ["queued", "downloading"].includes(j.status),
  );
  if (busy) {
    try {
      const r = await api("/api/cancel", { keys: [...hiddenKeys] });
      if (r.cancelled) stopped.push(t("huỷ {n} file đang tải", { n: r.cancelled }));
    } catch (err) {
      toast(err.message, "error");
    }
  }
  return stopped;
}

async function saveVisibleChats(ids) {
  try {
    const r = await api("/api/visible-chats", { ids });
    state.visibleChats = r.ids ? new Set(r.ids) : null;
    chatsModal.hide();
    const stopped = await stopHiddenChats();
    renderDialogs();
    renderChatsInfo();
    const saved = r.ids
      ? t("Đã lưu: hiện {n}/{total} hội thoại", { n: shownDialogs().length, total: state.dialogs.length })
      : t("Đã bỏ lọc: hiện tất cả hội thoại");
    toast(
      stopped.length ? t("{saved}. Hội thoại bị ẩn: {stopped}.", { saved, stopped: stopped.join(", ") }) : saved,
      stopped.length ? "info" : "success",
    );
  } catch (err) {
    toast(err.message, "error");
  }
}

$("setChatsBtn").addEventListener("click", openChatsModal);
$("chatsBar").addEventListener("click", (e) => {
  const sort = e.target.closest("[data-dialog-sort]");
  if (sort) return setDialogSort(sort.dataset.dialogSort);
  if (e.target.closest("[data-chats-edit]")) openChatsModal();
});
$("dialogs").addEventListener("click", (e) => {
  if (!e.target.closest("[data-chats-edit]")) return;
  e.preventDefault();
  openChatsModal();
});
$("chatsSearch").addEventListener("input", renderChatsModal);
$("chatsList").addEventListener("change", (e) => {
  const id = e.target.dataset.chat;
  if (!id) return;
  if (e.target.checked) chatsDraft.add(id);
  else chatsDraft.delete(id);
  renderChatsModal();
});
/** "Chọn tất cả" / "Bỏ hết" act on the chats matching the search box. */
function setDraftForMatches(on) {
  const q = norm($("chatsSearch").value.trim());
  for (const d of state.dialogs) {
    if (q && !norm(d.title).includes(q) && !norm(d.username).includes(q)) continue;
    if (on) chatsDraft.add(d.id);
    else chatsDraft.delete(d.id);
  }
  renderChatsModal();
}
$("chatsAll").addEventListener("click", () => setDraftForMatches(true));
$("chatsNone").addEventListener("click", () => setDraftForMatches(false));
$("chatsSave").addEventListener("click", () =>
  saveVisibleChats(state.dialogs.filter((d) => chatsDraft.has(d.id)).map((d) => d.id)),
);
$("chatsReset").addEventListener("click", () => saveVisibleChats(null));

/** One-line summary in Settings. */
function renderChatsInfo() {
  $("setChatsInfo").textContent = !state.dialogs.length
    ? t("Đăng nhập để chọn")
    : state.visibleChats
      ? t("Đang hiện {n}/{total} hội thoại", { n: shownDialogs().length, total: state.dialogs.length })
      : t("Hiện tất cả ({n} hội thoại)", { n: state.dialogs.length });
}

$("dialogSearch").addEventListener("input", () => {
  scheduleGlobalSearch();
  scheduleSongSearch();
  renderDialogs();
});
/** A t.me / telegram.me link, tg:// link or @username: Enter opens it. Anything else is only searched. */
const isChatLink = (text) => /^(https?:\/\/)?(t|telegram)\.me\/\S+|^tg:\/\/\S+|^@[a-z]\w{3,31}$/i.test(text);

$("dialogSearch").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const text = e.target.value.trim();
  if (isChatLink(text)) return openChat(text);
  if (isPhone()) e.target.blur(); // a search stays in the list here; on a phone, put the keyboard away to see it
});
$("dialogs").addEventListener("click", (e) => {
  const song = e.target.closest("[data-song]");
  if (song) {
    e.preventDefault();
    const id = Number(song.dataset.song);
    if (e.target.closest("[data-song-play]")) return playSearchSong(id); // ▶: play it here, the results as the queue
    // like Telegram: the song in its own chat, scrolled to and flashed (as a tap on the playing song's name)
    const f = ssearch.scan?.files.find((x) => x.id === id);
    if (f) showSongInItsChat(f);
    return;
  }
  const join = e.target.closest("[data-join]");
  if (join) {
    e.preventDefault();
    const r = gsearch.chats[Number(join.dataset.join)];
    return r && joinGlobalResult(r);
  }
  const el = e.target.closest(".dialog-item");
  if (!el || e.target.closest(".dialog-join")) return;
  if (el.dataset.global !== undefined) {
    const r = gsearch.chats[Number(el.dataset.global)];
    return r && openGlobalResult(r);
  }
  openChat(el.dataset.id);
});

// ---------- files ----------

function showChat(on) {
  $("plView").classList.add("d-none");
  $("plView").classList.remove("d-flex");
  show($("emptyView"), !on);
  $("emptyView").classList.toggle("d-flex", !on);
  $("chatView").classList.toggle("d-none", !on);
  $("chatView").classList.toggle("d-flex", on);
}

function openChat(chat) {
  setView("files");
  setRailOpen(false); // the rail closes once a chat is picked
  state.chat = chat;
  state.selected.clear();
  state.query = "";
  $("fileSearch").value = "";
  state.dupOnly = false; // another list: all its files
  $("dupBtn").classList.remove("active");
  $("dupBtn").setAttribute("aria-pressed", "false");
  renderDialogs();
  if (chat === PL_HOME) return showPlaylists();
  return loadFiles();
}

function setMessage(html) {
  $("files").innerHTML = "";
  $("filesMsg").innerHTML = html ? `<div class="text-center text-body-secondary p-5">${html}</div>` : "";
}

/** While a chat is being scanned the "Quét lại" button is locked (and spins), so it cannot be spammed. */
function setScanning(on) {
  state.scanning = on;
  const b = $("reloadBtn");
  b.disabled = on;
  b.classList.toggle("is-scanning", on);
  b.title = on ? t("Đang quét kênh…") : t("Quét lại");
}

/** Stop the chat scan in progress (another chat / type was chosen, or the chat was closed). */
function stopScan() {
  state.scanCtrl?.abort();
  state.scanCtrl = null;
}

// ---------- the line under a chat's title: its subscribers / members, like Telegram ----------

const chatMembers = new Map(); // chat (dialog id / username, as state.chat) -> { members, type, at }

/** "2.402 người theo dõi" / "35 thành viên" for a chat, or "" (not known yet, a person, favourites, a search). */
function membersText(chat) {
  const info = chatMembers.get(chat);
  if (!info?.members) return "";
  const n = info.members.toLocaleString(tdlI18n.locale);
  return info.type === "channel" ? t("{n} người theo dõi", { n }) : t("{n} thành viên", { n });
}

function renderMembers() {
  $("chatMembers").textContent = membersText(state.chat);
}

/** Asked once per chat every 10 minutes (Telegram's full info is a heavier call than the list). */
async function loadMembers(chat) {
  const known = chatMembers.get(chat);
  if (known && Date.now() - known.at < 600_000) return;
  try {
    const info = await api(`/api/chat-info?chat=${encodeURIComponent(chat)}`);
    chatMembers.set(chat, { members: info.members, type: info.type, at: Date.now() });
  } catch {
    return; // not important enough for an error: the line stays empty
  }
  if (state.chat === chat) renderMembers();
}

/** `fresh`: ask again ("Quét lại"); otherwise a song search already in memory is shown as it is. */
async function loadFiles({ fresh = false } = {}) {
  const token = ++state.loadToken;
  stopScan(); // the previous chat's scan stops in the server / backend too, not just ignored here
  $("chatView").classList.toggle("fav-view", state.chat === FAV_CHAT); // no type filter there: all kinds, newest heart first
  const search = isSearchChat(state.chat) ? state.chat.slice(SEARCH_CHAT.length) : null;
  $("chatView").classList.toggle("search-view", search !== null); // songs only, from every chat
  const plId = isPlChat(state.chat) ? state.chat.slice(PL_PREFIX.length) : null;
  $("chatView").classList.toggle("pl-view", plId !== null); // a playlist: its order, its tools
  const ctrl = (state.scanCtrl = new AbortController());
  setScanning(true);
  showChat(true);
  const dialog = state.dialogs.find((d) => d.id === state.chat);
  $("chatTitle").textContent =
    state.chat === FAV_CHAT
      ? t("Bài hát yêu thích")
      : plId !== null
        ? playlistById(plId)?.name || t("Playlist")
        : search !== null
          ? t("Tìm: “{q}”", { q: search })
          : dialog?.title || state.chat;
  // the header is the new chat's at once: its members (known, or asked now beside the scan), no old count
  const plainChat = state.chat !== FAV_CHAT && search === null && plId === null;
  renderMembers();
  if (plainChat) loadMembers(state.chat);
  $("chatSub").textContent = "";
  document
    .querySelectorAll("#typeSeg button")
    .forEach((b) => b.classList.toggle("active", b.dataset.type === state.type));
  setMessage(`<div class="spinner-border text-primary"></div><p class="mt-2" id="scanMsg">${t("Đang quét kênh…")}</p>`);
  $("fileCount").textContent = "";
  state.scan = null;
  updateSelection();
  try {
    state.scanId = `${PAGE_ID}-${token}`; // progress events carry it: only this scan's count is shown
    // the results under the search box (or the list playing) are the same list: shown without asking again
    const known =
      search !== null && !fresh && [state.playScan, ssearch.scan].find((s) => s?.search && s.query === search);
    const scan = known
      ? known
      : state.chat === FAV_CHAT
        ? await api(`/api/favorites/files?scan=${state.scanId}`, undefined, { signal: ctrl.signal })
        : plId !== null
          ? await api(`/api/playlists/files?id=${encodeURIComponent(plId)}&scan=${state.scanId}`, undefined, {
              signal: ctrl.signal,
            })
          : search !== null
            ? await api(`/api/search/songs?q=${encodeURIComponent(search)}&scan=${state.scanId}`, undefined, {
                signal: ctrl.signal,
              })
            : await api(
                `/api/files?chat=${encodeURIComponent(state.chat)}&type=${state.type}&scan=${state.scanId}`,
                undefined,
                { signal: ctrl.signal },
              );
    if (token !== state.loadToken) return;
    state.scan = scan;
    state.keyChat.set(scan.key, state.chat);
    $("chatTitle").textContent = scanTitle(scan);
    renderFiles();
    if (scan.missing)
      toast(
        scan.playlist
          ? t("{n} bài trong playlist không còn mở được (đã rời kênh hoặc tin đã bị xoá)", { n: scan.missing })
          : t("{n} bài yêu thích không còn mở được (đã rời kênh hoặc tin đã bị xoá)", { n: scan.missing }),
        "warn",
      );
  } catch (err) {
    if (token !== state.loadToken) return;
    setMessage(
      `<i class="bi bi-exclamation-triangle display-5 text-warning"></i><p class="mt-2">${esc(err.message)}</p>`,
    );
  } finally {
    if (token === state.loadToken) setScanning(false); // a newer scan (another chat / type) keeps it locked
  }
}

function jobFor(id) {
  return state.scan && state.jobs.get(`${state.scan.key}|${id}`);
}

/** `withSearch: false`: the list as if the search box were empty (other filters and the sort still apply). */
function visibleFiles({ withSearch = true } = {}) {
  if (!state.scan) return [];
  const q = withSearch ? norm(state.query.trim()) : "";
  const list = state.scan.files.filter(
    (f) =>
      (!q || norm(`${f.name} ${f.title || ""} ${f.performer || ""}`).includes(q)) &&
      (!state.scan.fav ||
        (state.favorites.has(f.fav) && // "Bài hát yêu thích": an un-hearted file leaves the list
          (state.favScope === "all" || f.fav.split("|")[0] === state.favScope))) &&
      (!state.scan.playlist || inPlaylist(f, state.scan)) && // a playlist: a song taken out leaves the list
      !state.hidden.has(favId(f)), // ③ hidden for this visit
  );
  return state.dupOnly ? duplicates(sortFiles(list)) : sortFiles(list);
}

// ---------- "Lọc trùng": the files posted more than once, each group together, then the extra copies ticked ----------

/** The same song posted again: the same size and length (or name, for a file without a length). */
const dupKey = (f) => `${f.size}|${f.duration ?? norm(f.name)}`;

let dupShade = new Set(); // the rows of every other group, shaded (renderFiles)
let dupExtra = 0; // the copies but the first of each group: what ② ticks (renderFiles)

/** ① Lọc trùng → ② Chọn bản thừa (once there are copies) → ③ what to do with the ticked ones (once some are). */
function renderDupSteps() {
  const two = !!state.dupOnly && dupExtra > 0;
  const three = two && state.selected.size > 0;
  show($("dupArrow1"), two);
  show($("dupPickBtn"), two);
  $("dupExtra").textContent = dupExtra;
  show($("dupArrow2"), three);
  show($("dupHideBtn"), three);
  const here = hiddenHere().length; // this list's only: another chat's hidden songs are not shown here
  show($("unhideBtn"), here > 0);
  $("unhideText").textContent = t("Hiện lại {n} bài đã ẩn", { n: here });
}

// ③ the ticked songs leave the list and the songs to play, for this visit only (never saved: a reload shows them)
$("dupHideBtn").addEventListener("click", () => {
  const files = state.scan ? state.scan.files.filter((f) => state.selected.has(f.id)) : [];
  for (const f of files) state.hidden.add(favId(f));
  // done: ① off, the whole list again (without them)
  state.dupOnly = false;
  $("dupBtn").classList.remove("active");
  $("dupBtn").setAttribute("aria-pressed", "false");
  state.selected.clear();
  afterHidden();
  toast(t("Đã ẩn {n} bài khỏi danh sách phát — tải lại trang để hiện lại", { n: files.length }), "info");
});
$("unhideBtn").addEventListener("click", () => {
  for (const k of hiddenHere()) state.hidden.delete(k);
  afterHidden();
});
/** The songs of the open list hidden by ③ (their "<chat>|<message>"). */
function hiddenHere() {
  if (!state.scan || !state.hidden.size) return [];
  return [...new Set(state.scan.files.map((f) => favId(f)))].filter((k) => state.hidden.has(k));
}
function afterHidden() {
  if (state.scan) renderFiles();
  else updateSelection();
  updateNavButtons(); // ⏭ follows (liveOrder)
}

/** Only the files with a twin in `list`, each group together, in the order of its first file. */
function duplicates(list) {
  const groups = new Map();
  for (const f of list) {
    const k = dupKey(f);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  return [...groups.values()].filter((g) => g.length > 1).flat();
}

function setDupOnly(on) {
  state.dupOnly = on;
  $("dupBtn").classList.toggle("active", on);
  $("dupBtn").setAttribute("aria-pressed", String(on));
  state.selected.clear();
  if (state.scan) renderFiles();
}
$("dupBtn").addEventListener("click", () => setDupOnly(!state.dupOnly));

// every copy but the first of each group (the list's order: by default the newest one stays)
$("dupPickBtn").addEventListener("click", () => {
  const seen = new Set();
  state.selected.clear();
  for (const f of visibleFiles()) {
    const k = dupKey(f);
    if (seen.has(k)) state.selected.add(f.id);
    else seen.add(k);
  }
  renderFiles();
});

const collator = new Intl.Collator("vi", { numeric: true, sensitivity: "base" });
const SORTS = {
  oldest: (a, b) => a.date - b.date || a.id - b.id,
  "name-asc": (a, b) => collator.compare(norm(displayName(a)), norm(displayName(b))),
  "name-desc": (a, b) => collator.compare(norm(displayName(b)), norm(displayName(a))),
  "size-desc": (a, b) => (b.size || 0) - (a.size || 0),
  "size-asc": (a, b) => (a.size || 0) - (b.size || 0),
  // files without a known duration always go last
  "dur-desc": (a, b) => (b.duration ?? -1) - (a.duration ?? -1),
  "dur-asc": (a, b) => (a.duration ?? Infinity) - (b.duration ?? Infinity),
};

/** Sorted copy; "default" keeps the channel order (newest first). Ties keep the channel order. */
function sortFiles(list) {
  const cmp = SORTS[state.sort];
  if (!cmp) return inOwnOrder(state.scan, list); // the order dragged to, when there is one

  const pos = new Map(state.scan.files.map((f, i) => [f.id, i]));
  return [...list].sort((a, b) => cmp(a, b) || pos.get(a.id) - pos.get(b.id));
}

// Column header -> the sort it toggles through.
const HEADER_SORTS = {
  num: ["default", "oldest"],
  name: ["name-asc", "name-desc"],
  size: ["size-desc", "size-asc", "dur-desc", "dur-asc"],
};

function setSort(sort) {
  state.sort = sort;
  $("sortSel").value = sort;
  for (const th of document.querySelectorAll(".file-table th.sortable")) {
    const idx = HEADER_SORTS[th.dataset.sort].indexOf(sort);
    const on = idx >= 0 && !(th.dataset.sort === "num" && sort === "default");
    th.classList.toggle("sorted", on);
    const asc = /asc$|^oldest$/.test(sort);
    th.querySelector(".sort-ico").className =
      `bi sort-ico ${on ? (asc ? "bi-caret-up-fill" : "bi-caret-down-fill") : "bi-chevron-expand"}`;
    if (th.dataset.sort === "size")
      th.firstChild.textContent = `${on && sort.startsWith("dur") ? t("Thời lượng") : t("Dung lượng")} `;
  }
  if (state.scan) renderFiles();
}

$("sortSel").addEventListener("change", (e) => setSort(e.target.value));
document.querySelector(".file-table thead").addEventListener("click", (e) => {
  const th = e.target.closest("th.sortable");
  if (!th) return;
  const cycle = HEADER_SORTS[th.dataset.sort];
  const i = cycle.indexOf(state.sort);
  setSort(cycle[(i + 1) % cycle.length]);
});

function stateCell(f) {
  const job = jobFor(f.id);
  if (job && job.status === "downloading") {
    const pct = job.size ? Math.floor((job.received / job.size) * 100) : 0;
    return `<span class="badge text-bg-primary">${pct}%</span>`;
  }
  if (job && job.status === "queued") return `<span class="badge text-bg-secondary">${t("Đang chờ")}</span>`;
  if (job && job.status === "failed")
    return `<span class="badge text-bg-danger" title="${esc(job.error)}">${t("Lỗi")}</span>`;
  return "";
}

const VISUAL = new Set(["photo", "image", "video"]);

function playCell(f) {
  if (VISUAL.has(f.kind)) {
    const video = f.kind === "video";
    return `<button class="btn btn-sm btn-outline-primary play-btn" data-preview="${f.id}"
      title="${video ? t("Xem trước video (phát trực tiếp từ Telegram, không tải về)") : t("Xem trước ảnh")}">
      <i class="bi ${video ? "bi-play-btn" : "bi-eye"}"></i></button>`;
  }
  if (f.kind === "document") return "";
  const on = state.playingId === f.id && state.isPlaying;
  return `<button class="btn btn-sm ${on ? "btn-primary" : "btn-outline-primary"} play-btn" data-play="${f.id}"
    title="${on ? t("Tạm dừng") : f.downloaded ? t("Phát") : t("Nghe thử (phát trực tiếp từ Telegram, không tải về)")}">
    <i class="bi ${on ? "bi-pause-fill" : "bi-play-fill"}"></i></button>`;
}

// ---------- favourites ----------

/** "<chat id>|<message id>": the same file keeps its heart after a rescan or under another type filter. */
const favId = (f, scan = state.scan) => f.fav ?? `${scan.key.split("|")[0]}|${f.id}`;
const isFav = (f) => !!state.scan && state.favorites.has(favId(f));

function favCell(f) {
  const on = isFav(f);
  return `<button class="btn btn-sm fav-btn${on ? " on" : ""}" data-fav="${f.id}" aria-pressed="${on}"
    title="${on ? t("Bỏ khỏi yêu thích") : t("Thêm vào yêu thích")}"><i class="bi ${on ? "bi-heart-fill" : "bi-heart"}"></i></button>`;
}

/** ♥ on / off for a file of a list (the open one, or the one the player is playing from). */
async function toggleFav(id, scan = state.scan) {
  const f = scan?.files.find((x) => x.id === id);
  if (!f) return;
  const key = favId(f, scan);
  const on = !state.favorites.has(key);
  on ? state.favorites.add(key) : state.favorites.delete(key); // instant; undone if saving fails
  refreshFavViews(id, scan);
  try {
    state.favorites = new Set((await api("/api/favorites", { id: key, on })).ids);
    toast(
      on
        ? t("Đã thêm “{name}” vào yêu thích", { name: displayName(f) })
        : t("Đã bỏ “{name}” khỏi yêu thích", { name: displayName(f) }),
      on ? "bye" : "info",
    );
  } catch (err) {
    on ? state.favorites.delete(key) : state.favorites.add(key);
    toast(err.message, "error");
  }
  refreshFavViews(id, scan);
}

/** ♥ for the ticked files (above the list): all of them, or none when all of them already are. */
async function favSelected() {
  const scan = state.scan;
  const files = scan ? scan.files.filter((f) => state.selected.has(f.id)) : [];
  if (!files.length) return;
  const on = !files.every(isFav);
  const keys = files.map((f) => favId(f, scan)).filter((k) => state.favorites.has(k) !== on);
  const before = new Set(state.favorites);
  for (const k of keys) on ? state.favorites.add(k) : state.favorites.delete(k); // instant; undone if saving fails
  // "Bài hát yêu thích": the un-hearted ones leave the list, and the selection
  if (scan.fav && !on) for (const f of files) state.selected.delete(f.id);
  refreshFavList();
  try {
    state.favorites = new Set((await api("/api/favorites", { ids: keys, on })).ids);
    toast(
      on
        ? t("Đã thêm {n} bài vào yêu thích", { n: keys.length })
        : t("Đã bỏ {n} bài khỏi yêu thích", { n: keys.length }),
      on ? "bye" : "info",
    );
  } catch (err) {
    state.favorites = before;
    toast(err.message, "error");
  }
  refreshFavList();
}
$("favSelBtn").addEventListener("click", favSelected);

/** After several hearts changed: the whole open list, the sidebar count, the player, the button above the list. */
function refreshFavList() {
  if (state.playScan?.fav) updateNavButtons();
  if (state.scan) renderFiles();
  renderFavEntry();
  renderPlayerFav();
  updateSelection();
}

/** After a heart changed: the open list (its row, or all of "Bài hát yêu thích"), the sidebar count, the player. */
function refreshFavViews(id, scan = state.scan) {
  if (state.playScan?.fav) updateNavButtons(); // "Bài hát yêu thích" playing: ⏭ follows the hearts (liveOrder)
  if (state.scan?.fav) renderFiles();
  else if (state.scan && scan?.key === state.scan.key) updateRow(id);
  renderFavEntry();
  renderPlayerFav();
}

/** ♥ in the player: the song that is playing. */
function renderPlayerFav() {
  const f = state.playScan?.files.find((x) => x.id === state.playingId);
  const on = !!f && state.favorites.has(favId(f, state.playScan));
  const b = $("playerFav");
  b.disabled = !f;
  b.classList.toggle("on", on);
  b.setAttribute("aria-pressed", String(on));
  b.innerHTML = `<i class="bi ${on ? "bi-heart-fill" : "bi-heart"}"></i>`;
  b.setAttribute("data-bs-original-title", on ? t("Bỏ khỏi yêu thích") : t("Thêm vào yêu thích"));
  b.removeAttribute("title");
}
$("playerFav").addEventListener("click", () => state.playScan && toggleFav(state.playingId, state.playScan));

/** "Bài hát yêu thích" at the top of the sidebar: count + highlighted while open. */
function renderFavEntry() {
  const active = state.chat === FAV_CHAT;
  $("favEntry").classList.toggle("active", active);
  $("favEntrySub").classList.toggle("text-body-secondary", !active);
  $("favEntrySub").innerHTML =
    `<i class="bi bi-music-note-beamed"></i> ${t("{n} bài · từ mọi kênh", { n: state.favorites.size })}`;
}

$("favEntry").addEventListener("click", (e) => {
  e.preventDefault();
  openChat(FAV_CHAT);
});
$("favEntry").title = t("Bài hát yêu thích");

// ---------- playlists (like Zing MP3's): made by the user, songs from any chat, in the order chosen ----------
// The list of them is a grid of covers (state.chat = PL_HOME); one playlist opens like the favourites
// (state.chat = "pl:<id>"). Shared by every device of the account (core.js editPlaylists, MongoDB "playlists").

const PL_HOME = "playlists";
const PL_PREFIX = "pl:";
function isPlChat(chat) {
  return typeof chat === "string" && chat.startsWith(PL_PREFIX);
}
function playlistById(id) {
  return state.playlists.find((p) => p.id === id) || null;
}
/** The playlist open in the list, or null. */
function openPlaylist() {
  return isPlChat(state.chat) ? playlistById(state.chat.slice(PL_PREFIX.length)) : null;
}
/** Is this file of a playlist's list still in it (taken out here or on another device: it leaves the list)? */
function inPlaylist(f, scan) {
  const p = playlistById(scan.playlist);
  return !!p && p.songs.includes(favId(f, scan));
}

let sharesChecked = false; // links whose upload stopped half-way (tab closed) go on once the playlists are known

async function loadPlaylists() {
  try {
    state.playlists = (await api("/api/playlists")).playlists || [];
  } catch {
    return; // offline: the ones known stay
  }
  if (CAPS.share && !sharesChecked) {
    sharesChecked = true;
    loadShares().catch(() => (sharesChecked = false));
  }
  afterPlaylistsChanged();
}

/** "Playlist" under the favourites: how many, highlighted while the grid or one of them is open. */
function renderPlEntry() {
  const active = state.chat === PL_HOME || isPlChat(state.chat);
  $("plEntry").classList.toggle("active", active);
  $("plEntrySub").classList.toggle("text-body-secondary", !active);
  $("plEntrySub").innerHTML =
    `<i class="bi bi-collection-play"></i> ${t("{n} playlist", { n: state.playlists.length })}`;
}
$("plEntry").addEventListener("click", (e) => {
  e.preventDefault();
  openChat(PL_HOME);
});
$("plEntry").title = t("Playlist");

const rawChatId = (id) => String(id).replace(/^-(100)?/, "");

/** A cover: the pictures of the chats of its first songs, 2x2 (one big picture when fewer than 4 chats). */
function plCover(p, extra = "") {
  const byRaw = new Map(state.dialogs.map((d) => [rawChatId(d.id), d]));
  const chats = [];
  for (const song of p.songs) {
    const d = byRaw.get(song.split("|")[0]);
    if (d && !chats.includes(d)) chats.push(d);
    if (chats.length === 4) break;
  }
  if (!chats.length)
    return `<div class="pl-cover"><span class="pl-cover-empty"><i class="bi bi-music-note-list"></i></span>${extra}</div>`;
  const tiles = chats.length < 4 ? [chats[0]] : chats;
  return `<div class="pl-cover${tiles.length === 1 ? " one" : ""}">${tiles.map(dialogAvatar).join("")}${extra}</div>`;
}

function renderPlGrid() {
  $("plCount").textContent = t("{n} playlist", { n: state.playlists.length });
  $("plGrid").innerHTML =
    `<div class="pl-card pl-new" data-pl-new role="button" tabindex="0">
      <div class="pl-cover"><i class="bi bi-plus-circle"></i><span>${t("Tạo playlist mới")}</span></div></div>` +
    state.playlists
      .map(
        (p) => `<div class="pl-card" data-pl="${esc(p.id)}" role="button" tabindex="0" title="${esc(p.name)}">
      ${plCover(p, p.songs.length ? `<button class="pl-cover-play" type="button" data-pl-play="${esc(p.id)}" title="${t("Phát")}" aria-label="${t("Phát")}"><i class="bi bi-play-fill"></i></button>` : "")}
      <div class="dropdown pl-menu">
        <button class="btn" type="button" data-bs-toggle="dropdown" aria-expanded="false" aria-label="${t("Tuỳ chọn")}"><i class="bi bi-three-dots"></i></button>
        <ul class="dropdown-menu dropdown-menu-end shadow-sm">
          ${CAPS.share ? `<li><button class="dropdown-item" type="button" data-pl-share="${esc(p.id)}"><i class="bi bi-share"></i> ${t("Chia sẻ")}</button></li>` : ""}
          <li><button class="dropdown-item" type="button" data-pl-rename="${esc(p.id)}"><i class="bi bi-pencil"></i> ${t("Đổi tên")}</button></li>
          <li><button class="dropdown-item text-danger" type="button" data-pl-delete="${esc(p.id)}"><i class="bi bi-trash3"></i> ${t("Xoá playlist")}</button></li>
        </ul>
      </div>
      <div class="pl-name">${esc(p.name)}</div>
      <div class="pl-sub">${t("{n} bài", { n: p.songs.length })}${plSizeText(p)}</div></div>`,
      )
      .join("");
  fillPlSizes();
}

// ---------- the size of a playlist: its songs' sizes, kept in this browser (a playlist holds only their ids) ----------
// Filled from every list shown (a chat, the favourites, a playlist); a playlist with songs not known yet is read in
// the background, one at a time, once per change of it.

const SIZES_MAX = 20000; // songs kept (the oldest go first)
const songSizes = (() => {
  let acct = null;
  let map = new Map();
  let timer = null;
  const key = () => `songSizes:${acct}`;
  // ids of private chats' messages are the account's own: one cache per account
  const cache = () => {
    const id = state.auth?.me?.id || "";
    if (id !== acct) {
      acct = id;
      try {
        map = new Map(Object.entries(JSON.parse(localStorage.getItem(key()) || "{}")));
      } catch {
        map = new Map();
      }
    }
    return map;
  };
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        localStorage.setItem(key(), JSON.stringify(Object.fromEntries([...map].slice(-SIZES_MAX))));
      } catch {
        // full or blocked: known for this visit only
      }
    }, 1000);
  };
  return {
    get: (ref) => cache().get(ref),
    /** true when it changed */
    set(ref, size) {
      const m = cache();
      if (m.get(ref) === size) return false;
      m.delete(ref);
      m.set(ref, size);
      save();
      return true;
    },
  };
})();

/** A playlist's size in bytes, or null while a song's is not known. */
function plSize(p) {
  let n = 0;
  for (const ref of p.songs) {
    const size = songSizes.get(ref);
    if (size === undefined) return null;
    n += size;
  }
  return n;
}

/** The sizes of the songs of a list (only those not seen yet); a playlist's songs gone from Telegram count 0. */
function rememberSizes(scan) {
  if (!scan?.files) return;
  const songsOnly = !scan.fav && !scan.playlist && !scan.recent; // a chat: its photos, videos… are not kept
  let changed = false;
  for (let i = scan.sizedUpTo || 0; i < scan.files.length; i++) {
    const f = scan.files[i];
    if (f.size && (!songsOnly || f.kind === "audio")) changed = songSizes.set(favId(f, scan), f.size) || changed;
  }
  scan.sizedUpTo = scan.files.length;
  if (scan.playlist && !scan.sizedMissing) {
    scan.sizedMissing = true;
    const found = new Set(scan.files.map((f) => f.fav));
    for (const ref of playlistById(scan.playlist)?.songs || [])
      if (!found.has(ref)) changed = songSizes.set(ref, 0) || changed;
  }
  if (changed && state.chat === PL_HOME) renderPlGrid();
}

const SIZING_RETRY_MS = 30_000;
const sizing = { tried: new Set(), busy: false, retry: null };
async function fillPlSizes() {
  // the grid is drawn from what was known before Telegram is connected: read once signed in
  if (sizing.busy || state.auth?.step !== "ready") return;
  const p = state.playlists.find((x) => plSize(x) === null && !sizing.tried.has(`${x.id}:${x.up}`));
  if (!p) return;
  const key = `${p.id}:${p.up}`;
  sizing.busy = true;
  sizing.tried.add(key);
  let failed = false;
  try {
    rememberSizes(await api(`/api/playlists/files?id=${encodeURIComponent(p.id)}`));
  } catch {
    failed = true; // offline, Telegram busy (flood wait): tried again a little later
    sizing.tried.delete(key);
  } finally {
    sizing.busy = false;
  }
  clearTimeout(sizing.retry);
  if (failed) sizing.retry = setTimeout(() => state.chat === PL_HOME && renderPlGrid(), SIZING_RETRY_MS);
  else if (state.chat === PL_HOME) renderPlGrid(); // the next one
}

/** " · 85.3 MB" under a playlist's cover; " · …" while its songs' sizes are being read. */
function plSizeText(p) {
  if (!p.songs.length) return "";
  const size = plSize(p);
  if (size === null) return state.auth?.step === "ready" ? " · …" : "";
  return size ? ` · ${fmt(size)}` : "";
}

$("plGrid").addEventListener("click", (e) => {
  const el = (sel) => e.target.closest(sel);
  if (el("[data-pl-new]")) return void createPlaylist();
  if (el("[data-pl-play]")) return void playPlaylist(el("[data-pl-play]").dataset.plPlay);
  if (el("[data-pl-share]")) return void openShare(el("[data-pl-share]").dataset.plShare);
  if (el("[data-pl-rename]")) return void renamePlaylist(el("[data-pl-rename]").dataset.plRename);
  if (el("[data-pl-delete]")) return void deletePlaylist(el("[data-pl-delete]").dataset.plDelete);
  if (el(".pl-menu")) return; // the ⋯ button
  const card = el("[data-pl]");
  if (card) openChat(PL_PREFIX + card.dataset.pl);
});
$("plGrid").addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches(".pl-card")) {
    e.preventDefault();
    e.target.click();
  }
});
$("plBackBtn").addEventListener("click", () => (history.state?.view === "files" ? history.back() : setView("chats")));

/** The grid in the main pane (instead of a list). */
function showPlaylists() {
  state.loadToken++; // a list still being read is dropped
  stopScan();
  setScanning(false);
  state.scan = null;
  state.selected.clear();
  $("chatView").classList.remove("fav-view", "search-view", "pl-view");
  showChat(false);
  show($("emptyView"), false);
  $("emptyView").classList.remove("d-flex");
  $("plView").classList.remove("d-none");
  $("plView").classList.add("d-flex");
  renderPlGrid();
  updateSelection();
  loadPlaylists();
}

/** One change (core.js editPlaylists), then everything showing playlists follows; null when it failed. */
async function editPlaylist(change) {
  let r;
  try {
    r = await api("/api/playlists", change);
  } catch (err) {
    toast(err.message, "error");
    return null;
  }
  state.playlists = r.playlists || [];
  afterPlaylistsChanged(change);
  return r;
}

/** The playlists changed (here or on another device): the entry, the grid, the open playlist, the player. */
function afterPlaylistsChanged(change = null) {
  renderPlEntry();
  if ($("shareModal").classList.contains("show")) renderShare(); // "Playlist đã thay đổi…" follows
  if (state.chat === PL_HOME) renderPlGrid();
  // the player: a song taken out is skipped (liveOrder), a new order is followed
  const ps = state.playScan;
  if (ps?.playlist) {
    const p = playlistById(ps.playlist);
    if (p) {
      const at = new Map(p.songs.map((k, i) => [k, i]));
      ps.files.sort((a, b) => (at.get(favId(a, ps)) ?? 1e9) - (at.get(favId(b, ps)) ?? 1e9));
      state.playQueue = ps.files.filter(playable).map((f) => f.id);
      if (!state.shuffle) state.playOrder = orderFrom(state.playingId);
      updateNavButtons();
    }
  }
  if (!isPlChat(state.chat)) return;
  const p = openPlaylist();
  if (!p) return void openChat(PL_HOME); // deleted (here or elsewhere)
  $("chatTitle").textContent = p.name;
  const scan = state.scan;
  if (!scan?.playlist) return;
  scan.title = p.name;
  const known = new Set(scan.files.map((f) => favId(f, scan)));
  // songs added (here from another list, or on another device): their details are read again
  if (p.songs.some((k) => !known.has(k)) && change?.op !== "order") return void loadFiles();
  if (scan !== ps) {
    const at = new Map(p.songs.map((k, i) => [k, i]));
    scan.files.sort((a, b) => (at.get(favId(a, scan)) ?? 1e9) - (at.get(favId(b, scan)) ?? 1e9));
  }
  renderFiles();
}

const PL_NAME_MAX = 80; // core.js PLAYLIST_NAME_MAX

/** Why a playlist name cannot be used ("" when it can): empty, too long, or another playlist's (`except`: its own). */
function playlistNameError(name, except = null) {
  const n = name.trim();
  if (!n) return t("Hãy đặt tên cho playlist");
  if (n.length > PL_NAME_MAX) return t("Tên playlist tối đa {n} ký tự", { n: PL_NAME_MAX });
  if (state.playlists.some((p) => p.id !== except && p.name.trim().toLocaleLowerCase() === n.toLocaleLowerCase()))
    return t("Đã có playlist trùng tên");
  return "";
}

let plNameCheck = null; // the open name dialog's check: (typed?) -> can it be saved

/**
 * "Tạo playlist mới" / "Đổi tên": a name, asked in the usual dialog and checked as it is typed (empty, too long, the
 * name of another playlist: said under it, "Lưu" greyed). `except`: the playlist being renamed (its own name is fine).
 */
async function askPlaylistName(title, value = "", except = null) {
  let touched = false; // the reason shows once something is typed (or Lưu pressed), not on a new empty dialog
  plNameCheck = (typed = false) => {
    touched ||= typed;
    const input = $("plNameInput");
    if (!input) return false;
    const error = playlistNameError(input.value, except);
    const unchanged = except !== null && input.value.trim() === value.trim();
    input.classList.toggle("is-invalid", !!error && touched);
    $("plNameError").textContent = touched ? error : "";
    $("plNameCount").textContent = `${input.value.trim().length}/${PL_NAME_MAX}`;
    $("askOk").disabled = !!error || unchanged;
    return !error && !unchanged;
  };
  const ok = await ask({
    title,
    body: `<input class="form-control" id="plNameInput" maxlength="${PL_NAME_MAX}" autocomplete="off"
        placeholder="${t("Tên playlist")}" value="${esc(value)}" aria-describedby="plNameError">
      <div class="d-flex gap-2 mt-1 small">
        <span class="text-danger flex-grow-1" id="plNameError" role="alert"></span>
        <span class="text-body-secondary" id="plNameCount"></span>
      </div>`,
    ok: t("Lưu"),
    validate: () => plNameCheck?.(true) ?? true,
  });
  plNameCheck = null;
  $("askOk").disabled = false; // the dialog is shared
  return ok ? $("plNameInput")?.value.trim() || null : null;
}
$("askModal").addEventListener("shown.bs.modal", () => {
  const input = $("plNameInput");
  if (!input) return;
  plNameCheck?.();
  input.focus();
  input.select();
});
// the name dialog: checked as it is typed (askPlaylistName sets plNameCheck while it is open)
$("askBody").addEventListener("input", (e) => e.target.id === "plNameInput" && plNameCheck?.(true));
$("askBody").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.id === "plNameInput") {
    e.preventDefault();
    if (plNameCheck?.(true) ?? true) $("askOk").click(); // else the reason shows under the field
  }
});

async function createPlaylist(songs = []) {
  const name = await askPlaylistName(t("Tạo playlist mới"));
  if (!name) return null;
  const r = await editPlaylist({ op: "create", name, songs });
  if (r)
    toast(
      songs.length
        ? t("Đã tạo playlist “{name}” với {n} bài", { name, n: songs.length })
        : t("Đã tạo playlist “{name}”", { name }),
    );
  return r;
}

async function renamePlaylist(id) {
  const p = playlistById(id);
  if (!p) return;
  const name = await askPlaylistName(t("Đổi tên playlist"), p.name, id);
  if (name && name !== p.name && (await editPlaylist({ op: "rename", id, name }))) toast(t("Đã đổi tên playlist"));
}

async function deletePlaylist(id) {
  const p = playlistById(id);
  if (!p) return;
  const ok = await ask({
    title: t("Xoá playlist"),
    body: t("Xoá playlist “{name}”? Các bài hát vẫn còn trong kênh của chúng.", { name: esc(p.name) }),
    ok: t("Xoá"),
    okClass: "btn-danger",
  });
  if (ok && (await editPlaylist({ op: "delete", id }))) toast(t("Đã xoá playlist “{name}”", { name: p.name }), "info");
}

/** Open a playlist and play it from its first song. */
async function playPlaylist(id) {
  if (state.chat !== PL_PREFIX + id || !state.scan?.playlist) await openChat(PL_PREFIX + id);
  if (!state.scan?.playlist) return;
  const songs = visibleFiles({ withSearch: false }).filter(playable);
  if (!songs.length) return toast(t("Playlist chưa có bài nào"), "info");
  play(songs[0].id);
}
$("plPlayBtn").addEventListener("click", () => openPlaylist() && playPlaylist(openPlaylist().id));
$("plRenameBtn").addEventListener("click", () => openPlaylist() && renamePlaylist(openPlaylist().id));
$("plDeleteBtn").addEventListener("click", () => openPlaylist() && deletePlaylist(openPlaylist().id));
$("plShareBtn").addEventListener("click", () => openPlaylist() && openShare(openPlaylist().id));
// phones: the same actions from the ⋯ menu
const PL_MORE = { share: "plShareBtn", rename: "plRenameBtn", delete: "plDeleteBtn" };
$("plMoreMenu").addEventListener("click", (e) => {
  const id = PL_MORE[e.target.closest("[data-pl-more]")?.dataset.plMore];
  if (id) $(id).click();
});

// ---------- sharing a playlist (browser build): a secret link to a copy of its songs, heard without signing in ----------
// web/backend.js makes the link at once and then sends the songs (Telegram -> /api/cloud -> Cloudflare R2), one
// after another; cloud/share.js keeps the links, /s/<code> plays the songs already there.

const shareModal = new bootstrap.Modal($("shareModal"));
const share = {
  id: null, // the playlist in the dialog
  // the account's open links { code, playlistId, name, count, ready, expiresAt, maxExpiresAt, refs, skipped,
  // skippedInfo: [{ ref, why, name }], link }
  links: [],
  uploads: new Map(), // link code -> { done, total, failed } while its songs are sent (goes on when the dialog closes)
  making: null, // the playlist whose link is being made (its songs are read first)
  busyCode: null, // the link being synced
};

const shareDate = (ms) =>
  new Date(ms).toLocaleString(tdlI18n.locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/** The links (and the uploads still going on, which also resume one stopped half-way). */
async function loadShares() {
  const r = await api("/api/shares");
  share.links = r.shares || [];
  for (const u of r.uploads || []) share.uploads.set(u.code, u);
}

async function openShare(id) {
  const p = playlistById(id);
  if (!p) return;
  if (!p.songs.length) return toast(t("Playlist chưa có bài nào"), "info");
  await hideOpenModals();
  share.id = id;
  $("shareTitle").innerHTML =
    `<i class="bi bi-share text-primary"></i> ${esc(t("Chia sẻ “{name}”", { name: p.name }))}`;
  $("shareError").textContent = "";
  renderShare();
  shareModal.show();
  try {
    await loadShares();
  } catch (err) {
    $("shareError").textContent = err.message;
  }
  renderShare();
}

/**
 * How the link stands against its playlist now: songs added since (not counting those that are not shared: not music,
 * too big, gone), songs taken out, a new order. Nothing: it matches.
 */
function shareChanges(l) {
  const p = playlistById(l.playlistId);
  if (!p || !l.refs) return null;
  const inLink = new Set(l.refs);
  const known = new Set([...l.refs, ...(l.skipped || [])]);
  const now = new Set(p.songs);
  const added = p.songs.filter((ref) => !known.has(ref)).length;
  const removed = l.refs.filter((ref) => !now.has(ref)).length;
  const order = p.songs.filter((ref) => inLink.has(ref));
  const kept = l.refs.filter((ref) => now.has(ref));
  return { added, removed, moved: order.some((ref, i) => ref !== kept[i]) };
}

function shareStatus(l) {
  const u = share.uploads.get(l.code);
  if (u)
    return `<div class="d-flex align-items-center gap-2">
        <div class="progress flex-grow-1" role="progressbar" aria-label="${t("Đang tải lên")}" style="height: 6px">
          <div class="progress-bar" style="width: ${u.total ? (u.done / u.total) * 100 : 0}%"></div>
        </div>
        <span class="small text-body-secondary text-nowrap">${t("Đã tải lên {done}/{total} bài", { done: u.done, total: u.total })}</span>
      </div>
      <div class="small text-body-secondary mt-1">${t("Người nhận nghe được ngay các bài đã tải lên. Giữ trang này mở tới khi xong.")}</div>`;
  const c = shareChanges(l);
  const parts = c
    ? [
        c.added && t("+{n} bài mới", { n: c.added }),
        c.removed && t("−{n} bài đã bỏ", { n: c.removed }),
        c.moved && t("thứ tự đã đổi"),
      ].filter(Boolean)
    : [];
  if (parts.length)
    return `<div class="small share-note text-warning-emphasis"><i class="bi bi-arrow-repeat"></i> ${t("Playlist đã thay đổi: {what}. Bấm Đồng bộ để cập nhật link.", { what: parts.join(", ") })}</div>`;
  if (l.ready < l.count)
    return `<div class="small share-note text-warning-emphasis"><i class="bi bi-hourglass-split"></i> ${t("{ready}/{count} bài sẵn sàng, phần còn lại đang được tải lên", { ready: l.ready, count: l.count })}</div>`;
  return `<div class="small share-note text-success"><i class="bi bi-check2-circle"></i> ${t("Đã khớp với playlist")}</div>`;
}

// why a song of the playlist is not in its link (web/backend.js shareItems)
const SKIP_WHY = {
  big: "quá 500 MB",
  kind: "không phải nhạc",
  gone: "không còn mở được",
  many: "quá 1000 bài",
};

/** The playlist's songs left out of the link, and why (a link made before the reasons: Sync tells). */
function shareSkipped(l) {
  const p = playlistById(l.playlistId);
  const now = new Set(p?.songs || []);
  const left = (l.skippedInfo || []).filter((x) => now.has(x.ref));
  if (!left.length) return "";
  const counts = new Map();
  for (const x of left) counts.set(x.why, (counts.get(x.why) || 0) + 1);
  const why = [...counts]
    .map(([k, n]) => (SKIP_WHY[k] ? `${t(SKIP_WHY[k])} (${n})` : t("chưa rõ lý do, bấm Đồng bộ để xem")))
    .join(", ");
  const named = left.filter((x) => x.name);
  const head = `<i class="bi bi-info-circle"></i> ${t("{n} bài trong playlist không chia sẻ được: {why}", { n: left.length, why })}`;
  if (!named.length) return `<div class="small share-note text-body-secondary mt-1">${head}</div>`;
  return `<details class="small share-note text-body-secondary mt-1"><summary>${head}</summary>
    <ul class="mb-0 mt-1 ps-3">${named.map((x) => `<li><span translate="no">${esc(x.name)}</span> — ${t(SKIP_WHY[x.why] || "chưa rõ lý do")}</li>`).join("")}</ul></details>`;
}

function shareCard(l) {
  const c = shareChanges(l);
  const changed = !!c && (c.added || c.removed || c.moved);
  const busy = share.busyCode === l.code;
  const atMax = l.maxExpiresAt && l.expiresAt >= l.maxExpiresAt;
  return `<div class="share-link border rounded-3 p-2 p-sm-3" data-code="${esc(l.code)}">
    <div class="input-group input-group-sm">
      <input class="form-control" readonly value="${esc(l.link)}" aria-label="${t("Link chia sẻ")}">
      <button class="btn btn-primary" type="button" data-share-copy="${esc(l.link)}" title="${t("Sao chép link")}"><i class="bi bi-copy"></i></button>
      <a class="btn btn-outline-primary" href="${esc(l.link)}" target="_blank" rel="noopener noreferrer" title="${t("Mở link trong tab mới")}" aria-label="${t("Mở link trong tab mới")}"><i class="bi bi-box-arrow-up-right"></i></a>
    </div>
    <div class="share-meta small text-body-secondary">
      <span><i class="bi bi-music-note-list"></i> ${t("{n} bài", { n: l.count })}</span>
      <span><i class="bi bi-clock"></i> ${t("Hết hạn {date}", { date: shareDate(l.expiresAt) })}</span>
    </div>
    ${shareStatus(l)}
    ${shareSkipped(l)}
    <div class="share-actions">
      <div class="d-flex align-items-center gap-2">
        <button class="btn btn-sm ${changed ? "btn-primary" : "btn-outline-primary"} text-nowrap" type="button" data-share-sync="${esc(l.code)}"
          title="${t("Tải lên bài mới thêm vào playlist, gỡ bài đã bỏ khỏi playlist")}" ${busy || share.uploads.has(l.code) ? "disabled" : ""}>
          <i class="bi bi-arrow-repeat${busy ? " spin" : ""}"></i> ${busy ? t("Đang đồng bộ…") : t("Đồng bộ")}</button>
        <button class="btn btn-sm btn-outline-danger share-revoke text-nowrap ms-auto" type="button" data-share-revoke="${esc(l.code)}"><i class="bi bi-x-lg"></i> ${t("Thu hồi")}</button>
      </div>
      <div class="d-flex align-items-center flex-wrap gap-2 mt-2">
        <span class="small text-body-secondary">${t("Gia hạn thêm")}</span>
        <div class="input-group input-group-sm w-auto">
          <select class="form-select" data-share-days aria-label="${t("Gia hạn thêm")}" ${atMax ? "disabled" : ""}>
            <option value="1">${t("1 ngày")}</option><option value="7" selected>${t("7 ngày")}</option><option value="30">${t("30 ngày")}</option>
          </select>
          <button class="btn btn-outline-primary text-nowrap" type="button" data-share-extend="${esc(l.code)}" ${atMax ? "disabled" : ""}>
            <i class="bi bi-calendar-plus"></i> ${t("Gia hạn")}</button>
        </div>
        ${atMax ? `<span class="small text-body-secondary">${t("Đã đạt thời hạn tối đa 90 ngày")}</span>` : ""}
      </div>
    </div></div>`;
}

function renderShare() {
  const links = share.links.filter((l) => l.playlistId === share.id);
  $("shareLinks").innerHTML = links.map(shareCard).join("");
  // a link already: it is synced / extended, no second one
  const making = share.making === share.id;
  show($("shareNew"), !making && !links.length);
  show($("shareBusy"), making);
}

/** The link's details from an answer (sync / extend), in place. */
function updateShareLink(r) {
  const i = share.links.findIndex((l) => l.code === r.code);
  if (i >= 0) share.links[i] = { ...share.links[i], ...r };
}

$("shareCreate").addEventListener("click", async () => {
  const id = share.id;
  $("shareError").textContent = "";
  share.making = id;
  renderShare();
  try {
    const r = await api("/api/shares", { id, days: Number($("shareDays").value) });
    share.links.unshift(r);
    if (!share.uploads.has(r.code)) share.uploads.set(r.code, { done: 0, total: r.count, failed: 0 });
    toast(
      r.skippedCount
        ? t("Đã tạo link chia sẻ, {n} bài không chia sẻ được", { n: r.skippedCount })
        : t("Đã tạo link chia sẻ, đang tải nhạc lên"),
      r.skippedCount ? "warn" : "success",
    );
  } catch (err) {
    if (share.id === id && $("shareModal").classList.contains("show")) $("shareError").textContent = err.message;
    else toast(err.message, "error");
  } finally {
    share.making = null;
    if (share.id === id) renderShare();
  }
});

/** A "share" event: how the upload of a link goes. */
function shareProgress(d) {
  const link = share.links.find((l) => l.code === d.code);
  if (link) link.ready = d.done;
  if (!d.finished) share.uploads.set(d.code, d);
  else {
    share.uploads.delete(d.code);
    if (link && d.done >= d.total) toast(t("Đã tải lên đủ {n} bài của “{name}”", { n: d.total, name: link.name }));
    else if (link && d.failed) toast(t("{n} bài không tải lên được", { n: d.failed }), "warn");
  }
  if ($("shareModal").classList.contains("show")) renderShare();
}

$("shareLinks").addEventListener("click", async (e) => {
  const copy = e.target.closest("[data-share-copy]");
  if (copy) {
    try {
      await navigator.clipboard.writeText(copy.dataset.shareCopy);
      toast(t("Đã sao chép link"), "success", { oneLine: true });
    } catch {
      copy.closest(".share-link").querySelector("input").select(); // no clipboard: selected for Ctrl+C
    }
    return;
  }
  const sync = e.target.closest("[data-share-sync]");
  if (sync) {
    const code = sync.dataset.shareSync;
    $("shareError").textContent = "";
    share.busyCode = code;
    renderShare();
    try {
      const r = await api("/api/shares/sync", { code, id: share.id });
      updateShareLink(r);
      if (r.uploading && !share.uploads.has(code))
        share.uploads.set(code, { done: r.ready, total: r.count, failed: 0 });
      toast(
        r.added || r.removed
          ? t("Đã đồng bộ: thêm {added} bài, bỏ {removed} bài", { added: r.added, removed: r.removed })
          : t("Link đã khớp với playlist"),
        "success",
      );
    } catch (err) {
      $("shareError").textContent = err.message;
    } finally {
      share.busyCode = null;
      renderShare();
    }
    return;
  }
  const extend = e.target.closest("[data-share-extend]");
  if (extend) {
    const code = extend.dataset.shareExtend;
    const days = Number(extend.closest(".share-link").querySelector("[data-share-days]").value);
    $("shareError").textContent = "";
    extend.disabled = true;
    try {
      const r = await api("/api/shares/extend", { code, days });
      updateShareLink(r);
      toast(
        r.capped
          ? t("Đã gia hạn tới {date} (tối đa 90 ngày)", { date: shareDate(r.expiresAt) })
          : t("Đã gia hạn tới {date}", { date: shareDate(r.expiresAt) }),
        "success",
      );
    } catch (err) {
      $("shareError").textContent = err.message;
    }
    renderShare();
    return;
  }
  const revoke = e.target.closest("[data-share-revoke]");
  if (!revoke) return;
  // a second press confirms: the link stops working for everyone at once (and its upload stops)
  if (!revoke.dataset.sure) {
    revoke.dataset.sure = "1";
    revoke.classList.replace("btn-outline-danger", "btn-danger");
    revoke.innerHTML = `<i class="bi bi-exclamation-lg"></i> ${t("Bấm lần nữa để thu hồi")}`;
    return;
  }
  revoke.disabled = true;
  const code = revoke.dataset.shareRevoke;
  try {
    await api("/api/shares/revoke", { code });
    share.links = share.links.filter((l) => l.code !== code);
    share.uploads.delete(code);
    toast(t("Đã thu hồi link"), "info");
  } catch (err) {
    $("shareError").textContent = err.message;
  }
  renderShare();
});
$("shareLinks").addEventListener("focusin", (e) => e.target.matches("input") && e.target.select());

// ---------- adding songs to a playlist: + on a row, or "Thêm vào playlist" for the ticked ones ----------

const plPickModal = new bootstrap.Modal($("plPickModal"));
let plPicking = []; // the songs ("<chat id>|<message id>") the dialog adds

/** The + of a row / the button above the list: choose a playlist (or make one) for these songs. */
function pickPlaylist(songs) {
  plPicking = [...new Set(songs)];
  if (!plPicking.length) return;
  $("plPickTitle").textContent =
    plPicking.length === 1 ? t("Thêm vào playlist") : t("Thêm {n} bài vào playlist", { n: plPicking.length });
  $("plPickName").value = "";
  checkPickName(false);
  renderPlPick();
  plPickModal.show();
}

function renderPlPick() {
  $("plPickList").innerHTML = state.playlists.length
    ? state.playlists
        .map((p) => {
          const all = plPicking.every((k) => p.songs.includes(k));
          return `<button type="button" class="list-group-item list-group-item-action d-flex align-items-center gap-3 pl-pick-item" data-pick="${esc(p.id)}"${all ? " disabled" : ""}>
        ${plCover(p)}
        <span class="min-w-0 flex-grow-1"><span class="d-block text-truncate fw-semibold">${esc(p.name)}</span>
        <small class="text-body-secondary">${t("{n} bài", { n: p.songs.length })}</small></span>
        ${all ? `<span class="badge text-bg-success">${t("Đã có")}</span>` : '<i class="bi bi-plus-lg text-body-secondary"></i>'}</button>`;
        })
        .join("")
    : `<div class="text-center text-body-secondary small p-4">${t("Chưa có playlist nào. Đặt tên ở trên để tạo playlist đầu tiên.")}</div>`;
}

$("plPickList").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-pick]");
  if (!b) return;
  const p = playlistById(b.dataset.pick);
  const fresh = plPicking.filter((k) => !p.songs.includes(k)).length;
  const songs = plPicking;
  plPickModal.hide();
  if (await editPlaylist({ op: "add", id: p.id, songs })) {
    toast(
      fresh < songs.length
        ? t("Đã thêm {n} bài vào “{name}” ({m} bài đã có sẵn)", { n: fresh, name: p.name, m: songs.length - fresh })
        : t("Đã thêm {n} bài vào “{name}”", { n: fresh, name: p.name }),
    );
    clearPickedSelection(songs);
  }
});
/** The picker's "Tên playlist mới…": the same checks as the name dialog. */
function checkPickName(typed) {
  const input = $("plPickName");
  const error = typed ? playlistNameError(input.value) : "";
  input.classList.toggle("is-invalid", !!error);
  $("plPickError").textContent = error;
  return !error;
}
$("plPickName").addEventListener("input", () => $("plPickName").value.trim() && checkPickName(true));
$("plPickNew").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("plPickName").value.trim();
  if (!checkPickName(true)) return $("plPickName").focus();
  const songs = plPicking;
  plPickModal.hide();
  if (await editPlaylist({ op: "create", name, songs })) {
    toast(t("Đã tạo playlist “{name}” với {n} bài", { name, n: songs.length }));
    clearPickedSelection(songs);
  }
});
$("plPickModal").addEventListener("shown.bs.modal", () => !state.playlists.length && $("plPickName").focus());

/** Added from the ticked rows: they are unticked (like after a download). */
function clearPickedSelection(songs) {
  if (!state.scan || songs.length < 2) return;
  state.selected.clear();
  renderFiles();
}

/** "<chat id>|<message id>" of the open list's playable ticked files. */
function pickedSongs() {
  if (!state.scan) return [];
  return state.scan.files.filter((f) => state.selected.has(f.id) && playable(f)).map((f) => favId(f, state.scan));
}
$("addPlBtn").addEventListener("click", () => pickPlaylist(pickedSongs()));

/** The last cell: + (add to a playlist), ✕ (take out) in a playlist's list, then the heart. */
function plButtons(f, heart) {
  if (!playable(f) || !state.scan) return heart;
  const remove = state.scan.playlist
    ? `<button class="btn btn-sm pl-remove-btn" data-plremove="${f.id}" title="${t("Bỏ khỏi playlist")}" aria-label="${t("Bỏ khỏi playlist")}"><i class="bi bi-x-lg"></i></button>`
    : "";
  // phones hide the "#" column, and its grip: one here instead, under the heart
  const grip = draggable(state.scan)
    ? `<span class="pl-grip pl-grip-m" data-grip title="${t("Kéo để đổi thứ tự")}"><i class="bi bi-grip-horizontal"></i></span>`
    : "";
  return `${remove}<button class="btn btn-sm add-pl-btn" data-addpl="${f.id}" title="${t("Thêm vào playlist")}" aria-label="${t("Thêm vào playlist")}"><i class="bi bi-plus-lg"></i></button>${heart}${grip}`;
}

async function removeFromPlaylist(id) {
  const scan = state.scan;
  const f = scan?.files.find((x) => x.id === id);
  if (!f || !scan.playlist) return;
  const p = playlistById(scan.playlist);
  if (await editPlaylist({ op: "remove", id: scan.playlist, songs: [favId(f, scan)] }))
    toast(t("Đã bỏ “{song}” khỏi “{name}”", { song: displayName(f), name: p?.name || "" }), "info");
}

// ---------- songs dragged by their grip to a new place (mouse and touch) ----------
// Any list in its own order ("Mặc định", nothing searched): a playlist keeps its new order (saved, on every
// device); a chat's songs and the favourites are shown and played in it while the page is open (loaded again,
// they are back in their own order). The row lifted follows the pointer, the others slide out of its way, and it
// settles where it is dropped.

/**
 * core.js orderFiles (this page does not load core.js; test/ui.test.js checks they agree): a list (in its own
 * order) put in a saved order, the songs not in it keeping their place around it — the ones before all of it
 * on top, the ones after it at the end, the ones between right after the song they followed.
 */
function orderFiles(files, songs, keyOf) {
  if (!songs?.length) return files;
  const rank = new Map(songs.map((k, i) => [k, i]));
  const ranked = files.map((f) => rank.get(keyOf(f)));
  const first = ranked.findIndex((r) => r !== undefined);
  if (first < 0) return files;
  const last = ranked.findLastIndex((r) => r !== undefined);
  const top = [];
  const bottom = [];
  const after = new Map(); // a song in the order -> the ones that followed it
  let prev = null;
  files.forEach((f, i) => {
    if (ranked[i] !== undefined) prev = f;
    else if (i < first) top.push(f);
    else if (i > last) bottom.push(f);
    else after.set(prev, [...(after.get(prev) || []), f]);
  });
  const known = files.filter((_, i) => ranked[i] !== undefined).sort((a, b) => rank.get(keyOf(a)) - rank.get(keyOf(b)));
  return [...top, ...known.flatMap((f) => [f, ...(after.get(f) || [])]), ...bottom];
}

/** A list whose songs can be dragged to a new place: a playlist, a chat, the favourites. */
const draggable = (scan) => !!scan?.playlist || !!orderIdOf(scan);

/** The id of a list's order (core.js): "fav", the chat's id; null for lists that have none of their own. */
function orderIdOf(scan) {
  if (!scan || scan.playlist || scan.search || scan.recent) return null;
  return scan.fav ? "fav" : scan.key.split("|")[0];
}
const savedOrder = (scan) => state.orders.find((o) => o.id === orderIdOf(scan))?.songs || null;
/** A list's files in its own order: the order dragged to when there is one. */
const inOwnOrder = (scan, files) => orderFiles(files, savedOrder(scan), (f) => favId(f, scan));

/** The open list and the one playing follow the orders (changed here or on another device). */
function afterOrdersChanged() {
  if (state.scan && orderIdOf(state.scan)) renderFiles();
  const ps = state.playScan;
  if (ps && orderIdOf(ps) && ps === state.scan && state.sort === "default") {
    state.playQueue = visibleFiles({ withSearch: false })
      .filter(playable)
      .map((f) => f.id);
    if (!state.shuffle) state.playOrder = orderFrom(state.playingId);
    updateNavButtons();
  }
}

/** A list's order: songs in the new order, or null (back to the list's own); kept while the page is open. */
function saveOrder(scan, songs) {
  const id = orderIdOf(scan);
  state.orders = [...(songs ? [{ id, songs }] : []), ...state.orders.filter((o) => o.id !== id)];
  afterOrdersChanged();
}

$("orderResetBtn").addEventListener("click", () => {
  if (!state.scan || !savedOrder(state.scan)) return;
  saveOrder(state.scan, null);
  toast(t("Đã về thứ tự gốc của danh sách"), "info");
});

let drag = null; // { row, pointer, grab, moved, scroll, y, y0 (where the finger went down), later (to draw) }

/** Rows move to new places: each slides there from where it was (FLIP). */
function slide(rows, move) {
  const before = new Map(rows.map((r) => [r, r.offsetTop]));
  move();
  for (const r of rows) {
    const dy = before.get(r) - r.offsetTop;
    if (!dy) continue;
    r.style.transition = "none";
    r.style.transform = `translateY(${dy}px)`;
    r.getBoundingClientRect(); // there first…
    r.style.transition = "";
    r.style.transform = ""; // …then slides to its place
  }
}

/** The lifted row under the pointer; it changes place with a neighbour once over half of it. */
function dragTo(clientY) {
  const { row, grab } = drag;
  const wrap = $("filesWrap");
  drag.y = clientY;
  // where the row's top should be: within the rows (pushed past the last one it made the list longer, which the
  // edge's scrolling followed on and on)
  const first = $("files").firstElementChild;
  const last = $("files").lastElementChild;
  const top = Math.min(
    Math.max(clientY + wrap.scrollTop - grab, first.offsetTop),
    last.offsetTop + last.offsetHeight - row.offsetHeight,
  );
  // past half of a neighbour: they change places
  let next = row.nextElementSibling;
  while (next && top + row.offsetHeight > next.offsetTop + next.offsetHeight / 2) {
    const after = next;
    slide([after], () => after.after(row));
    drag.moved = true;
    next = row.nextElementSibling;
  }
  let prev = row.previousElementSibling;
  while (prev && top < prev.offsetTop + prev.offsetHeight / 2) {
    const before = prev;
    slide([before], () => before.before(row));
    drag.moved = true;
    prev = row.previousElementSibling;
  }
  row.style.transform = `translateY(${top - row.offsetTop}px)`;
}

/**
 * Held near the list's top / bottom edge: it scrolls, faster deeper into the edge, the row going along. Only once
 * the finger went a little way that way: a row picked up near an edge (a phone's short list) does not run off.
 */
function dragScroll() {
  if (!drag) return;
  if (!drag.row.isConnected) return void endPlDrag({ pointerId: drag.pointer }); // the row went: the drag ends
  const wrap = $("filesWrap");
  const box = wrap.getBoundingClientRect();
  const head = wrap.querySelector("thead")?.getBoundingClientRect().height || 0;
  const edge = Math.min(56, (box.height - head) * 0.15);
  const up = drag.y < drag.y0 - 12 ? box.top + head + edge - drag.y : 0;
  const down = drag.y > drag.y0 + 12 ? drag.y - (box.bottom - edge) : 0;
  const depth = Math.min(1, Math.max(up, down, 0) / edge); // past the edge (over the player…): no faster
  if (depth > 0) {
    const was = wrap.scrollTop;
    wrap.scrollTop += Math.round(1 + 9 * depth * depth) * (up > 0 ? -1 : 1);
    if (wrap.scrollTop !== was) dragTo(drag.y);
  }
  drag.scroll = requestAnimationFrame(dragScroll);
}

$("files").addEventListener("pointerdown", (e) => {
  const grip = e.target.closest("[data-grip]");
  if (!grip || !$("chatView").classList.contains("pl-sortable") || drag) return;
  e.preventDefault();
  const row = grip.closest("tr");
  const wrap = $("filesWrap");
  $("files").classList.add("drag-on"); // before measuring: it changes the box the rows are measured from
  row.classList.add("pl-dragging");
  document.body.classList.add("pl-drag-on");
  const grab = e.clientY + wrap.scrollTop - row.offsetTop;
  drag = { row, pointer: e.pointerId, grab, moved: false, y: e.clientY, y0: e.clientY };
  grip.setPointerCapture(e.pointerId);
  drag.scroll = requestAnimationFrame(dragScroll);
});
$("files").addEventListener("pointermove", (e) => {
  if (!drag || e.pointerId !== drag.pointer) return;
  dragTo(e.clientY);
});

async function endPlDrag(e) {
  if (!drag || e.pointerId !== drag.pointer) return;
  const { row, moved, later } = drag;
  cancelAnimationFrame(drag.scroll);
  drag = null;
  // it settles into its place…
  row.style.transform = "";
  row.classList.remove("pl-dragging");
  document.body.classList.remove("pl-drag-on");
  await new Promise((r) => setTimeout(r, 190));
  $("files").classList.remove("drag-on");
  const scan = state.scan;
  const id = Number(row.dataset.id);
  let saving = null;
  if (later && !moved) renderFiles(); // what came in while it was held
  if (moved && scan) {
    const shown = [...$("files").querySelectorAll("tr[data-id]")].map((tr) => Number(tr.dataset.id));
    const byId = new Map(scan.files.map((f) => [f.id, f]));
    // the rows shown take the places they had among the whole list (the ones a filter hides stay where they are)
    const all = scan.playlist ? [...scan.files] : inOwnOrder(scan, scan.files);
    const slots = new Set(shown);
    let i = 0;
    const order = all.map((f) => (slots.has(f.id) ? byId.get(shown[i++]) : f));
    if (scan.playlist) {
      scan.files = order; // at once, before the server answers
      renderFiles();
      saving = editPlaylist({ op: "order", id: scan.playlist, songs: order.map((f) => favId(f, scan)) });
    } else
      saveOrder(
        scan,
        order.map((f) => favId(f, scan)),
      );
  }
  // …then shines a moment where it landed
  const landed = $("files").querySelector(`tr[data-id="${id}"]`);
  landed?.classList.add("drop-flash");
  setTimeout(() => landed?.classList.remove("drop-flash"), 700);
  await saving;
}
// on the page, not the list: lifted over the player (or the row drawn again), the finger still ends the drag
document.addEventListener("pointerup", endPlDrag);
document.addEventListener("pointercancel", endPlDrag);

// ---------- sidebar as a rail of icons (576–1023px) ----------

const railMode = () => matchMedia("(min-width: 576px) and (max-width: 1023.98px) and (min-height: 501px)").matches;

/** Open (over the page) or close the rail. */
function setRailOpen(open) {
  $("mainView").classList.toggle("rail-open", open && railMode());
  $("railToggle").setAttribute("aria-expanded", String(open));
  $("railToggle").innerHTML = `<i class="bi ${open ? "bi-chevron-left" : "bi-chevron-right"}"></i>`;
  $("railToggle").setAttribute("data-bs-original-title", open ? t("Thu gọn") : t("Mở rộng danh sách kênh"));
}
$("railToggle").addEventListener("click", () => setRailOpen(!$("mainView").classList.contains("rail-open")));
$("railBackdrop").addEventListener("click", () => setRailOpen(false));
$("railSearchBtn").addEventListener("click", () => {
  setRailOpen(true);
  setTimeout(() => $("dialogSearch").focus(), 50);
});
document.addEventListener(
  "keydown",
  (e) => e.key === "Escape" && $("mainView").classList.contains("rail-open") && setRailOpen(false),
);
matchMedia("(min-width: 576px) and (max-width: 1023.98px) and (min-height: 501px)").addEventListener("change", () =>
  setRailOpen(false),
);

/** When the song was posted in its chat: "16/09/2024 21:04" (the chosen language's date format). */
function postedAt(f) {
  if (!f.date) return "";
  const d = new Date(f.date * 1000);
  const day = d.toLocaleDateString(tdlI18n.locale, { day: "2-digit", month: "2-digit", year: "numeric" });
  const hm = d.toLocaleTimeString(tdlI18n.locale, { hour: "2-digit", minute: "2-digit" });
  return `<span class="posted" title="${esc(t("Ngày đăng lên kênh"))}"><i class="bi bi-clock"></i> ${day} ${hm}</span>`;
}

function rowHtml(f, num) {
  const sel = state.selected.has(f.id);
  const posted = postedAt(f);
  const file = displayName(f) !== f.name ? `<i class="bi bi-file-earmark-music"></i> ${esc(f.name)}` : "";
  const cls = [sel && "row-sel", state.playingId === f.id && "playing", dupShade.has(f.id) && "dup-alt"]
    .filter(Boolean)
    .join(" ");
  return `<tr class="${cls}" data-id="${f.id}">
    <td class="ps-3"><input class="form-check-input" type="checkbox" ${sel ? "checked" : ""} tabindex="-1"></td>
    <td class="play">${playCell(f)}</td>
    <td class="text-body-secondary small">${draggable(state.scan) ? `<span class="pl-grip" data-grip title="${t("Kéo để đổi thứ tự")}"><i class="bi bi-grip-vertical"></i></span>` : ""}${num}</td>
    <td class="text-truncate name-cell"><div class="name-main">${esc(displayName(f))}</div>
      ${file ? `<div class="small text-body-secondary text-truncate name-file">${file}</div>` : ""}
      ${posted ? `<div class="small text-body-secondary text-truncate name-file name-posted">${posted}</div>` : ""}
      ${f.chat ? `<div class="small text-truncate fav-chat"><i class="bi bi-megaphone"></i> ${esc(f.chat)}</div>` : ""}
      <div class="m-meta small text-body-secondary"><span class="m-size">${[fmt(f.size), fmtDur(f.duration)].filter(Boolean).join(" · ")}</span><span class="state-m">${stateCell(f)}</span></div></td>
    <td class="text-end text-body-secondary small">${fmt(f.size)}${f.duration ? `<div>${fmtDur(f.duration)}</div>` : ""}</td>
    <td class="fav">${plButtons(f, favCell(f))}</td></tr>`;
}

/** "Bài hát yêu thích": one choice per chat that has favourites (with how many), plus "all chats". */
function renderFavScope() {
  if (!state.scan?.fav) return;
  const chats = new Map(); // chat id -> { name, count }
  for (const f of state.scan.files) {
    if (!state.favorites.has(f.fav)) continue;
    const id = f.fav.split("|")[0];
    const c = chats.get(id) || { name: f.chat, count: 0 };
    c.count++;
    chats.set(id, c);
  }
  if (state.favScope !== "all" && !chats.has(state.favScope)) state.favScope = "all"; // that chat has no hearts left
  const total = [...chats.values()].reduce((n, c) => n + c.count, 0);
  $("favScope").innerHTML =
    `<option value="all">${t("Tất cả kênh — theo danh sách ({n})", { n: total })}</option>` +
    [...chats]
      .sort((a, b) => collator.compare(a[1].name, b[1].name))
      .map(([id, c]) => `<option value="${esc(id)}">${esc(c.name)} (${c.count})</option>`)
      .join("");
  $("favScope").value = state.favScope;
}

$("favScope").addEventListener("change", (e) => {
  state.favScope = e.target.value;
  renderFiles();
});

function renderFiles() {
  // a row being dragged: drawn when it is dropped (a page read meanwhile would take the row from under the finger,
  // and the drop with it: the list scrolled on and on)
  if (drag) return void (drag.later = true);
  rememberSizes(state.scan);
  renderFavScope();
  // a list in its own order, nothing hidden by the search: its songs can be dragged to a new place
  $("chatView").classList.toggle(
    "pl-sortable",
    draggable(state.scan) && state.sort === "default" && !state.query.trim() && !state.dupOnly,
  );
  const custom = !!savedOrder(state.scan);
  show($("orderResetBtn"), custom && state.sort === "default");
  $("sortSel").options[0].textContent = custom ? t("Mặc định (thứ tự đã kéo)") : t("Mặc định (mới nhất)");
  $("sortSelM").options[0].textContent = $("sortSel").options[0].textContent;
  const files = visibleFiles();
  // "#": the place in the list's own order (the one dragged to, when there is one)
  const index = new Map(inOwnOrder(state.scan, state.scan.files).map((f, i) => [f.id, i + 1]));
  const more = state.scan.more ? "+" : ""; // more pages to load: the total is not known yet
  const all = `${state.scan.files.length}${more}`;
  $("fileCount").textContent = t("{n}/{total} file", { n: files.length, total: all });
  // "Lọc trùng": how many groups; every other group shaded, so where one ends shows
  dupShade = new Set();
  if (state.dupOnly) {
    const keys = [...new Set(files.map(dupKey))];
    const odd = new Set(keys.filter((_, i) => i % 2));
    for (const f of files) if (odd.has(dupKey(f))) dupShade.add(f.id);
    $("fileCount").textContent = t("{n} file trùng · {g} nhóm", { n: files.length, g: keys.length });
    dupExtra = files.length - keys.length;
  } else dupExtra = 0;
  $("chatSub").textContent =
    files.length === state.scan.files.length
      ? t("{n} file", { n: all })
      : t("{n}/{total} file đang hiện", { n: files.length, total: all });
  syncFilterSheet();
  if (!files.length) {
    const favEmpty = state.scan.fav && !state.scan.files.some((f) => state.favorites.has(f.fav));
    const plEmpty = state.scan.playlist && !state.scan.files.some((f) => inPlaylist(f, state.scan));
    setMessage(
      plEmpty
        ? `<i class="bi bi-music-note-list display-5 text-primary"></i><p class="mt-2 mb-1">${t("Playlist chưa có bài nào")}</p><p class="small">${t('Mở một kênh và bấm <i class="bi bi-plus-lg"></i> ở mỗi bài để thêm vào đây.')}</p>`
        : favEmpty
          ? `<i class="bi bi-heart display-5 fav-empty"></i><p class="mt-2 mb-1">${t("Chưa có bài hát yêu thích")}</p><p class="small">${t('Mở một kênh và bấm <i class="bi bi-heart"></i> ở cuối mỗi dòng để thêm vào đây.')}</p>`
          : state.dupOnly && state.scan.files.length
            ? `<i class="bi bi-check2-circle display-5 text-success"></i><p class="mt-2 mb-1">${t("Không có file trùng")}</p>${state.scan.more ? `<p class="small">${t("Trong {n} file đã tải — kéo xuống cuối để tải thêm và tìm tiếp.", { n: state.scan.files.length })}</p>` : ""}`
            : state.scan.files.length
              ? t("Không có file khớp bộ lọc")
              : `<i class="bi bi-inbox display-5"></i><p class="mt-2">${t("Kênh không có file loại này")}</p>`,
    );
  } else {
    $("filesMsg").innerHTML = "";
    $("files").innerHTML = files.map((f) => rowHtml(f, index.get(f.id))).join("");
  }
  updateSelection();
  renderMore();
  fillScreen();
}

// ---------- the next pages of a long list (500 files each), loaded when scrolled to the end ----------

const PAGE_SIZE = 500; // same as core.js

function renderMore() {
  const scan = state.scan;
  $("filesMore").innerHTML =
    !scan || scan.fav || scan.playlist
      ? ""
      : state.loadingMore
        ? `<span class="spinner-border spinner-border-sm text-primary"></span> ${t("Đang tải thêm…")}`
        : scan.more
          ? `<button class="btn btn-sm btn-outline-primary" id="loadMoreBtn"><i class="bi bi-arrow-down-circle"></i> ${t("Tải thêm {n} file", { n: scan.search ? SONG_PAGE : PAGE_SIZE })}</button>`
          : scan.files.length > PAGE_SIZE
            ? t("Đã tải hết {n} file", { n: scan.files.length })
            : "";
}

async function loadMore() {
  const scan = state.scan;
  if (!scan?.more || scan.fav || scan.playlist || state.loadingMore || state.scanning) return;
  const token = state.loadToken;
  state.loadingMore = true;
  renderMore();
  try {
    const r = await api(`/api/files/more?key=${encodeURIComponent(scan.key)}&scan=${state.scanId}`, undefined, {
      signal: state.scanCtrl?.signal,
    });
    if (token !== state.loadToken || state.scan !== scan) return;
    const have = new Set(scan.files.map((f) => f.id));
    const added = r.files.filter((f) => !have.has(f.id));
    scan.files.push(...added);
    scan.more = r.more;
    extendQueue(scan);
    state.loadingMore = false;
    renderFiles();
  } catch (err) {
    if (token === state.loadToken && err.name !== "AbortError") toast(err.message, "error");
  } finally {
    if (token === state.loadToken) {
      state.loadingMore = false;
      renderMore();
    }
  }
}

/** Near the end of the list (or the list does not even fill the screen): read the next page. */
function nearEnd() {
  const w = $("filesWrap");
  return w.scrollTop + w.clientHeight >= w.scrollHeight - 600;
}
function fillScreen() {
  if (state.scan?.more && !state.loadingMore && nearEnd()) loadMore();
}
$("filesWrap").addEventListener(
  "scroll",
  () => {
    if (state.scan?.more && !state.loadingMore && nearEnd()) loadMore();
  },
  { passive: true },
);
$("filesMore").addEventListener("click", (e) => e.target.closest("#loadMoreBtn") && loadMore());

function updateRow(id) {
  const row = $("files").querySelector(`tr[data-id="${id}"]`);
  if (!row) return;
  const sel = state.selected.has(id);
  row.classList.toggle("row-sel", sel);
  row.classList.toggle("playing", state.playingId === id);
  row.querySelector("input").checked = sel;
  const f = state.scan.files.find((x) => x.id === id);
  if (f) {
    row.querySelector(".state-m").innerHTML = stateCell(f);
    row.querySelector(".play").innerHTML = playCell(f);
    row.querySelector(".fav").innerHTML = plButtons(f, favCell(f));
  }
}

function updateSelection() {
  const files = state.scan ? state.scan.files.filter((f) => state.selected.has(f.id)) : [];
  const total = files.reduce((s, f) => s + (f.size || 0), 0);
  $("selInfo").innerHTML = files.length
    ? `<span class="badge text-bg-primary rounded-pill">${files.length}</span> <span class="d-none d-sm-inline">${t("file được chọn")}</span><span class="d-sm-none">${t("bài đã chọn")}</span>${total ? ` · <strong>${fmt(total)}</strong>` : ""}`
    : `<span class="small text-body-secondary hint">${t("<kbd>Shift</kbd> + bấm để chọn liên tiếp")}</span>`;
  $("downloadBtn").disabled = !files.length;
  $("addPlBtn").disabled = !files.some(playable);
  renderDupSteps();
  // ♥: "Bỏ yêu thích" when every ticked file already is
  const allFav = files.length > 0 && files.every(isFav);
  const favLabel = allFav ? t("Bỏ khỏi yêu thích") : t("Thêm vào yêu thích");
  $("favSelBtn").disabled = !files.length;
  $("favSelBtn").title = favLabel;
  $("favSelBtn").innerHTML =
    `<i class="bi ${allFav ? "bi-heart-fill" : "bi-heart"}"></i> <span class="d-none d-md-inline">${favLabel}</span>`;
  $("downloadBtn").querySelector("span").textContent = files.length
    ? t("Tải xuống ({n})", { n: files.length })
    : t("Tải xuống");

  const visible = visibleFiles();
  const n = visible.filter((f) => state.selected.has(f.id)).length;
  $("headCheck").checked = visible.length > 0 && n === visible.length;
  $("headCheck").indeterminate = n > 0 && n < visible.length;
}

$("files").addEventListener("click", (e) => {
  const addPl = e.target.closest("[data-addpl]");
  if (addPl) {
    const f = state.scan.files.find((x) => x.id === Number(addPl.dataset.addpl));
    return f && pickPlaylist([favId(f, state.scan)]);
  }
  const removePl = e.target.closest("[data-plremove]");
  if (removePl) return removeFromPlaylist(Number(removePl.dataset.plremove));
  if (e.target.closest("[data-grip]")) return; // dragged, not clicked
  const favBtn = e.target.closest("[data-fav]");
  if (favBtn) return toggleFav(Number(favBtn.dataset.fav));
  const playBtn = e.target.closest("[data-play]");
  if (playBtn) return play(Number(playBtn.dataset.play));
  const prevBtn = e.target.closest("[data-preview]");
  if (prevBtn) return openPreview(Number(prevBtn.dataset.preview));
  const row = e.target.closest("tr");
  if (!row) return;
  const id = Number(row.dataset.id);
  // A click on an audio row plays it; the checkbox (or Shift / Ctrl + click) selects it for download.
  const onCheck = e.target.closest("td")?.cellIndex === 0;
  const f = state.scan.files.find((x) => x.id === id);
  if (!onCheck && !e.shiftKey && !e.ctrlKey && !e.metaKey && f && playable(f)) return play(id);
  const on = !state.selected.has(id);

  if (e.shiftKey && state.lastClicked !== null) {
    // Shift+click: apply the same state to every visible row between the two clicks.
    const ids = visibleFiles().map((f) => f.id);
    const [a, b] = [ids.indexOf(state.lastClicked), ids.indexOf(id)].sort((x, y) => x - y);
    if (a >= 0)
      ids.slice(a, b + 1).forEach((i) => {
        on ? state.selected.add(i) : state.selected.delete(i);
        updateRow(i);
      });
  } else {
    on ? state.selected.add(id) : state.selected.delete(id);
    updateRow(id);
  }
  state.lastClicked = id;
  updateSelection();
});

function selectVisible(on) {
  visibleFiles().forEach((f) => (on ? state.selected.add(f.id) : state.selected.delete(f.id)));
  renderFiles();
}

$("headCheck").addEventListener("change", (e) => selectVisible(e.target.checked));
$("fileSearch").addEventListener("input", (e) => {
  state.query = e.target.value;
  renderFiles();
});

function setType(type) {
  if (type === state.type) return;
  state.type = type;
  try {
    localStorage.setItem("type", state.type);
  } catch {}
  state.selected.clear();
  loadFiles();
}

$("typeSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) setType(b.dataset.type);
});

// ---------- phones: filter sheet + channel list / file list screens ----------

$("sortSelM").innerHTML = $("sortSel").innerHTML;

/** Mirror the current filters into the phone sheet, and show how many differ from the defaults. */
function syncFilterSheet() {
  $("typeSelM").value = state.type;
  $("sortSelM").value = state.sort;
  const active = (state.type !== "all") + (state.sort !== "default");
  $("filterBadge").textContent = active;
  show($("filterBadge"), active > 0);
  if (state.scan) $("filterCount").textContent = $("fileCount").textContent;
}

$("typeSelM").addEventListener("change", (e) => setType(e.target.value));
$("sortSelM").addEventListener("change", (e) => setSort(e.target.value));
$("filterSheet").addEventListener("show.bs.offcanvas", syncFilterSheet);

const isPhone = () => matchMedia("(max-width: 575.98px), (max-height: 500px) and (orientation: landscape)").matches;

/** Phones show one screen at a time; the browser/phone Back button returns to the channel list. */
/** The start screen: the cat on a phone (one screen at a time), the channel list beside it otherwise. */
const homeView = () => (isPhone() ? "home" : "chats");

function setView(view, push = true) {
  $("mainView").dataset.view = view;
  // One history entry for the list screen: opening another list from it (a song's own list from the player,
  // Favourites…) must not stack more, or Back / the ‹ button had to be pressed once per list.
  if (view === "files" && push && isPhone() && history.state?.view !== "files") {
    // opened straight from the cat (the song's name in the player): put the channel list in between, so ‹ / Back
    // goes to the channels first, as it does after picking a channel
    if (history.state?.view !== "chats") history.pushState({ view: "chats" }, "");
    history.pushState({ view: "files" }, "");
  }
}
$("navBackBtn").addEventListener("click", () => (history.state?.view === "files" ? history.back() : setView("chats")));
// phone Back: files → channel list → the cat
window.addEventListener("popstate", (e) => {
  const v = e.state?.view;
  setView(!isPhone() || v === "chats" ? "chats" : v === "files" ? "files" : homeView(), false);
});

// ---------- phones: tap the cat → channel list (Camera Shake + Whip Pan + white Flash + Push) ----------

let catFx = false;
function catToChats() {
  if (catFx || $("mainView").dataset.view !== "home") return;
  const go = () => {
    setView("chats");
    history.pushState({ view: "chats" }, ""); // Back returns to the cat
  };
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return go();
  catFx = true;
  const main = $("mainView");
  const flash = $("fxFlash");
  main.classList.add("fx-shake"); // 1. the camera shakes
  setTimeout(() => main.classList.replace("fx-shake", "fx-whip"), 300); // 2. whip pan away, motion blur
  setTimeout(() => flash.classList.add("on"), 440); // 3. white flash over the cut
  setTimeout(() => {
    main.classList.remove("fx-whip");
    go();
    main.classList.add("fx-push"); // 4. the channel list pushes in
  }, 520);
  setTimeout(() => flash.classList.remove("on"), 590);
  setTimeout(() => {
    main.classList.remove("fx-push");
    catFx = false;
  }, 1050);
}
$("emptyCat").addEventListener("click", catToChats);
$("emptyCatDance").addEventListener("click", catToChats);
/**
 * The song in the player → its list, from wherever the user is (another chat, the favourites, the chat
 * list on a phone): the list kept in memory is shown again (no rescan, loaded pages kept), scrolled to the
 * song, which flashes briefly.
 */
/** A song of "Phát gần đây" / another list: open its chat's list, read on until it is there, show it. */
async function showSongInItsChat(f) {
  const [chatPart, msgPart] = String(f?.fav || "").split("|");
  if (!msgPart) return;
  // the list id is the chat's own id; the chat list uses Telegram's marked ids (-100… channels, -… groups)
  const dialog = state.dialogs.find((d) => [chatPart, `-${chatPart}`, `-100${chatPart}`].includes(d.id));
  if (!dialog) return toast(t("Kênh của bài này không có trong danh sách kênh"), "warn");
  const msgId = Number(msgPart);
  // a type filter that can show this song (video / photo / document lists would not)
  if (!["all", "music", "voice"].includes(state.type) || (f.kind === "voice") !== (state.type === "voice")) {
    state.type = f.kind === "voice" ? "voice" : "music";
  }
  setPanelOpen(false);
  if (state.chat !== dialog.id || !state.scan || state.scan.key.split("|")[1] !== state.type) await openChat(dialog.id);
  else setView("files");
  for (
    let pages = 0;
    state.scan && !state.scan.files.some((x) => x.id === msgId) && state.scan.more && pages < 20;
    pages++
  )
    await loadMore();
  if (!state.scan?.files.some((x) => x.id === msgId))
    return toast(t("Không tìm thấy bài trong kênh (có thể tin đã bị xoá)"), "warn");
  if (!$("files").querySelector(`tr[data-id="${msgId}"]`)) {
    state.query = "";
    $("fileSearch").value = "";
    renderFiles(); // hidden by the search
  }
  flashRow($("files").querySelector(`tr[data-id="${msgId}"]`));
}

/** Scroll a row into the middle of the list and flash it. */
function flashRow(row) {
  if (!row) return;
  row.scrollIntoView({
    block: "center",
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  });
  row.classList.remove("row-flash");
  void row.offsetWidth; // restart the animation when clicked again
  row.classList.add("row-flash");
  setTimeout(() => row.classList.remove("row-flash"), 1800);
}

function showPlayingList() {
  const scan = state.playScan;
  if (!scan || state.playingId === null) return;
  if (scan.recent) return showSongInItsChat(scan.files.find((f) => f.id === state.playingId));
  if (state.scan !== scan) {
    const chat = scan.fav ? FAV_CHAT : state.keyChat.get(scan.key);
    if (!chat) return;
    state.loadToken++; // a scan of another chat still running is dropped
    stopScan();
    setScanning(false);
    state.loadingMore = false;
    state.chat = chat;
    state.selected.clear();
    state.query = "";
    $("fileSearch").value = "";
    if (!scan.fav && !scan.playlist) {
      state.type = scan.key.split("|")[1] || state.type; // the list was read with this type filter
      document
        .querySelectorAll("#typeSeg button")
        .forEach((b) => b.classList.toggle("active", b.dataset.type === state.type));
    }
    $("chatView").classList.toggle("fav-view", scan.fav === true);
    $("chatView").classList.toggle("search-view", scan.search === true);
    $("chatView").classList.toggle("pl-view", !!scan.playlist);
    state.scan = scan;
    showChat(true);
    $("chatTitle").textContent = scanTitle(scan);
    $("chatMembers").textContent = membersText(state.keyChat.get(scan.key));
    renderDialogs();
    renderFiles();
  }
  setView("files");
  setRailOpen(false);
  let row = $("files").querySelector(`tr[data-id="${state.playingId}"]`);
  if (!row) {
    // hidden by the search / the favourites' chat choice: show everything
    state.query = "";
    $("fileSearch").value = "";
    if (scan.fav) state.favScope = "all";
    renderFiles();
    row = $("files").querySelector(`tr[data-id="${state.playingId}"]`);
  }
  flashRow(row);
}

/** The DLiMusic logo: back to the start screen (the cat); the song keeps playing. */
function goHome() {
  if (state.auth?.step !== "ready") return;
  state.loadToken++; // a scan still running is dropped
  stopScan();
  setScanning(false);
  state.loadingMore = false;
  state.chat = null;
  state.scan = null; // the playing list stays in the player (state.playScan): the dock still opens it
  state.selected.clear();
  state.query = "";
  $("fileSearch").value = "";
  $("chatView").classList.remove("fav-view", "search-view", "pl-view");
  showChat(false);
  renderDialogs();
  updateSelection();
  setView(homeView(), false); // a phone shows the cat again
  if (history.state?.view) history.replaceState(null, "");
}
$("homeLink").addEventListener("click", (e) => {
  e.preventDefault();
  goHome();
});

// Only the song's name opens its list (not the picture, the chat's name or the space around them).
$("npTitle").addEventListener("click", () => showPlayingList());
$("npTitle").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  showPlayingList();
});
$("reloadBtn").addEventListener("click", () => state.chat && !state.scanning && loadFiles({ fresh: true }));
$("folderBtn").addEventListener("click", () =>
  api("/api/open-folder", { key: state.scan?.key }).catch((e) => {
    if (e.code !== "NEED_DIR") return toast(e.message, "error");
    toast(t("Chưa chọn thư mục tải xuống — hãy chọn trong Cài đặt"), "warn");
    openSettings();
  }),
);

// ---------- player ----------

state.playingId = null;
state.playingKey = null;
state.isPlaying = false;
let seeking = false; // user is dragging the seek bar

/** Files the player can play one after another (music / voice; not photos, videos or documents). */
const playable = (f) => !VISUAL.has(f.kind) && f.kind !== "document";

/**
 * Play a file of the open list. The queue is that list as shown right now (filters, sort and, in
 * "Bài hát yêu thích", the chosen chat) but not narrowed by the search: a search only finds where to
 * start, then the songs after it in the list follow.
 */
function play(id) {
  if (state.playingId === id && state.playingKey === state.scan.key) return togglePlay();
  state.playQueue = visibleFiles({ withSearch: false })
    .filter(playable)
    .map((f) => f.id);
  state.playOrder = orderFrom(id);
  playFrom(state.scan, id);
}

/** A new page of the list that is playing: its songs join the end of the queue. */
function extendQueue(scan) {
  if (state.playScan !== scan) return;
  const queued = new Set(state.playQueue);
  const fresh = visibleFiles({ withSearch: false })
    .filter(playable)
    .map((f) => f.id)
    .filter((id) => !queued.has(id));
  if (!fresh.length) return;
  state.playQueue.push(...fresh);
  if (state.shuffle) {
    for (let i = fresh.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [fresh[i], fresh[j]] = [fresh[j], fresh[i]];
    }
  }
  state.playOrder.push(...fresh);
  updateNavButtons();
}

/** The play order for the queue: as listed, or shuffled with the chosen song first. */
function orderFrom(id) {
  if (!state.shuffle) return [...state.playQueue];
  const rest = state.playQueue.filter((x) => x !== id);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return state.playQueue.includes(id) ? [id, ...rest] : rest;
}

function playFrom(scan, id) {
  const player = $("player");
  const prev = state.playingId;
  const prevKey = state.playingKey;
  const f = scan.files.find((x) => x.id === id);
  if (!f) return;
  state.playScan = scan;
  state.playingId = id;
  state.playingKey = scan.key;
  addRecent(f, scan);
  lastTime = 0;
  resumeAt = null;
  netRetries = 0;
  clearTimeout(netRetryTimer);
  // Downloaded files play from disk; others stream straight from Telegram (preview, nothing is saved).
  player.src = `/api/media?key=${encodeURIComponent(scan.key)}&id=${id}`;
  show($("playerBar"), true);
  $("npTitle").textContent = displayName(f);
  $("npSub").innerHTML =
    `<span class="badge ${f.downloaded ? "text-bg-success" : "text-bg-warning"}">${f.downloaded ? t("Từ máy") : t("Nghe thử")}</span> ` +
    esc(f.performer || f.chat || scan.title || "");
  $("curTime").textContent = "0:00";
  $("durTime").textContent = f.duration ? fmtDur(f.duration) : "0:00";
  $("seekRange").value = 0;
  paintSeek();
  if (state.scan?.key === scan.key) {
    if (prev !== null && prevKey === scan.key) updateRow(prev);
    updateRow(id);
  }
  updateNavButtons();
  renderPlayerFav();
  // Lock screen / headphones / notification: title, chat, ⏮ ⏭ (phones and desktop media keys).
  if ("mediaSession" in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: displayName(f),
        artist: f.performer || f.chat || scan.title || "",
        album: "DLiMusic",
        // square and opaque: the lock screen / Control Center shows transparent corners as white
        artwork: [{ src: "img/artwork-512.jpg", sizes: "512x512", type: "image/jpeg" }],
      });
    } catch {}
  }
  player.play().catch(() => {});
  if (revealNext) {
    revealNext = false;
    requestAnimationFrame(revealPlaying); // once its row shows as playing
  }
}

/**
 * The play order as it is now: playing "Bài hát yêu thích", a song whose heart was taken off since is left out
 * (the playing one plays on; hearted again, it is back in its place). Read each time a song is picked.
 */
function liveOrder() {
  const scan = state.playScan;
  if (!scan || (!scan.playlist && !scan.fav && !state.hidden.size)) return state.playOrder;
  const byId = new Map(scan.files.map((f) => [f.id, f]));
  const keep = (f) =>
    !state.hidden.has(favId(f, scan)) && // ③ hidden for this visit
    (scan.playlist ? inPlaylist(f, scan) : !scan.fav || state.favorites.has(favId(f, scan)));
  return state.playOrder.filter((id) => id === state.playingId || (byId.has(id) && keep(byId.get(id))));
}

/** ⏭ is greyed out at the end of the list when nothing repeats. */
function updateNavButtons() {
  const order = liveOrder();
  const i = order.indexOf(state.playingId);
  $("nextBtn").disabled = !state.playScan || (state.repeat === "off" && i >= order.length - 1);
  $("prevBtn").disabled = !state.playScan;
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
    } catch {} // not every browser knows every action
  }
}

/** ⏭ / end of a song: the next one of its list (even if another chat is open now). `skip`: the song
 * could not be played, so even "repeat one" moves on. */
function playNext(auto = false, { skip = false } = {}) {
  if (!state.playScan) return;
  revealNext = true;
  const player = $("player");
  if (auto && state.repeat === "one" && !skip) {
    player.currentTime = 0;
    return void player.play().catch(() => {});
  }
  const order = liveOrder();
  const i = order.indexOf(state.playingId);
  let next = order[i + 1];
  if (next === undefined && state.repeat !== "off" && order.length) {
    if (state.shuffle) state.playOrder = orderFrom(null); // a fresh shuffle for the next round
    next = liveOrder()[0];
  }
  if (next === undefined && state.playScan === state.scan && state.scan.more) {
    // the end of what is loaded, but the chat has more: read the next page, then go on
    const before = state.playOrder.length;
    loadMore().then(() => state.playOrder.length > before && playNext(auto));
    return;
  }
  if (next === undefined) {
    if (!auto) toast(t("Đã hết danh sách phát"), "info");
    return;
  }
  playFrom(state.playScan, next);
}

/** ⏮: back to the start of the song, or (in its first 3 seconds) the song before. */
function playPrev() {
  const player = $("player");
  if (!state.playScan) return;
  revealNext = true;
  const order = liveOrder();
  const i = order.indexOf(state.playingId);
  let prev = order[i - 1];
  if (prev === undefined && state.repeat === "all" && order.length > 1) prev = order[order.length - 1];
  if (player.currentTime > 3 || prev === undefined) {
    player.currentTime = 0;
    return void player.play().catch(() => {});
  }
  playFrom(state.playScan, prev);
}

// 1st press repeats the song that is playing (what "repeat on" means to most people), 2nd the whole list
const REPEAT_NEXT = { off: "one", one: "all", all: "off" };
const REPEAT_TITLE = { off: "Lặp lại: tắt", one: "Lặp lại bài này", all: "Lặp lại cả danh sách" };

/** Shuffle / repeat buttons show their state (lit when on, "1" badge for one song); kept between visits. */
function renderModes() {
  const sh = $("shuffleBtn");
  sh.classList.toggle("on", state.shuffle);
  sh.setAttribute("aria-pressed", state.shuffle);
  sh.title = state.shuffle ? t("Phát ngẫu nhiên: bật") : t("Phát ngẫu nhiên: tắt");
  const rp = $("repeatBtn");
  rp.classList.toggle("on", state.repeat !== "off");
  rp.setAttribute("aria-pressed", state.repeat !== "off");
  rp.title = t(REPEAT_TITLE[state.repeat]);
  rp.innerHTML = `<i class="bi ${state.repeat === "one" ? "bi-repeat-1" : "bi-repeat"}"></i>`;
  try {
    localStorage.setItem("playModes", JSON.stringify({ shuffle: state.shuffle, repeat: state.repeat }));
  } catch {}
  if (typeof updateNavButtons === "function") updateNavButtons();
}

try {
  const saved = JSON.parse(localStorage.getItem("playModes") || "{}");
  state.shuffle = saved.shuffle === true;
  if (saved.repeat in REPEAT_NEXT) state.repeat = saved.repeat;
} catch {}
renderModes();

$("shuffleBtn").addEventListener("click", () => {
  state.shuffle = !state.shuffle;
  if (state.playScan) state.playOrder = orderFrom(state.playingId); // the playing song stays, the rest re-orders
  renderModes();
  toast(state.shuffle ? t("Phát ngẫu nhiên: bật") : t("Phát ngẫu nhiên: tắt"), "info");
});
$("repeatBtn").addEventListener("click", () => {
  state.repeat = REPEAT_NEXT[state.repeat];
  renderModes();
  toast(t(REPEAT_TITLE[state.repeat]), "info");
});
// ---------- playback speed (kept between visits, applies to every song) ----------

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
  const p = $("player");
  p.defaultPlaybackRate = rate; // also for the next songs (a new src resets playbackRate in some browsers)
  p.playbackRate = rate;
  $("emptyCatDance").style.setProperty("--cat-rate", rate); // the dancing kittens keep pace
  $("speedBtn").textContent = `${rate}x`;
  $("speedBtn").classList.toggle("on", rate !== 1);
  $("speedVal").textContent = `${rate.toFixed(1)}x`;
  $("speedRange").value = rate;
  $("speedList").innerHTML = SPEEDS.map(
    ([r, label]) =>
      `<button type="button" class="dropdown-item d-flex align-items-center gap-3${r === rate ? " active" : ""}" data-speed="${r}">
      <small class="speed-tag">${r}x</small><span class="flex-grow-1">${t(label)}</span>${r === rate ? '<i class="bi bi-check2"></i>' : ""}</button>`,
  ).join("");
  if (save)
    try {
      localStorage.setItem("speed", String(rate));
    } catch {}
}

$("speedRange").addEventListener("input", (e) => setSpeed(e.target.value));
$("speedList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-speed]");
  if (!b) return;
  setSpeed(b.dataset.speed);
  bootstrap.Dropdown.getOrCreateInstance($("speedBtn")).hide();
});
$("player").addEventListener("loadedmetadata", (e) => (e.target.playbackRate = e.target.defaultPlaybackRate));
let savedSpeed = 1;
try {
  savedSpeed = Number(localStorage.getItem("speed")) || 1;
} catch {}
setSpeed(savedSpeed, false);

// ---------- sleep timer: pause after some minutes (across songs), or when the playing song ends ----------

const SLEEP_MINUTES = [10, 15, 20, 30, 45, 60];
const SLEEP_FADE = 10_000; // the volume goes down over the last 10 seconds, then the song pauses
// mode: "off" | "min" (endsAt: a wall-clock time, so a throttled background tab still stops on time) | "end"
const sleep = { mode: "off", endsAt: 0, timer: null, fadeFrom: null };

/** Seconds left of the playing song, at the current speed (null when not known). */
function songLeft() {
  const p = $("player");
  if (!p.src || !Number.isFinite(p.duration)) return null;
  return Math.max(0, (p.duration - p.currentTime) / (p.playbackRate || 1));
}

/** Milliseconds until the timer stops the music (null: off, or the song's length is not known yet). */
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
  if (on && left !== null) $("sleepLeft").textContent = fmtDur(Math.ceil(left / 1000));
}

function renderSleepList() {
  const item = (key, label, sub = "") =>
    `<button type="button" class="dropdown-item d-flex align-items-center gap-2${sleepKey() === key ? " active" : ""}" data-sleep="${key}">
      <span class="flex-grow-1">${label}${sub ? `<small class="d-block sleep-sub">${sub}</small>` : ""}</span>${sleepKey() === key ? '<i class="bi bi-check2"></i>' : ""}</button>`;
  const s = songLeft();
  $("sleepList").innerHTML = [
    item("off", t("Tắt")),
    ...SLEEP_MINUTES.map((n) => item(String(n), t("{n} phút", { n }))),
    item("end", t("Hết bài này"), s !== null ? fmtDur(Math.ceil(s)) : ""),
  ].join("");
}
const sleepKey = () => (sleep.mode === "min" ? String(sleep.minutes) : sleep.mode);

/** The volume back to where it was before the fade (the next song plays at the normal volume). */
function endFade() {
  if (sleep.fadeFrom !== null) $("player").volume = sleep.fadeFrom;
  sleep.fadeFrom = null;
}

function setSleep(mode, minutes = 0) {
  clearInterval(sleep.timer);
  endFade();
  Object.assign(sleep, { mode, minutes, endsAt: mode === "min" ? Date.now() + minutes * 60_000 : 0, timer: null });
  if (mode !== "off") sleep.timer = setInterval(sleepTick, 1000);
  renderSleep();
}

/** Every second (and on every timeupdate): the countdown on the button, the fade, and the stop. */
function sleepTick() {
  if (sleep.mode === "off") return;
  const p = $("player");
  const left = sleepLeft();
  renderSleep();
  if (left === null) return;
  if (sleep.mode === "min" && left <= 0) return sleepStop();
  // iPhones ignore volume set by a page: there it just pauses, without the fade
  if (left <= SLEEP_FADE && !p.paused) {
    sleep.fadeFrom ??= p.volume;
    p.volume = sleep.fadeFrom * Math.max(0, left / SLEEP_FADE);
  } else if (left > SLEEP_FADE) endFade(); // sought back out of the last seconds
}

/** Time is up: pause (the song stays, ▶ goes on from there), the volume back, the timer off. */
function sleepStop() {
  const playing = !$("player").paused;
  $("player").pause();
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
$("player").addEventListener("timeupdate", sleepTick);
renderSleep();

/**
 * Another song of the list (⏮ / ⏭, the end of a song, the headphones' or lock screen's buttons): the song now
 * playing is brought into view in the open list (if it is that list and the row is off screen; a row already seen
 * stays put).
 */
function revealPlaying() {
  if (!state.scan || state.scan !== state.playScan) return;
  const row = $("files").querySelector(`tr[data-id="${state.playingId}"]`);
  if (!row) return; // hidden by the search / a filter
  const box = $("filesWrap").getBoundingClientRect();
  const r = row.getBoundingClientRect();
  const head = $("filesWrap").querySelector("thead")?.getBoundingClientRect().height || 0; // the sticky header
  if (r.top >= box.top + head && r.bottom <= box.bottom) return;
  row.scrollIntoView({ block: "center", behavior: "smooth" });
}
let revealNext = false; // playNext / playPrev: the song it starts (maybe after the next page is read) is shown
$("prevBtn").addEventListener("click", () => playPrev());
$("nextBtn").addEventListener("click", () => playNext());

function togglePlay() {
  const p = $("player");
  if (!p.src) return;
  p.paused ? p.play().catch(() => {}) : p.pause();
}

function seek(delta) {
  const p = $("player");
  if (!p.src) return;
  const end = Number.isFinite(p.duration) ? p.duration : Infinity;
  p.currentTime = Math.min(Math.max(0, p.currentTime + delta), end);
}

function syncTime() {
  const p = $("player");
  const dur = Number.isFinite(p.duration) ? p.duration : 0;
  if (!seeking) {
    $("curTime").textContent = fmtDur(p.currentTime) || "0:00";
    $("seekRange").value = dur ? Math.round((p.currentTime / dur) * 1000) : 0;
  }
  if (dur) $("durTime").textContent = fmtDur(dur);
  paintSeek();
}

/** The seek bar like YouTube's: played part in colour, the part already loaded lighter, the rest dark. */
// Browser build: how far each song is fetched from Telegram (web/backend.js keeps fetching while it plays or is
// paused), media URL -> fraction. The grey bar shows that, not only what the player itself has buffered.
const fetched = new Map();

function paintSeek() {
  const p = $("player");
  const bar = $("seekRange");
  const dur = Number.isFinite(p.duration) ? p.duration : 0;
  let loaded = 0; // end of the loaded stretch that holds the current time
  for (let i = 0; dur && i < p.buffered.length; i++)
    if (p.buffered.start(i) <= p.currentTime + 1 && p.buffered.end(i) > loaded) loaded = p.buffered.end(i);
  let pct = dur ? (loaded / dur) * 100 : 0;
  try {
    const u = new URL(p.src);
    pct = Math.max(pct, (fetched.get(u.pathname + u.search) || 0) * 100);
  } catch {} // no song yet
  bar.style.setProperty("--played", `${bar.value / 10}%`);
  bar.style.setProperty("--loaded", `${Math.min(100, pct)}%`);
}

$("playBtn").addEventListener("click", togglePlay);
$("backBtn").addEventListener("click", () => seek(-10));
$("fwdBtn").addEventListener("click", () => seek(10));
$("seekRange").addEventListener("input", (e) => {
  // Preview the target time while dragging; jump when released.
  seeking = true;
  const dur = $("player").duration;
  if (Number.isFinite(dur)) $("curTime").textContent = fmtDur((e.target.value / 1000) * dur) || "0:00";
  paintSeek();
});
$("player").addEventListener("progress", paintSeek); // more of the song loaded

// Like YouTube: pointing at the seek bar shows the time there above the pointer (kept inside the bar), and the
// bar up to it lighter; while dragging (a finger too) it follows the thumb.
function pointSeek(x) {
  const wrap = $("seekWrap");
  const bar = $("seekRange");
  const dur = $("player").duration;
  const r = bar.getBoundingClientRect();
  if (!Number.isFinite(dur) || !dur || !r.width) return unpointSeek();
  const f = Math.min(1, Math.max(0, (x - r.left) / r.width));
  const tip = $("seekTip");
  tip.textContent = fmtDur(f * dur) || "0:00";
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
$("seekRange").addEventListener("pointermove", (e) => pointSeek(e.clientX));
$("seekRange").addEventListener("pointerdown", (e) => pointSeek(e.clientX));
$("seekRange").addEventListener("pointerleave", () => !seeking && unpointSeek());
$("seekRange").addEventListener("pointerup", (e) => e.pointerType !== "mouse" && unpointSeek());
$("seekRange").addEventListener("pointercancel", unpointSeek);
$("seekRange").addEventListener("change", (e) => {
  const p = $("player");
  if (Number.isFinite(p.duration)) p.currentTime = (e.target.value / 1000) * p.duration;
  seeking = false;
  if (!$("seekRange").matches(":hover")) unpointSeek();
});
$("volRange").addEventListener("input", (e) => {
  $("player").volume = Number(e.target.value);
  $("player").muted = false;
});
$("muteBtn").addEventListener("click", () => ($("player").muted = !$("player").muted));

document.addEventListener("keydown", (e) => {
  // ←/→ skip 10s, Space play/pause — unless typing, on a button, or the confirm dialog is open.
  if (e.target.closest("input, textarea, select") || document.querySelector(".modal.show")) return;
  if (e.altKey || e.ctrlKey || e.metaKey || !$("player").src) return;
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

const player = $("player");
player.addEventListener("timeupdate", syncTime);
player.addEventListener("durationchange", syncTime);
player.addEventListener("seeked", syncTime);
player.addEventListener("volumechange", () => {
  const silent = player.muted || player.volume === 0;
  $("muteBtn").innerHTML =
    `<i class="bi ${silent ? "bi-volume-mute-fill" : player.volume < 0.5 ? "bi-volume-down-fill" : "bi-volume-up-fill"}"></i>`;
  $("volRange").value = player.muted ? 0 : player.volume;
});
for (const evt of ["play", "pause", "ended"]) {
  player.addEventListener(evt, () => {
    state.isPlaying = evt === "play";
    $("playBtn").innerHTML = `<i class="bi ${state.isPlaying ? "bi-pause-fill" : "bi-play-fill"}"></i>`;
    if (state.playingId !== null && state.scan?.key === state.playingKey) updateRow(state.playingId);
    renderRecent(); // ▶ / sound wave on the song in "Phát gần đây"
    updateSongRows(); // ▶ / ⏸ on the songs under the search box
    setHomeCat(state.isPlaying);
  });
}
// Browser build: this song, then the next two, are fetched whole while this one plays (web/backend.js -> prefetch), so a
// locked phone, which may stall the page's Telegram connection, still goes on to them.
let prefetchFor = null;
player.addEventListener("playing", async () => {
  if (!state.playScan || state.repeat === "one") return;
  const scan = state.playScan;
  const at = `${scan.key}|${state.playingId}`;
  if (prefetchFor === at) return; // once per song (playing also fires after every buffering pause)
  prefetchFor = at;
  const order = liveOrder();
  const i = order.indexOf(state.playingId);
  const ahead = [order[i + 1], order[i + 2] ?? (state.repeat === "all" ? order[0] : undefined)].filter(
    (id) => id !== undefined && id !== state.playingId,
  );
  // the local server fetches them into its cache, one after the other (the playing song first)
  if (!BACKEND) return void api("/api/prefetch", { key: scan.key, ids: [state.playingId, ...ahead] }).catch(() => {});
  await BACKEND.prefetch(scan.key, state.playingId); // this song first (already on its way), then the next ones
  for (const id of ahead) {
    if (prefetchFor !== at) return;
    await BACKEND.prefetch(scan.key, id);
  }
});

// ---------- the bridge between two songs (screen locked) ----------
// While the next song starts — a long mix (over the browser build's NEXT_MAX) is not fetched ahead: it opens its
// Telegram stream only then — nothing plays, and a phone with the screen locked puts a silent page to sleep: the
// next song never started, the music stopped "after a few songs". A second player playing silence in a loop covers
// that moment (like the app's keeper), until the song plays. A phone lets a page start a sound only after a tap:
// it is readied on the first one. Where a phone allows one sound at a time, the song's play() stops it (as before).
const bridge = new Audio("sounds/silence.wav");
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
player.addEventListener("pause", () => bridgeOn(false)); // paused by the user, the lock screen, a call…

player.addEventListener("ended", () => {
  // The stream was cut (network) long before the song's real end: continue it instead of moving on.
  const f = state.playScan?.files.find((x) => x.id === state.playingId);
  if (f?.duration && lastTime < f.duration - 5 && connectionLost()) return;
  // sleep timer "Hết bài này": stop here, not even "repeat one" plays it again
  if (sleep.mode === "end") {
    setSleep("off");
    return toast(t("Hết giờ hẹn, nhạc đã tạm dừng"), "info");
  }
  const was = state.playingId;
  bridgeOn(true);
  playNext(true);
  // nothing comes next (the end of the list): no bridge; reading the chat's next page keeps it until that plays
  if (state.playingId === was && !(state.playScan === state.scan && state.scan?.more)) bridgeOn(false);
});
// ---------- the start screen's cat: dancing kittens while music plays, the cat with headphones otherwise ----------

// The kittens are 39 frames stacked in one picture that CSS steps through, so their speed can follow the
// song's playback speed (an animated GIF / WebP always runs at its own speed).
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
  // Swap only once the kittens are ready: the stepping animation on the still cat, while the strip was still
  // loading, slid the headphones cat up and down for a moment.
  if (catDances) loadDanceCat().then(() => catDances && showHomeCat(true));
  else showHomeCat(false);
}
function showHomeCat(dance) {
  // two elements, one shown at a time: the cat picture, or the kittens drawn by CSS (.cat-dance)
  $("emptyCat").classList.toggle("d-none", dance);
  $("emptyCatDance").classList.toggle("d-none", !dance);
}
player.addEventListener("loadstart", loadDanceCat); // a song in the player: get the kittens ready

// ---------- reloading the page while a song plays: it goes on where it was ----------

const PLAYBACK_KEY = "tdl.playback"; // { acct, chat, key, id, time, playing, at } in this browser only
let playbackSaved = 0;

function savePlayback(force = false) {
  if (state.playingId === null || !state.playScan || !state.auth?.me) return;
  if (!force && Date.now() - playbackSaved < 2000) return; // timeupdate fires 4×/s: every 2 s is enough
  playbackSaved = Date.now();
  const chat = state.playScan.fav ? FAV_CHAT : state.playScan.recent ? "recent" : state.keyChat.get(state.playScan.key);
  if (!chat) return;
  try {
    localStorage.setItem(
      PLAYBACK_KEY,
      JSON.stringify({
        acct: state.auth.me.id,
        chat,
        key: state.playScan.key,
        id: state.playingId,
        // a song search numbers its songs itself: found again by "<chat id>|<message id>" after a reload
        fav: state.playScan.files.find((f) => f.id === state.playingId)?.fav || null,
        time: Math.max(lastTime, player.currentTime || 0),
        playing: !player.paused,
        at: Date.now(),
      }),
    );
  } catch {}
}

function forgetPlayback() {
  try {
    localStorage.removeItem(PLAYBACK_KEY);
  } catch {}
}

player.addEventListener("timeupdate", () => savePlayback());
for (const evt of ["play", "pause"]) player.addEventListener(evt, () => savePlayback(true));
window.addEventListener("pagehide", () => savePlayback(true));

/** After signing in (page load): the saved song, its list read again in the background, at its second. */
async function restorePlayback() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(PLAYBACK_KEY) || "null");
  } catch {}
  if (!saved || saved.acct !== state.auth?.me?.id || Date.now() - saved.at > 24 * 3600_000 || state.playingId !== null)
    return;
  try {
    const fav = saved.chat === FAV_CHAT;
    const recent = saved.chat === "recent";
    const plId = isPlChat(saved.chat) ? saved.chat.slice(PL_PREFIX.length) : null;
    const search = isSearchChat(saved.chat) ? saved.chat.slice(SEARCH_CHAT.length) : null;
    if (search !== null && !saved.fav) return;
    const type = fav || recent || plId !== null || search !== null ? null : String(saved.key).split("|")[1] || "all";
    let scan = fav
      ? await api("/api/favorites/files")
      : plId !== null
        ? await api(`/api/playlists/files?id=${encodeURIComponent(plId)}`)
        : recent
          ? await api("/api/recent/files")
          : search !== null
            ? await api(`/api/search/songs?q=${encodeURIComponent(search)}`)
            : await api(`/api/files?chat=${encodeURIComponent(saved.chat)}&type=${encodeURIComponent(type)}`);
    const isSaved = (f) => (search !== null ? f.fav === saved.fav : f.id === saved.id);
    // the song may be on a later page of a long list (500 files each; 50 for a song search)
    for (let pages = 0; !scan.files.some(isSaved) && scan.more && pages < (search !== null ? 4 : 20); pages++) {
      const r = await api(`/api/files/more?key=${encodeURIComponent(scan.key)}`);
      scan.files.push(...r.files.filter((f) => !scan.files.some((x) => x.id === f.id)));
      scan.more = r.more;
    }
    const f = scan.files.find(isSaved);
    if (!f || state.playingId !== null) return; // gone from the chat, or the user already started another song
    if (!recent) state.keyChat.set(scan.key, saved.chat);
    state.playQueue = scan.files.filter(playable).map((x) => x.id);
    state.playOrder = orderFrom(f.id);
    player.addEventListener(
      "loadedmetadata",
      () => {
        player.currentTime = saved.time || 0;
        lastTime = saved.time || 0;
        if (!saved.playing) return player.pause();
        player.play().catch(() => {
          // the browser blocks sound until the user clicks something on the page
          toast(
            t("Bấm ▶ để nghe tiếp “{name}” từ {time}", {
              name: displayName(f),
              time: fmtDur(Math.floor(saved.time || 0)) || "0:00",
            }),
            "info",
          );
        });
      },
      { once: true },
    );
    playFrom(scan, f.id);
    if (!saved.playing) player.pause();
  } catch {
    // the list could not be read (offline, chat left…): nothing to restore
  }
}

// ---------- lost connection: continue where it stopped once it is back (like YouTube) ----------

let lastTime = 0; // last position actually played (currentTime is 0 again after a failed stream)
let resumeAt = null; // { key, id, time, playing } of the song cut by the network
let netRetries = 0;
let netRetryTimer = null;
const NET_RETRY_MS = [2000, 5000, 10000]; // online but the stream broke: try again this many times

player.addEventListener("timeupdate", () => {
  if (player.currentTime > 0) lastTime = player.currentTime;
});
player.addEventListener("playing", () => {
  netRetries = 0;
});

/** Remember the cut song; returns false when it has been retried enough (then it counts as broken). */
function connectionLost() {
  if (state.playingId === null) return false;
  if (!resumeAt || resumeAt.id !== state.playingId || resumeAt.key !== state.playingKey) {
    resumeAt = { key: state.playingKey, id: state.playingId, time: lastTime, playing: true };
  }
  if (!navigator.onLine) return true; // wait for the "online" event
  if (netRetries >= NET_RETRY_MS.length) {
    resumeAt = null;
    netRetries = 0;
    return false;
  }
  clearTimeout(netRetryTimer);
  netRetryTimer = setTimeout(resumePlayback, NET_RETRY_MS[netRetries++]);
  return true;
}

/** Open the same song again and continue from the remembered position. */
function resumePlayback() {
  const at = resumeAt;
  resumeAt = null;
  if (!at || at.id !== state.playingId || at.key !== state.playingKey || !player.getAttribute("src")) return;
  const src = player.getAttribute("src");
  // what was buffered kept playing after the cut: continue from the furthest point actually heard
  const time = Math.max(at.time, lastTime);
  player.addEventListener(
    "loadedmetadata",
    () => {
      player.currentTime = time;
      if (at.playing) player.play().catch(() => {});
    },
    { once: true },
  );
  player.src = src; // a new request for the stream (the old one is dead)
  toast(t("Đã có mạng lại — phát tiếp từ {time}", { time: fmtDur(Math.floor(time)) || "0:00" }), "success");
}

window.addEventListener("offline", () => {
  if (state.playingId === null) return;
  resumeAt = {
    key: state.playingKey,
    id: state.playingId,
    time: lastTime || player.currentTime,
    playing: state.isPlaying || !player.paused,
  };
  toast(t("Mất kết nối mạng — sẽ phát tiếp khi có mạng lại"), "warn");
});
window.addEventListener("online", () => {
  if (!resumeAt) return;
  // what was buffered may still be playing fine: only reopen when the stream is really stuck
  const stuck = player.error || player.readyState < HTMLMediaElement.HAVE_FUTURE_DATA || player.ended;
  if (!stuck) {
    resumeAt = null;
    return;
  }
  clearTimeout(netRetryTimer);
  netRetryTimer = setTimeout(resumePlayback, 1500); // the backend reconnects to Telegram first
});

// A song that cannot be played (broken file, unsupported format, deleted message…) is skipped: the next one
// starts by itself. Many failures in a row usually mean the network is down: then it stops.
const MAX_SKIPS = 5;
let failedInARow = 0;
player.addEventListener("playing", () => {
  failedInARow = 0;
});
player.addEventListener("error", () => {
  if (!player.getAttribute("src") || !state.playScan) return; // the player was just emptied, not a failure
  // network, not a broken song: wait for the connection and continue where it stopped
  if ((!navigator.onLine || player.error?.code === MediaError.MEDIA_ERR_NETWORK) && connectionLost()) return;
  const f = state.playScan.files.find((x) => x.id === state.playingId);
  const name = f ? `“${displayName(f)}”` : t("bài này");
  if (++failedInARow > MAX_SKIPS) {
    failedInARow = 0;
    return toast(t("Nhiều bài liên tiếp không phát được nên đã dừng. Kiểm tra mạng rồi thử lại."), "error");
  }
  const failed = state.playingId;
  const src = player.getAttribute("src");
  // why (the player does not say): the same address asked again for its first bytes, its answer shown
  whyNotPlayed(src).then((why) => {
    toast(t("Không phát được {name} — chuyển sang bài tiếp theo", { name }) + (why ? ` (${why})` : ""), "warn");
  });
  // unless the user picked another song meanwhile
  setTimeout(() => state.playingId === failed && playNext(true, { skip: true }), 600);
});

/** The reason a song could not be played, as its address answers now ("" when it answers fine). */
async function whyNotPlayed(src) {
  try {
    const res = await fetch(src, { headers: { Range: "bytes=0-1" } });
    if (res.ok) return `${t("trình phát không đọc được file")} · ${res.headers.get("Content-Type") || "?"}`;
    const text = (await res.text().catch(() => "")).trim().slice(0, 120);
    return text ? `${res.status}: ${text}` : String(res.status);
  } catch (err) {
    return String(err?.message || err);
  }
}

// ---------- photo / video preview ----------

let previewId = null;

function previewList() {
  return visibleFiles().filter((f) => VISUAL.has(f.kind));
}

function stopPreviewMedia() {
  const v = $("previewStage").querySelector("video");
  if (v) {
    v.pause();
    v.removeAttribute("src"); // stop streaming from Telegram
    v.load();
  }
}

function renderPreview() {
  const f = state.scan.files.find((x) => x.id === previewId);
  if (!f) return;
  stopPreviewMedia();
  const src = `/api/media?key=${encodeURIComponent(state.scan.key)}&id=${f.id}`;
  const stage = $("previewStage");
  stage.innerHTML = `<div class="spinner-border text-light"></div>`;
  const hide = () => stage.querySelector(".spinner-border")?.remove();
  const fail = (msg) => {
    hide();
    stage.insertAdjacentHTML(
      "beforeend",
      `<div class="text-light text-center p-4"><i class="bi bi-exclamation-triangle display-6"></i><p class="mt-2 mb-0">${msg}</p></div>`,
    );
  };
  if (f.kind === "video") {
    const v = document.createElement("video");
    v.controls = true;
    v.autoplay = true;
    v.preload = "metadata";
    v.addEventListener("loadeddata", hide, { once: true });
    v.addEventListener(
      "error",
      () => {
        v.remove();
        fail(t("Trình duyệt không phát được video này (định dạng không hỗ trợ). Bạn vẫn có thể tải về."));
      },
      { once: true },
    );
    v.src = src;
    stage.append(v);
    $("player").pause(); // don't play music and a video at the same time
  } else {
    const img = new Image();
    img.alt = displayName(f);
    img.addEventListener("load", hide, { once: true });
    img.addEventListener(
      "error",
      () => {
        img.remove();
        fail(t("Không xem được ảnh này."));
      },
      { once: true },
    );
    img.src = src;
    stage.append(img);
  }

  const list = previewList();
  const i = list.findIndex((x) => x.id === f.id);
  $("previewTitle").textContent = displayName(f);
  $("previewInfo").textContent = [`${i + 1}/${list.length}`, fmt(f.size), fmtDur(f.duration)]
    .filter(Boolean)
    .join(" · ");
  $("previewPrev").disabled = i <= 0;
  $("previewNext").disabled = i < 0 || i >= list.length - 1;
  const sel = state.selected.has(f.id);
  $("previewSelect").className = `btn btn-sm ${sel ? "btn-primary" : "btn-outline-primary"}`;
  $("previewSelect").querySelector("span").textContent = sel ? t("Đã chọn") : t("Chọn để tải");
  $("previewSelect").querySelector("i").className = `bi ${sel ? "bi-check2-square" : "bi-square"}`;
}

function openPreview(id) {
  previewId = id;
  renderPreview();
  previewModal.show();
}

function stepPreview(delta) {
  const list = previewList();
  const i = list.findIndex((x) => x.id === previewId);
  const next = list[i + delta];
  if (!next) return;
  previewId = next.id;
  renderPreview();
}

$("previewPrev").addEventListener("click", () => stepPreview(-1));
$("previewNext").addEventListener("click", () => stepPreview(1));
$("previewSelect").addEventListener("click", () => {
  state.selected.has(previewId) ? state.selected.delete(previewId) : state.selected.add(previewId);
  updateRow(previewId);
  updateSelection();
  renderPreview();
});
$("previewModal").addEventListener("keydown", (e) => {
  if (e.target.closest("video")) return; // let the video use its own arrow keys (seek)
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    stepPreview(-1);
  }
  if (e.key === "ArrowRight") {
    e.preventDefault();
    stepPreview(1);
  }
});
$("previewModal").addEventListener("hidden.bs.modal", () => {
  stopPreviewMedia();
  $("previewStage").innerHTML = "";
  previewId = null;
});

// ---------- generic modals ----------

/** Hide whichever Bootstrap modal is open and wait until it is gone (Bootstrap cannot stack modals). */
async function hideOpenModals() {
  const open = document.querySelector(".modal.show");
  if (!open) return;
  await new Promise((r) => {
    open.addEventListener("hidden.bs.modal", r, { once: true });
    bootstrap.Modal.getInstance(open).hide();
  });
}

let askResolve = null;
/** Bootstrap yes/no dialog; resolves true when confirmed. */
/** `validate`: before closing on "OK" — returns false to keep the dialog open (it shows why itself). */
let askValidate = null;
async function ask({ title, body, ok = t("Đồng ý"), okClass = "btn-primary", validate = null }) {
  await hideOpenModals();
  askValidate = validate;
  $("askTitle").innerHTML = title;
  $("askBody").innerHTML = body;
  $("askOk").className = `btn ${okClass}`;
  $("askOk").textContent = ok;
  return new Promise((resolve) => {
    askResolve = resolve;
    askModal.show();
  });
}
let askAnswer = false;
$("askOk").addEventListener("click", () => {
  if (askValidate && !askValidate()) return;
  askAnswer = true;
  askModal.hide();
});
$("askModal").addEventListener("shown.bs.modal", () => $("askOk").focus());
$("askModal").addEventListener("hidden.bs.modal", () => {
  const r = askResolve;
  askResolve = null;
  r?.(askAnswer);
  askAnswer = false;
  askValidate = null;
});

// ---------- folder picker ----------

let picker = null; // last listing from /api/fs
let pickResolve = null;
let pickResult = null;

async function pickerLoad(p) {
  try {
    picker = await api(`/api/fs?path=${encodeURIComponent(p || "")}`);
  } catch (err) {
    return toast(err.message, "error");
  }
  $("pickPath").value = picker.path;
  $("pickUp").disabled = !picker.parent;
  show($("pickWarn"), !picker.writable);
  $("pickOk").disabled = !picker.writable;
  $("pickShortcuts").innerHTML = picker.shortcuts
    .map(
      (s) =>
        `<button class="btn btn-sm ${s.path === picker.path ? "btn-primary" : "btn-outline-secondary"}" data-go="${esc(s.path)}"><i class="bi bi-${s.icon}"></i> ${esc(s.label)}</button>`,
    )
    .join("");
  $("pickList").innerHTML = picker.dirs.length
    ? picker.dirs
        .map(
          (
            d,
          ) => `<button type="button" class="list-group-item list-group-item-action d-flex align-items-center gap-2" data-dir="${esc(d)}">
        <i class="bi bi-folder-fill text-warning"></i><span class="text-truncate">${esc(d)}</span><i class="bi bi-chevron-right ms-auto text-body-secondary"></i></button>`,
        )
        .join("")
    : `<div class="list-group-item small text-body-secondary text-center py-3">${t("Không có thư mục con")}</div>`;
}

/**
 * Let the user pick a folder. remember: null hides the "remember as default" checkbox, true/false sets it.
 * Resolves { path, remember } or null when cancelled.
 */
async function pickFolder({ start, remember = null, title = t("Chọn thư mục tải xuống") } = {}) {
  await hideOpenModals();
  if (BACKEND) {
    // The browser's own folder picker; the choice is remembered when "remember" is asked for.
    try {
      const r = await BACKEND.pickDirectory();
      return r && { path: r.path, remember: remember !== false };
    } catch (err) {
      toast(err.message, "error");
      return null;
    }
  }
  $("pickerTitle").innerHTML = `<i class="bi bi-folder2-open text-primary"></i> ${esc(title)}`;
  show($("pickRememberWrap"), remember !== null);
  $("pickRemember").checked = !!remember;
  $("pickNewName").value = "";
  await pickerLoad(start || state.settings.downloadDir);
  return new Promise((resolve) => {
    pickResolve = resolve;
    pickerModal.show();
  });
}

$("pickList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-dir]");
  if (b) pickerLoad(picker.path.replace(/[\\/]+$/, "") + picker.sep + b.dataset.dir);
});
$("pickShortcuts").addEventListener("click", (e) => {
  const b = e.target.closest("[data-go]");
  if (b) pickerLoad(b.dataset.go);
});
$("pickUp").addEventListener("click", () => picker?.parent && pickerLoad(picker.parent));
$("pickGo").addEventListener("click", () => pickerLoad($("pickPath").value));
$("pickPath").addEventListener("keydown", (e) => {
  if (e.key === "Enter") pickerLoad(e.target.value);
});
async function makeDir() {
  const name = $("pickNewName").value.trim();
  if (!name) return $("pickNewName").focus();
  try {
    const { path } = await api("/api/fs/mkdir", { parent: picker.path, name });
    $("pickNewName").value = "";
    await pickerLoad(path);
  } catch (err) {
    toast(err.message, "error");
  }
}
$("pickNewBtn").addEventListener("click", makeDir);
$("pickNewName").addEventListener("keydown", (e) => {
  if (e.key === "Enter") makeDir();
});
$("pickOk").addEventListener("click", () => {
  pickResult = {
    path: picker.path,
    remember: $("pickRemember").checked && !$("pickRememberWrap").classList.contains("d-none"),
  };
  pickerModal.hide();
});
$("pickerModal").addEventListener("hidden.bs.modal", () => {
  const r = pickResolve;
  pickResolve = null;
  r?.(pickResult);
  pickResult = null;
});

// ---------- settings ----------

let settingsDraft = null;

function renderSettingsForm() {
  $("setDir").value = settingsDraft.downloadDir || "";
  $("setDirClear").disabled = !settingsDraft.downloadDir;
  $("setSub").checked = settingsDraft.subfolderPerChat;
  const base = settingsDraft.downloadDir || t("…/thư-mục-tải");
  const sub = settingsDraft.subfolderPerChat ? `/${t("Tên kênh")}` : "";
  $("setExample").innerHTML = t("Ví dụ file sẽ lưu tại: {path}", {
    path: `<code>${esc(base)}${esc(sub)}/${esc(t("Tên bài"))}.mp3</code>`,
  });
}

// ---------- MongoDB copy: its status is shown in the account card ----------

async function refreshCloud() {
  try {
    state.cloud = await api("/api/cloud");
  } catch {
    state.cloud = null;
  }
  renderUserSync();
}

async function openSettings() {
  await hideOpenModals();
  settingsDraft = { ...state.settings };
  renderSettingsForm();
  renderChatsInfo();
  settingsModal.show();
}

$("setSub").addEventListener("change", (e) => {
  settingsDraft.subfolderPerChat = e.target.checked;
  renderSettingsForm();
});
$("setDirClear").addEventListener("click", () => {
  settingsDraft.downloadDir = null;
  renderSettingsForm();
});
$("setDirBtn").addEventListener("click", async () => {
  const draft = settingsDraft;
  const r = await pickFolder({ start: draft.downloadDir });
  settingsDraft = { ...draft, ...(r && { downloadDir: r.path }) };
  renderSettingsForm();
  settingsModal.show();
});
$("settingsSave").addEventListener("click", async () => {
  try {
    await api("/api/settings", {
      downloadDir: settingsDraft.downloadDir,
      subfolderPerChat: settingsDraft.subfolderPerChat,
    });
    settingsModal.hide();
    toast(t("Đã lưu cài đặt"));
  } catch (err) {
    toast(err.message, "error");
  }
});

function applySettings(s) {
  const changed = JSON.stringify(s) !== JSON.stringify(state.settings);
  state.settings = s;
  if (changed) refreshFlags();
}

// ---------- confirm & download ----------

/** Folder the current download goes to (chosen for this download, else the default), or null. */
function downloadBase() {
  return state.dlTarget?.path || state.settings.downloadDir || null;
}

function openConfirm() {
  const files = state.scan.files.filter((f) => state.selected.has(f.id));
  const total = files.reduce((s, f) => s + (f.size || 0), 0);
  const already = files.filter((f) => f.downloaded).length;
  // The destination row is only needed while no default folder is set in Settings.
  const askDir = !state.settings.downloadDir;
  const dirRow = !CAPS.pickFolder
    ? `<div class="d-flex align-items-center gap-2 mt-2 p-2 border rounded bg-body-tertiary small">
         <i class="bi bi-download text-primary"></i><span>${t("Lưu vào <strong>thư mục Tải về</strong> của trình duyệt")}</span></div>`
    : !askDir
      ? ""
      : `<div class="d-flex align-items-center gap-2 mt-2 p-2 border rounded bg-body-tertiary">
       <i class="bi bi-folder2-open text-primary"></i>
       <div class="flex-grow-1 min-w-0 small text-break"><span class="text-body-secondary">${t("Lưu vào:")}</span> ${
         state.dlTarget
           ? `<span class="font-monospace">${esc(state.dlTarget.path)}${state.settings.subfolderPerChat ? `/${esc(state.scan.title)}` : ""}</span>`
           : `<em class="text-warning-emphasis">${t("Chưa chọn thư mục — sẽ hỏi khi bấm Bắt đầu tải")}</em>`
       }</div>
       <button class="btn btn-sm btn-outline-primary flex-none" id="confirmDirBtn">${state.dlTarget ? t("Đổi…") : t("Chọn…")}</button></div>`;
  $("confirmSub").innerHTML =
    `<div>${t("<strong>{n}</strong> file · <strong>{size}</strong>", { n: files.length, size: fmt(total) || "?" })}</div>` +
    dirRow +
    (already
      ? `<div class="alert alert-info py-2 mt-2 mb-0 small"><i class="bi bi-info-circle"></i> ${t("{n} file đã có sẵn sẽ được bỏ qua.", { n: already })}</div>`
      : "");
  $("confirmList").innerHTML = files
    .map(
      (f) =>
        `<li class="list-group-item d-flex gap-2"><span class="flex-grow-1 text-break">${esc(displayName(f))}${displayName(f) !== f.name ? ` <small class="text-body-secondary">(${esc(f.name)})</small>` : ""}${f.downloaded ? ` <span class="badge text-bg-success">${t("Đã có")}</span>` : ""}</span>` +
        `<span class="text-body-secondary small text-nowrap">${fmt(f.size)}</span></li>`,
    )
    .join("");
  $("confirmDirBtn")?.addEventListener("click", async () => {
    const r = await pickFolder({ start: downloadBase(), remember: true });
    if (r) state.dlTarget = r;
    openConfirm();
  });
  confirmModal.show();
}

$("downloadBtn").addEventListener("click", () => {
  state.dlTarget = null;
  openConfirm();
});
$("confirm").addEventListener("shown.bs.modal", () => $("confirmYes").focus());

async function startDownload(target) {
  try {
    const { added, outDir } = await api("/api/download", {
      key: state.scan.key,
      ids: [...state.selected],
      ...(target && { dir: target.path, remember: target.remember }),
    });
    toast(t("Đã thêm {n} file vào hàng chờ → {dir}", { n: added, dir: t(outDir) })); // browser build: "thư mục Tải về…"
    state.selected.clear();
    state.dlTarget = null;
    renderFiles(); // progress: under "Tải xuống" in the header
  } catch (err) {
    if (err.code !== "NEED_DIR") return toast(err.message, "error");
    const picked = await pickFolder({ remember: true });
    if (picked) return startDownload(picked);
  }
}

$("confirmYes").addEventListener("click", async () => {
  let target = state.dlTarget;
  if (!target && !state.settings.downloadDir && CAPS.pickFolder) {
    // No default folder yet: ask where to save (and offer to remember it).
    target = await pickFolder({ remember: true });
    if (!target) return;
  } else {
    await hideOpenModals();
  }
  startDownload(target);
});

/** Re-check which files are on disk (default folder / history changed) without rescanning Telegram. */
let flagsTimer = 0;
function refreshFlags() {
  clearTimeout(flagsTimer);
  flagsTimer = setTimeout(async () => {
    if (!state.scan) return;
    try {
      const fresh = await api(`/api/scan?key=${encodeURIComponent(state.scan.key)}`);
      if (fresh.key !== state.scan?.key) return;
      const flags = new Map(fresh.files.map((f) => [f.id, f.downloaded]));
      for (const f of state.scan.files) f.downloaded = flags.get(f.id) ?? f.downloaded;
      state.scan.outDir = fresh.outDir;
      renderFiles();
    } catch {
      // scan expired on the server (restart); the next reload fixes it
    }
  }, 150);
}

// ---------- downloads panel ----------

const STATUS = {
  queued: ["Đang chờ", "secondary"],
  downloading: ["Đang tải", "primary"],
  done: ["Xong", "success"],
  skipped: ["Đã có", "success"],
  failed: ["Lỗi", "danger"],
  cancelled: ["Đã huỷ", "secondary"],
};

function setPanelOpen(open) {
  state.panelOpen = open; // not remembered: the panel starts closed on every page load
  $("dl").classList.toggle("d-none", !open);
  $("dl").classList.toggle("d-flex", open);
  $("recentBtn").classList.toggle("active", open);
  // On narrow screens the panel is an overlay; add a backdrop that closes it when tapped.
  let backdrop = $("dlBackdrop");
  if (open && !backdrop) {
    backdrop = document.createElement("div");
    backdrop.id = "dlBackdrop";
    backdrop.className = "dl-backdrop";
    backdrop.addEventListener("click", () => setPanelOpen(false));
    document.body.append(backdrop);
  } else if (!open && backdrop) {
    backdrop.remove();
  }
}

function renderJobs() {
  const jobs = [...state.jobs.values()].filter((j) => j.status === "queued" || j.status === "downloading");
  show($("dlMenu"), jobs.length > 0);
  $("dlCount").textContent = jobs.length;
  if (!jobs.length) return void bootstrap.Dropdown.getInstance($("dlBtn"))?.hide();

  const downloading = jobs.filter((j) => j.status === "downloading").length;
  const total = jobs.reduce((s, j) => s + (j.size || 0), 0);
  const got = jobs.reduce((s, j) => s + (j.received || 0), 0);
  $("dlTitle").textContent = t("Đang tải {n} · chờ {m} · {got} / {total}", {
    n: downloading,
    m: jobs.length - downloading,
    got: fmt(got) || "0 B",
    total: fmt(total),
  });
  const bar = $("dlBar").querySelector(".progress-bar");
  bar.style.width = total ? `${(got / total) * 100}%` : "0";
  bar.className = "progress-bar progress-bar-striped progress-bar-animated";
  $("cancelBtn").disabled = !jobs.some((j) => j.status === "queued" || j.status === "downloading");

  jobs.sort((a, b) => (a.status === "downloading" ? 0 : 1) - (b.status === "downloading" ? 0 : 1));
  $("dlBody").innerHTML = jobs
    .map((j) => {
      const [label, color] = STATUS[j.status];
      const pct = j.size ? (j.received / j.size) * 100 : 0;
      const detail =
        j.status === "downloading" ? `${fmt(j.received) || "0 B"} / ${fmt(j.size)}` : j.error || fmt(j.size);
      const striped = j.status === "downloading" ? " progress-bar-striped progress-bar-animated" : "";
      return `<li class="list-group-item py-2">
      <div class="d-flex gap-2 align-items-center"><span class="flex-grow-1 text-truncate small" title="${esc(j.display || j.name)}">${esc(j.display || j.name)}</span>
      <span class="badge text-bg-${color}">${t(label)}</span></div>
      <div class="small text-body-secondary">${esc(detail)}</div>
      <div class="progress progress-thin mt-1"><div class="progress-bar bg-${color}${striped}" style="width:${pct}%"></div></div></li>`;
    })
    .join("");
}

// ---------- "Phát gần đây": the songs played lately (shared by every device of the account) ----------

/** "5 phút trước", "Hôm qua 21:04", "12/10 08:30" */
function ago(at) {
  const min = Math.floor((Date.now() - at) / 60000);
  if (min < 1) return t("Vừa xong");
  if (min < 60) return t("{n} phút trước", { n: min });
  const d = new Date(at);
  const hm = d.toLocaleTimeString(tdlI18n.locale, { hour: "2-digit", minute: "2-digit" });
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return t("Hôm nay {time}", { time: hm });
  if (d.toDateString() === new Date(today - 86_400_000).toDateString()) return t("Hôm qua {time}", { time: hm });
  return `${d.toLocaleDateString(tdlI18n.locale, { day: "2-digit", month: "2-digit" })} ${hm}`;
}

function renderRecent() {
  const q = norm($("recentSearch").value.trim());
  const all = state.recent;
  const list = all.filter((h) => !q || norm(`${h.title || ""} ${h.performer || ""} ${h.name} ${h.chat}`).includes(q));
  $("recentCount").textContent = all.length;
  $("recentInfo").textContent = `(${all.length})`;
  $("recentClearBtn").disabled = !all.length;
  const playing =
    state.playScan && state.playingId !== null
      ? favId(state.playScan.files.find((f) => f.id === state.playingId) || {}, state.playScan)
      : null;
  $("recentList").innerHTML = list.length
    ? list
        .map((h) => {
          const on = h.id === playing;
          return `<li class="list-group-item list-group-item-action py-2 d-flex gap-2 align-items-center recent-item${on ? " playing" : ""}" data-recent="${esc(h.id)}">
      <span class="recent-art"><i class="bi ${on && state.isPlaying ? "bi-soundwave" : "bi-play-fill"}"></i></span>
      <div class="flex-grow-1 min-w-0">
        <div class="small text-truncate fw-medium">${esc(displayName(h))}</div>
        <div class="small text-body-secondary text-truncate">${esc(h.chat || "")}${h.duration ? ` · ${fmtDur(h.duration)}` : ""} · ${ago(h.at)}</div>
      </div>
      <button class="btn btn-sm btn-outline-secondary btn-icon border-0 flex-none" data-recent-del="${esc(h.id)}" title="${t("Bỏ khỏi danh sách")}"><i class="bi bi-x-lg"></i></button></li>`;
        })
        .join("")
    : `<li class="list-group-item small text-body-secondary text-center py-4">${all.length ? t("Không có bài khớp") : t("Chưa nghe bài nào — bài bạn nghe sẽ hiện ở đây")}</li>`;
}

async function loadRecent() {
  try {
    state.recent = (await api("/api/recent")).items || [];
  } catch {
    state.recent = [];
  }
  renderRecent();
}

/** A song started: it goes to the top of the list (here and, through MongoDB, on the other devices). */
let lastRecent = null;
function addRecent(f, scan) {
  const id = favId(f, scan);
  if (!id || !/^-?\d+\|\d+$/.test(id) || lastRecent === id) return;
  lastRecent = id;
  const entry = {
    id,
    at: Date.now(),
    name: f.name,
    title: f.title || null,
    performer: f.performer || null,
    chat: f.chat || scan.title || null,
    duration: f.duration || null,
    kind: f.kind || null,
  };
  state.recent = [entry, ...state.recent.filter((h) => h.id !== id)].slice(0, 100);
  renderRecent();
  api("/api/recent", { op: "add", entry }).catch(() => {});
}

/** A song of the list: the whole list (as it is now) becomes the queue, from that song. */
async function playRecent(id) {
  try {
    const scan = await api("/api/recent/files");
    const f = scan.files.find((x) => x.fav === id);
    if (!f) return toast(t("Bài này không còn mở được (đã rời kênh hoặc tin đã bị xoá)"), "warn");
    state.playQueue = scan.files.filter(playable).map((x) => x.id);
    state.playOrder = orderFrom(f.id);
    playFrom(scan, f.id);
  } catch (err) {
    toast(err.message, "error");
  }
}

$("recentList").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-recent-del]");
  if (del) {
    const id = del.dataset.recentDel;
    state.recent = state.recent.filter((h) => h.id !== id);
    renderRecent();
    return api("/api/recent", { op: "remove", id }).catch((err) => toast(err.message, "error"));
  }
  const item = e.target.closest("[data-recent]");
  if (item) playRecent(item.dataset.recent);
});
$("recentSearch").addEventListener("input", renderRecent);
$("recentClearBtn").addEventListener("click", async () => {
  const ok = await ask({
    title: `<i class="bi bi-trash3 text-danger"></i> ${t("Xoá danh sách phát gần đây")}`,
    body: t("Xoá <strong>{n}</strong> bài khỏi danh sách phát gần đây?", { n: state.recent.length }),
    ok: t("Xoá"),
    okClass: "btn-danger",
  });
  if (!ok) return;
  state.recent = [];
  renderRecent();
  api("/api/recent", { op: "clear" }).catch((err) => toast(err.message, "error"));
});
$("recentBtn").addEventListener("click", () => setPanelOpen(!state.panelOpen));
$("recentClose").addEventListener("click", () => setPanelOpen(false));

let jobsFrame = 0;
function scheduleJobsRender() {
  if (!jobsFrame)
    jobsFrame = requestAnimationFrame(() => {
      jobsFrame = 0;
      renderJobs();
    });
}

function applyJob(job) {
  state.jobs.set(job.id, job);
  if (state.scan && job.scanKey === state.scan.key) {
    const f = state.scan.files.find((x) => x.id === job.msgId);
    if (f && (job.status === "done" || job.status === "skipped")) {
      // Re-posts of the same track (same name + size) share the file, so mark them all.
      for (const twin of state.scan.files) {
        if (twin.name === f.name && twin.size === f.size && !twin.downloaded) {
          twin.downloaded = true;
          updateRow(twin.id);
        }
      }
    }
    updateRow(job.msgId);
  }
  scheduleJobsRender();
}

$("cancelBtn").addEventListener("click", () =>
  api("/api/cancel", {})
    .then((r) => toast(t("Đã huỷ {n} file", { n: r.cancelled }), "info"))
    .catch((e) => toast(e.message, "error")),
);

// ---------- live updates ----------

const EVENTS = {
  account: () => refreshAccountData(),
  cloud: (d) => {
    const wasConnected = state.cloud?.connected;
    state.cloud = d;
    renderUserSync();
    // data pulled from MongoDB after the lists were shown (slow first sync): show the synced lists
    if (d.connected && !wasConnected && state.auth?.step === "ready") loadDialogs();
  },
  auth: (d) => renderAuth(d),
  fetch: ({ url, got, size }) => {
    fetched.set(url, size ? got / size : 0);
    if (fetched.size > 50) fetched.delete(fetched.keys().next().value);
    paintSeek();
  },
  job: (d) => applyJob(d),
  jobs: (d) => {
    state.jobs = new Map(d.map((j) => [j.id, j]));
    renderJobs();
  },
  settings: (d) => applySettings(d),
  // the download record is not shown any more; it still tells which files are "Đã tải"
  history: (d) => {
    state.history = d;
    refreshFlags();
  },
  "history-add": (d) => {
    state.history.unshift(d);
  },
  share: (d) => shareProgress(d), // the songs of a shared link being sent (browser build)
  scan: ({ scanId, count }) => {
    // Only the latest scan of this page: an earlier scan (same chat reloaded, other type / chat) or
    // another tab's scan must not make the number jump.
    if (!scanId || scanId !== state.scanId) return;
    const msg = $("scanMsg");
    if (msg) msg.textContent = t("Đang quét kênh… {n} file", { n: count });
  },
};

function connectEvents() {
  if (BACKEND) {
    for (const [name, handler] of Object.entries(EVENTS)) BACKEND.on(name, handler);
    BACKEND.start();
    return;
  }
  const es = new EventSource("/api/events");
  for (const [name, handler] of Object.entries(EVENTS)) es.addEventListener(name, (e) => handler(JSON.parse(e.data)));
}

/** Hide what the current version cannot do (the browser build cannot open folders on disk). */
function applyCaps() {
  if (!CAPS.openFolder) show($("folderBtn"), false);
  // Choosing where files go only exists on a PC / desktop; phones and tablets use the Downloads folder.
  if (!CAPS.pickFolder) show($("setFolderSection"), false);
  // a playlist shared through a link: the browser build only
  // (sm and up: its own button; phones: in the ⋯ menu)
  $("plShareBtn").classList.toggle("d-sm-inline-flex", !!CAPS.share);
  show($("plMoreShare"), !!CAPS.share);
}

applyCaps();
setView(homeView(), false);
connectEvents();
setPanelOpen(state.panelOpen && matchMedia("(min-width: 992px)").matches);
setSort("default");
