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
      const t = el.getAttribute("title");
      if (t) {
        el.setAttribute("data-bs-original-title", t);
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
  keyChat: new Map(), // scan key -> the chat it was opened with (to find what belongs to a hidden chat)
  chat: null, // chat identifier sent to the server
  type: "all",
  scan: null, // { key, title, outDir, files }
  selected: new Set(), // file ids
  lastClicked: null,
  query: "",
  show: "all",
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
    if (status >= 400) throw Object.assign(new Error(data.error || "Lỗi"), { code: data.code, status });
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
  $("themeBtn").setAttribute("title", dark ? "Chuyển sang giao diện sáng" : "Chuyển sang giao diện tối");
}
$("themeBtn").addEventListener("click", () => {
  const dark = document.documentElement.getAttribute("data-bs-theme") === "dark";
  window.tdlTheme?.set(dark ? "light" : "dark");
});
document.addEventListener("tdl:theme", renderTheme);
renderTheme();

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
    desc: "DLiMusic vừa gửi mã vào app Telegram của bạn (không phải SMS).",
    type: "text",
    placeholder: "12345",
  },
  password: {
    title: "Mật khẩu 2 lớp",
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
const fmtPhone = (p) => (p ? String(p).replace(/^\+(84|1|7|\d{2})(\d{3})(\d{3})(\d+)$/, "+$1 $2 $3 $4") : "Không có");

function renderUser(me) {
  const color = COLORS[Math.abs([...me.id].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % COLORS.length];
  const initial = [...me.name.replace(/[^\p{L}\p{N}]/gu, "")][0]?.toUpperCase() || "?";
  for (const el of [$("userAvatar"), $("userCardAvatar")]) {
    el.textContent = initial;
    el.style.background = color;
  }
  $("userMenu").style.setProperty("--user-color", color); // the card's name band takes this account's colour
  $("userBtn").setAttribute("aria-label", `Tài khoản: ${me.name}`);
  $("userCardName").textContent = me.name;
  $("userCardUsername").textContent = me.username ? `@${me.username}` : "Chưa đặt username";
  $("userCardPhone").textContent = fmtPhone(me.phone);
  $("userCardId").textContent = me.id;
  renderUserSync();
}

/** " · 13:52" (today) or " · 13:52 12/10" (an earlier day) of the last sync. */
function fmtSyncTime(at) {
  if (!at) return "";
  const d = new Date(at);
  const time = d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
  const day =
    d.toDateString() === new Date().toDateString()
      ? ""
      : ` ${d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" })}`;
  return `<span class="text-body-secondary"> · ${time}${day}</span>`;
}

function renderUserSync() {
  const c = state.cloud;
  $("userCardSync").innerHTML =
    !c || !c.enabled
      ? `<span class="text-body-secondary">Chỉ lưu trên thiết bị này</span>`
      : c.connected
        ? `<span class="text-success"><i class="bi bi-check-circle-fill"></i> Đã đồng bộ</span>${fmtSyncTime(c.lastSync)}`
        : `<span class="text-warning"><i class="bi bi-exclamation-triangle-fill"></i> Mất kết nối, đang thử lại</span>`;
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

function renderAuth(auth) {
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
      const full = auth.me?.name || "bạn";
      const name = [...full].length > 18 ? [...full].slice(0, 17).join("").trimEnd() + "…" : full;
      toast(`Chào mừng ${name} quay trở lại 🥰`, "welcome", { oneLine: true });
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
    $("loginTitle").textContent = "Chào mừng đến DLiMusic";
    $("loginDesc").textContent = "Kết nối tài khoản Telegram để nghe và tải nhạc từ các kênh của bạn:";
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
    $("loginTitle").textContent = "Quét mã QR để đăng nhập";
    $("loginDesc").textContent = "Dùng ứng dụng Telegram trên điện thoại";
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
    $("loginError").textContent = fieldError ? "" : waited ? FLOOD_OVER : auth.error || "";
  }
  if (step) {
    $("loginTitle").textContent = step.title;
    if (step.html)
      $("loginDesc").innerHTML = step.html; // fixed text from this file, never user data
    else $("loginDesc").textContent = step.desc;
    const input = $("loginInput");
    if (prev !== auth.step) {
      input.type = step.type;
      input.placeholder = step.placeholder;
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
    $("loginTitle").textContent = "Lỗi kết nối";
    $("loginDesc").textContent = auth.error;
  } else {
    $("loginTitle").textContent = auth.step === "waiting" ? "Đang xác thực…" : "Đang kết nối…";
    $("loginDesc").innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
  }
}

// ---------- Telegram's wait after too many codes: a live hh:mm:ss countdown ----------

const FLOOD_OVER = "Đã hết thời gian chờ của Telegram, bạn có thể thử lại.";
let floodTimer = null;

const hms = (ms) => {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return [Math.floor(t / 3600), Math.floor((t % 3600) / 60), t % 60].map((n) => String(n).padStart(2, "0")).join(":");
};

function showFloodCountdown(until) {
  const box = $("loginError");
  if (!box.querySelector("#floodLeft")) {
    // fixed text from this file only
    box.innerHTML = `<div>Telegram tạm khoá đăng nhập bằng mã cho số này vì thử quá nhiều lần.
      <div class="flood-row">Thử lại sau <strong class="flood-left" id="floodLeft"></strong></div>
      Bạn vẫn có thể đăng nhập ngay bằng <b>mã QR</b> bên dưới.</div>`;
  }
  const tick = () => {
    if (Date.now() >= until) {
      stopFloodCountdown();
      box.textContent = FLOOD_OVER;
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
    $("qrTimer").textContent = left > 0 ? `Mã tự làm mới sau ${left} giây` : "Đang lấy mã mới…";
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
     <span class="fi fi-${cc}"></span><span>${name}</span><span class="ms-auto text-body-secondary small">+${code}</span></button></li>`,
).join("");

/** The selected country code ("84"), kept on the button. */
const phoneCode = () => $("phoneCode").dataset.code || "84";

function setPhoneCode(code, remember) {
  const entry = PHONE_CODES.find(([c]) => c === code) || PHONE_CODES[0];
  $("phoneCode").dataset.code = entry[0];
  $("phoneFlag").className = `fi fi-${entry[1]}`;
  $("phoneDial").textContent = `+${entry[0]}`;
  $("phoneCode").title = `${entry[2]} (+${entry[0]})`;
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
     ${i === 0 ? 'autocomplete="one-time-code"' : 'autocomplete="off"'} aria-label="Số thứ ${i + 1}">`,
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
    ? "Số điện thoại Việt Nam gồm 9 số sau +84 (có thể gõ kèm số 0 ở đầu, vd 0912 345 678)."
    : "Số điện thoại không hợp lệ.";

/** Validate the phone field; returns "+<code><number>" or null (and shows why). */
function checkPhone() {
  const input = $("loginInput");
  if (!input.value.trim()) {
    setFieldError("Hãy nhập số điện thoại.");
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
    $("loginError").textContent = `Nhập đủ ${OTP_LEN} số của mã xác nhận.`;
    show($("loginError"), true);
    otpInputs()[value.length]?.focus();
    return;
  }
  // novalidate: the browser's own bubbles are off, empty fields are flagged Bootstrap-style instead
  if (state.auth.step !== "code" && state.auth.step !== "phone" && !value.trim()) {
    setFieldError("Không được để trống.");
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
    title: '<i class="bi bi-box-arrow-right text-danger"></i> Đăng xuất',
    body: "Bạn có muốn đăng xuất tài khoản khỏi DLiMusic?",
    ok: "Đăng xuất",
    okClass: "btn-danger",
  });
  if (!ok) return;
  // Go to the login screen right away; the server finishes signing out in the background.
  resetWorkspace();
  renderAuth({ step: "phone", error: null, me: null, phone: state.auth?.phone || "" });
  api("/api/logout", {})
    .then(() => toast("Xin chào và hẹn gặp lại", "bye"))
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
  state.favorites.clear();
  state.selected.clear();
  state.jobs.clear();
  renderJobs();
  stopPlayer();
  state.keyChat.clear();
  $("dialogSearch").value = "";
  show($("chatsBar"), false);
  $("dialogs").innerHTML =
    `<div class="text-center p-4"><span class="spinner-border spinner-border-sm text-primary"></span></div>`;
  showChat(false);
  updateSelection();
}

// ---------- dialogs ----------

const TYPE_ICON = { channel: "bi-megaphone", group: "bi-people", user: "bi-person" };
const TYPE_LABEL = { channel: "Kênh", group: "Nhóm", user: "Người dùng" };

/** Coloured circle with the first letter of the chat title. */
function dialogAvatar(d) {
  const color = COLORS[Math.abs([...d.id].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % COLORS.length];
  const initial = esc([...d.title.replace(/[^\p{L}\p{N}]/gu, "")][0] || "#").toUpperCase();
  return `<span class="avatar rounded-circle" style="background:${color}">${initial}</span>`;
}

const dialogSub = (d) =>
  `<i class="bi ${TYPE_ICON[d.type]}"></i> ${TYPE_LABEL[d.type]}${d.username ? " · @" + esc(d.username) : ""}`;

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
      aria-expanded="false" title="Sắp xếp: ${cur.label}" aria-label="Sắp xếp hội thoại: ${cur.label}"><i class="bi bi-arrow-down-up"></i></button>
    <ul class="dropdown-menu dropdown-menu-end shadow-sm">
      <li><h6 class="dropdown-header">Sắp xếp hội thoại</h6></li>
      ${Object.entries(DIALOG_SORTS)
        .map(
          ([
            k,
            s,
          ]) => `<li><button class="dropdown-item d-flex align-items-center gap-2${k === dialogSort ? " active" : ""}" type="button" data-dialog-sort="${k}">
        <i class="bi ${s.icon}"></i><span class="flex-grow-1">${s.label}</span>${k === dialogSort ? '<i class="bi bi-check2"></i>' : ""}</button></li>`,
        )
        .join("")}
    </ul></div>`;
}

function renderDialogs() {
  renderFavEntry();
  const q = norm($("dialogSearch").value.trim());
  const shown = shownDialogs();
  const list = sortDialogs(shown.filter((d) => !q || norm(d.title).includes(q) || norm(d.username).includes(q)));
  // Bar above the list: how many chats are shown, and a button to choose them.
  const total = state.dialogs.length;
  show($("chatsBar"), total > 0);
  $("chatsBar").innerHTML = total
    ? `
    <span class="text-truncate"><i class="bi ${state.visibleChats ? "bi-funnel-fill text-primary" : "bi-chat-dots"}"></i>
      ${state.visibleChats ? `<strong>${shown.length}</strong>/${total} hội thoại` : `<strong>${total}</strong> hội thoại`}</span>
    <span class="ms-auto"></span>${dialogSortMenu()}
    <button class="btn btn-sm chats-bar-btn flex-none" data-chats-edit>
      <i class="bi bi-sliders"></i> ${state.visibleChats ? "Chọn lại" : "Chọn hiển thị"}</button>`
    : "";
  if (!shown.length && state.dialogs.length) {
    $("dialogs").innerHTML = `<div class="text-center text-body-secondary small p-4">
      <i class="bi bi-eye-slash fs-3 d-block mb-2"></i>Chưa chọn hội thoại nào để hiển thị.
      <div class="mt-2"><button class="btn btn-sm btn-primary" data-chats-edit><i class="bi bi-sliders"></i> Chọn hội thoại</button></div></div>`;
    return;
  }
  $("dialogs").innerHTML = list.length
    ? list
        .map((d) => {
          const active = state.chat === d.id ? " active" : "";
          return `<a class="list-group-item list-group-item-action dialog-item d-flex align-items-center gap-2${active}" data-id="${esc(d.id)}" title="${esc(d.title)}">
      ${dialogAvatar(d)}
      <span class="min-w-0 side-text"><span class="d-block text-truncate">${esc(d.title)}</span>
      <small class="d-block text-truncate ${active ? "" : "text-body-secondary"}">${dialogSub(d)}</small></span></a>`;
        })
        .join("")
    : q
      ? `<div class="text-body-secondary small p-3">Không tìm thấy. Nhấn Enter để mở “${esc($("dialogSearch").value.trim())}”.</div>`
      : `<div class="text-body-secondary small p-3">Chưa có hội thoại nào. Dán link / username kênh vào ô tìm kiếm rồi nhấn Enter.</div>`;
}

// ---------- choosing the chats shown in the list (per Telegram account) ----------

let chatsDraft = null; // Set of chat ids being edited

function renderChatsModal() {
  const q = norm($("chatsSearch").value.trim());
  const list = sortDialogs(
    state.dialogs.filter((d) => !q || norm(d.title).includes(q) || norm(d.username).includes(q)),
  );
  $("chatsCount").textContent =
    `Đã chọn ${state.dialogs.filter((d) => chatsDraft.has(d.id)).length}/${state.dialogs.length}`;
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
    : `<div class="text-body-secondary small p-3">Không có hội thoại nào khớp.</div>`;
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
    stopped.push(`đóng “${state.scan?.title || $("chatTitle").textContent}”`);
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
    stopped.push("dừng phát nhạc");
  }
  const busy = [...state.jobs.values()].some(
    (j) => hiddenKeys.has(j.scanKey) && ["queued", "downloading"].includes(j.status),
  );
  if (busy) {
    try {
      const r = await api("/api/cancel", { keys: [...hiddenKeys] });
      if (r.cancelled) stopped.push(`huỷ ${r.cancelled} file đang tải`);
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
      ? `Đã lưu: hiện ${shownDialogs().length}/${state.dialogs.length} hội thoại`
      : "Đã bỏ lọc: hiện tất cả hội thoại";
    toast(
      stopped.length ? `${saved}. Hội thoại bị ẩn: ${stopped.join(", ")}.` : saved,
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
    ? "Đăng nhập để chọn"
    : state.visibleChats
      ? `Đang hiện ${shownDialogs().length}/${state.dialogs.length} hội thoại`
      : `Hiện tất cả (${state.dialogs.length} hội thoại)`;
}

$("dialogSearch").addEventListener("input", renderDialogs);
$("dialogSearch").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.value.trim()) openChat(e.target.value.trim());
});
$("dialogs").addEventListener("click", (e) => {
  const el = e.target.closest(".dialog-item");
  if (el) openChat(el.dataset.id);
});

// ---------- files ----------

function showChat(on) {
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
  renderDialogs();
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
  b.title = on ? "Đang quét kênh…" : "Quét lại";
}

/** Stop the chat scan in progress (another chat / type was chosen, or the chat was closed). */
function stopScan() {
  state.scanCtrl?.abort();
  state.scanCtrl = null;
}

async function loadFiles() {
  const token = ++state.loadToken;
  stopScan(); // the previous chat's scan stops in the server / backend too, not just ignored here
  $("chatView").classList.toggle("fav-view", state.chat === FAV_CHAT); // no type filter there: all kinds, newest heart first
  const ctrl = (state.scanCtrl = new AbortController());
  setScanning(true);
  showChat(true);
  const dialog = state.dialogs.find((d) => d.id === state.chat);
  $("chatTitle").textContent = state.chat === FAV_CHAT ? "Bài hát yêu thích" : dialog?.title || state.chat;
  document
    .querySelectorAll("#typeSeg button")
    .forEach((b) => b.classList.toggle("active", b.dataset.type === state.type));
  setMessage(`<div class="spinner-border text-primary"></div><p class="mt-2" id="scanMsg">Đang quét kênh…</p>`);
  $("fileCount").textContent = "";
  state.scan = null;
  updateSelection();
  try {
    state.scanId = `${PAGE_ID}-${token}`; // progress events carry it: only this scan's count is shown
    const scan =
      state.chat === FAV_CHAT
        ? await api(`/api/favorites/files?scan=${state.scanId}`, undefined, { signal: ctrl.signal })
        : await api(
            `/api/files?chat=${encodeURIComponent(state.chat)}&type=${state.type}&scan=${state.scanId}`,
            undefined,
            { signal: ctrl.signal },
          );
    if (token !== state.loadToken) return;
    state.scan = scan;
    state.keyChat.set(scan.key, state.chat);
    $("chatTitle").textContent = scan.title;
    renderFiles();
    if (scan.missing) toast(`${scan.missing} bài yêu thích không còn mở được (đã rời kênh hoặc tin đã bị xoá)`, "warn");
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

function visibleFiles() {
  if (!state.scan) return [];
  const q = norm(state.query.trim());
  const list = state.scan.files.filter(
    (f) =>
      (!q || norm(`${f.name} ${f.title || ""} ${f.performer || ""}`).includes(q)) &&
      (state.show === "all" || (state.show === "done") === f.downloaded) &&
      (!state.scan.fav ||
        (state.favorites.has(f.fav) && // "Bài hát yêu thích": an un-hearted file leaves the list
          (state.favScope === "all" || f.fav.split("|")[0] === state.favScope))),
  );
  return sortFiles(list);
}

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
  if (!cmp) return list;
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
      th.firstChild.textContent = on && sort.startsWith("dur") ? "Thời lượng " : "Dung lượng ";
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
  if (job && job.status === "queued") return `<span class="badge text-bg-secondary">Đang chờ</span>`;
  if (job && job.status === "failed") return `<span class="badge text-bg-danger" title="${esc(job.error)}">Lỗi</span>`;
  if (f.downloaded) return `<span class="badge text-bg-success">Đã tải</span>`;
  return "";
}

const VISUAL = new Set(["photo", "image", "video"]);

function playCell(f) {
  if (VISUAL.has(f.kind)) {
    const video = f.kind === "video";
    return `<button class="btn btn-sm btn-outline-primary play-btn" data-preview="${f.id}"
      title="${video ? "Xem trước video (phát trực tiếp từ Telegram, không tải về)" : "Xem trước ảnh"}">
      <i class="bi ${video ? "bi-play-btn" : "bi-eye"}"></i></button>`;
  }
  if (f.kind === "document") return "";
  const on = state.playingId === f.id && state.isPlaying;
  return `<button class="btn btn-sm ${on ? "btn-primary" : "btn-outline-primary"} play-btn" data-play="${f.id}"
    title="${on ? "Tạm dừng" : f.downloaded ? "Phát" : "Nghe thử (phát trực tiếp từ Telegram, không tải về)"}">
    <i class="bi ${on ? "bi-pause-fill" : "bi-play-fill"}"></i></button>`;
}

// ---------- favourites ----------

/** "<chat id>|<message id>": the same file keeps its heart after a rescan or under another type filter. */
const favId = (f, scan = state.scan) => f.fav ?? `${scan.key.split("|")[0]}|${f.id}`;
const isFav = (f) => !!state.scan && state.favorites.has(favId(f));

function favCell(f) {
  const on = isFav(f);
  return `<button class="btn btn-sm fav-btn${on ? " on" : ""}" data-fav="${f.id}" aria-pressed="${on}"
    title="${on ? "Bỏ khỏi yêu thích" : "Thêm vào yêu thích"}"><i class="bi ${on ? "bi-heart-fill" : "bi-heart"}"></i></button>`;
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
      on ? `Đã thêm “${displayName(f)}” vào yêu thích` : `Đã bỏ “${displayName(f)}” khỏi yêu thích`,
      on ? "bye" : "info",
    );
  } catch (err) {
    on ? state.favorites.delete(key) : state.favorites.add(key);
    toast(err.message, "error");
  }
  refreshFavViews(id, scan);
}

/** After a heart changed: the open list (its row, or all of "Bài hát yêu thích"), the sidebar count, the player. */
function refreshFavViews(id, scan = state.scan) {
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
  b.setAttribute("data-bs-original-title", on ? "Bỏ khỏi yêu thích" : "Thêm vào yêu thích");
  b.removeAttribute("title");
}
$("playerFav").addEventListener("click", () => state.playScan && toggleFav(state.playingId, state.playScan));

/** "Bài hát yêu thích" at the top of the sidebar: count + highlighted while open. */
function renderFavEntry() {
  const active = state.chat === FAV_CHAT;
  $("favEntry").classList.toggle("active", active);
  $("favEntrySub").classList.toggle("text-body-secondary", !active);
  $("favEntrySub").innerHTML = `<i class="bi bi-music-note-beamed"></i> ${state.favorites.size} bài · từ mọi kênh`;
}

$("favEntry").addEventListener("click", (e) => {
  e.preventDefault();
  openChat(FAV_CHAT);
});
$("favEntry").title = "Bài hát yêu thích";

// ---------- sidebar as a rail of icons (576–1023px) ----------

const railMode = () => matchMedia("(min-width: 576px) and (max-width: 1023.98px) and (min-height: 501px)").matches;

/** Open (over the page) or close the rail. */
function setRailOpen(open) {
  $("mainView").classList.toggle("rail-open", open && railMode());
  $("railToggle").setAttribute("aria-expanded", String(open));
  $("railToggle").innerHTML = `<i class="bi ${open ? "bi-chevron-left" : "bi-chevron-right"}"></i>`;
  $("railToggle").setAttribute("data-bs-original-title", open ? "Thu gọn" : "Mở rộng danh sách kênh");
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

function rowHtml(f, num) {
  const sel = state.selected.has(f.id);
  const cls = [sel && "row-sel", state.playingId === f.id && "playing"].filter(Boolean).join(" ");
  return `<tr class="${cls}" data-id="${f.id}">
    <td class="ps-3"><input class="form-check-input" type="checkbox" ${sel ? "checked" : ""} tabindex="-1"></td>
    <td class="play">${playCell(f)}</td>
    <td class="text-body-secondary small">${num}</td>
    <td class="text-truncate name-cell"><div class="name-main">${esc(displayName(f))}</div>
      ${displayName(f) !== f.name ? `<div class="small text-body-secondary text-truncate name-file"><i class="bi bi-file-earmark-music"></i> ${esc(f.name)}</div>` : ""}
      ${f.chat ? `<div class="small text-truncate fav-chat"><i class="bi bi-megaphone"></i> ${esc(f.chat)}</div>` : ""}
      <div class="m-meta small text-body-secondary"><span class="m-size">${[fmt(f.size), fmtDur(f.duration)].filter(Boolean).join(" · ")}</span><span class="state-m">${stateCell(f)}</span></div></td>
    <td class="text-end text-body-secondary small">${fmt(f.size)}${f.duration ? `<div>${fmtDur(f.duration)}</div>` : ""}</td>
    <td class="fav">${favCell(f)}</td></tr>`;
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
    `<option value="all">Tất cả kênh — theo danh sách (${total})</option>` +
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
  renderFavScope();
  const files = visibleFiles();
  const index = new Map(state.scan.files.map((f, i) => [f.id, i + 1]));
  const more = state.scan.more ? "+" : ""; // more pages to load: the total is not known yet
  $("fileCount").textContent = `${files.length}/${state.scan.files.length}${more} file`;
  $("chatSub").textContent =
    files.length === state.scan.files.length
      ? `${files.length}${more} file`
      : `${files.length}/${state.scan.files.length}${more} file đang hiện`;
  syncFilterSheet();
  if (!files.length) {
    const favEmpty = state.scan.fav && !state.scan.files.some((f) => state.favorites.has(f.fav));
    setMessage(
      favEmpty
        ? `<i class="bi bi-heart display-5 fav-empty"></i><p class="mt-2 mb-1">Chưa có bài hát yêu thích</p><p class="small">Mở một kênh và bấm <i class="bi bi-heart"></i> ở cuối mỗi dòng để thêm vào đây.</p>`
        : state.scan.files.length
          ? "Không có file khớp bộ lọc"
          : `<i class="bi bi-inbox display-5"></i><p class="mt-2">Kênh không có file loại này</p>`,
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
    !scan || scan.fav
      ? ""
      : state.loadingMore
        ? `<span class="spinner-border spinner-border-sm text-primary"></span> Đang tải thêm…`
        : scan.more
          ? `<button class="btn btn-sm btn-outline-primary" id="loadMoreBtn"><i class="bi bi-arrow-down-circle"></i> Tải thêm 500 file</button>`
          : scan.files.length > PAGE_SIZE
            ? `Đã tải hết ${scan.files.length} file`
            : "";
}

async function loadMore() {
  const scan = state.scan;
  if (!scan?.more || scan.fav || state.loadingMore || state.scanning) return;
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
    row.querySelector(".fav").innerHTML = favCell(f);
  }
}

function updateSelection() {
  const files = state.scan ? state.scan.files.filter((f) => state.selected.has(f.id)) : [];
  const total = files.reduce((s, f) => s + (f.size || 0), 0);
  $("selInfo").innerHTML = files.length
    ? `<span class="badge text-bg-primary rounded-pill">${files.length}</span> <span class="d-none d-sm-inline">file được chọn</span><span class="d-sm-none">bài</span>${total ? ` · <strong>${fmt(total)}</strong>` : ""}`
    : `<span class="small text-body-secondary hint">Bấm vào bài để nghe · tích ô vuông để chọn tải, <kbd>Shift</kbd> + bấm để chọn liên tiếp</span>`;
  $("downloadBtn").disabled = !files.length;
  $("downloadBtn").querySelector("span").textContent = files.length ? `Tải xuống (${files.length})` : "Tải xuống";

  const visible = visibleFiles();
  const n = visible.filter((f) => state.selected.has(f.id)).length;
  $("headCheck").checked = visible.length > 0 && n === visible.length;
  $("headCheck").indeterminate = n > 0 && n < visible.length;
}

$("files").addEventListener("click", (e) => {
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
function setShow(show) {
  state.show = show;
  document.querySelectorAll("#showSeg button").forEach((x) => x.classList.toggle("active", x.dataset.show === show));
  renderFiles();
}

function setType(type) {
  if (type === state.type) return;
  state.type = type;
  try {
    localStorage.setItem("type", state.type);
  } catch {}
  state.selected.clear();
  loadFiles();
}

$("showSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) setShow(b.dataset.show);
});
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
  document
    .querySelectorAll("#showSegM button")
    .forEach((x) => x.classList.toggle("active", x.dataset.show === state.show));
  const active = (state.type !== "all") + (state.sort !== "default") + (state.show !== "all");
  $("filterBadge").textContent = active;
  show($("filterBadge"), active > 0);
  if (state.scan) $("filterCount").textContent = $("fileCount").textContent;
}

$("typeSelM").addEventListener("change", (e) => setType(e.target.value));
$("sortSelM").addEventListener("change", (e) => setSort(e.target.value));
$("showSegM").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) setShow(b.dataset.show);
});
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
  if (!dialog) return toast("Kênh của bài này không có trong danh sách kênh", "warn");
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
    return toast("Không tìm thấy bài trong kênh (có thể tin đã bị xoá)", "warn");
  if (!$("files").querySelector(`tr[data-id="${msgId}"]`)) {
    state.query = "";
    $("fileSearch").value = "";
    setShow("all"); // hidden by the search / "Chưa tải · Đã tải"
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
    if (!scan.fav) {
      state.type = scan.key.split("|")[1] || state.type; // the list was read with this type filter
      document
        .querySelectorAll("#typeSeg button")
        .forEach((b) => b.classList.toggle("active", b.dataset.type === state.type));
    }
    $("chatView").classList.toggle("fav-view", scan.fav === true);
    state.scan = scan;
    showChat(true);
    $("chatTitle").textContent = scan.fav ? "Bài hát yêu thích" : scan.title;
    renderDialogs();
    renderFiles();
  }
  setView("files");
  setRailOpen(false);
  let row = $("files").querySelector(`tr[data-id="${state.playingId}"]`);
  if (!row) {
    // hidden by the search / "Chưa tải · Đã tải" / the favourites' chat choice: show everything
    state.query = "";
    $("fileSearch").value = "";
    if (scan.fav) state.favScope = "all";
    setShow("all");
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
  $("chatView").classList.remove("fav-view");
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
$("reloadBtn").addEventListener("click", () => state.chat && !state.scanning && loadFiles());
$("folderBtn").addEventListener("click", () =>
  api("/api/open-folder", { key: state.scan?.key }).catch((e) => {
    if (e.code !== "NEED_DIR") return toast(e.message, "error");
    toast("Chưa chọn thư mục tải xuống — hãy chọn trong Cài đặt", "warn");
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
 * Play a file of the open list. The queue is that list as shown right now (search, filters, sort and,
 * in "Bài hát yêu thích", the chosen chat), so the next songs follow what is on screen.
 */
function play(id) {
  if (state.playingId === id && state.playingKey === state.scan.key) return togglePlay();
  state.playQueue = visibleFiles()
    .filter(playable)
    .map((f) => f.id);
  state.playOrder = orderFrom(id);
  playFrom(state.scan, id);
}

/** A new page of the list that is playing: its songs join the end of the queue. */
function extendQueue(scan) {
  if (state.playScan !== scan) return;
  const queued = new Set(state.playQueue);
  const fresh = visibleFiles()
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
    `<span class="badge ${f.downloaded ? "text-bg-success" : "text-bg-warning"}">${f.downloaded ? "Từ máy" : "Nghe thử"}</span> ` +
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
        artwork: [{ src: "img/logo-192.png", sizes: "192x192", type: "image/png" }],
      });
    } catch {}
  }
  player.play().catch(() => {});
}

/** ⏭ is greyed out at the end of the list when nothing repeats. */
function updateNavButtons() {
  const i = state.playOrder.indexOf(state.playingId);
  $("nextBtn").disabled = !state.playScan || (state.repeat === "off" && i >= state.playOrder.length - 1);
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
  const player = $("player");
  if (auto && state.repeat === "one" && !skip) {
    player.currentTime = 0;
    return void player.play().catch(() => {});
  }
  const order = state.playOrder;
  const i = order.indexOf(state.playingId);
  let next = order[i + 1];
  if (next === undefined && state.repeat !== "off" && order.length) {
    if (state.shuffle) state.playOrder = orderFrom(null); // a fresh shuffle for the next round
    next = state.playOrder[0];
  }
  if (next === undefined && state.playScan === state.scan && state.scan.more) {
    // the end of what is loaded, but the chat has more: read the next page, then go on
    const before = state.playOrder.length;
    loadMore().then(() => state.playOrder.length > before && playNext(auto));
    return;
  }
  if (next === undefined) {
    if (!auto) toast("Đã hết danh sách phát", "info");
    return;
  }
  playFrom(state.playScan, next);
}

/** ⏮: back to the start of the song, or (in its first 3 seconds) the song before. */
function playPrev() {
  const player = $("player");
  if (!state.playScan) return;
  const order = state.playOrder;
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
  sh.title = `Phát ngẫu nhiên: ${state.shuffle ? "bật" : "tắt"}`;
  const rp = $("repeatBtn");
  rp.classList.toggle("on", state.repeat !== "off");
  rp.setAttribute("aria-pressed", state.repeat !== "off");
  rp.title = REPEAT_TITLE[state.repeat];
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
  toast(state.shuffle ? "Phát ngẫu nhiên: bật" : "Phát ngẫu nhiên: tắt — theo thứ tự danh sách", "info");
});
$("repeatBtn").addEventListener("click", () => {
  state.repeat = REPEAT_NEXT[state.repeat];
  renderModes();
  toast(REPEAT_TITLE[state.repeat], "info");
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
  $("emptyCat").style.setProperty("--cat-rate", rate); // the dancing kittens keep pace
  $("speedBtn").textContent = `${rate}x`;
  $("speedBtn").classList.toggle("on", rate !== 1);
  $("speedVal").textContent = `${rate.toFixed(1)}x`;
  $("speedRange").value = rate;
  $("speedList").innerHTML = SPEEDS.map(
    ([r, label]) =>
      `<button type="button" class="dropdown-item d-flex align-items-center gap-3${r === rate ? " active" : ""}" data-speed="${r}">
      <small class="speed-tag">${r}x</small><span class="flex-grow-1">${label}</span>${r === rate ? '<i class="bi bi-check2"></i>' : ""}</button>`,
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

$("prevBtn").addEventListener("click", playPrev);
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
function paintSeek() {
  const p = $("player");
  const bar = $("seekRange");
  const dur = Number.isFinite(p.duration) ? p.duration : 0;
  let loaded = 0; // end of the loaded stretch that holds the current time
  for (let i = 0; dur && i < p.buffered.length; i++)
    if (p.buffered.start(i) <= p.currentTime + 1 && p.buffered.end(i) > loaded) loaded = p.buffered.end(i);
  bar.style.setProperty("--played", `${bar.value / 10}%`);
  bar.style.setProperty("--loaded", `${dur ? Math.min(100, (loaded / dur) * 100) : 0}%`);
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
$("seekRange").addEventListener("change", (e) => {
  const p = $("player");
  if (Number.isFinite(p.duration)) p.currentTime = (e.target.value / 1000) * p.duration;
  seeking = false;
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
    setHomeCat(state.isPlaying);
  });
}
player.addEventListener("ended", () => {
  // The stream was cut (network) long before the song's real end: continue it instead of moving on.
  const f = state.playScan?.files.find((x) => x.id === state.playingId);
  if (f?.duration && lastTime < f.duration - 5 && connectionLost()) return;
  playNext(true);
});
// ---------- the start screen's cat: dancing kittens while music plays, the cat with headphones otherwise ----------

// The kittens are 39 frames stacked in one picture that CSS steps through, so their speed can follow the
// song's playback speed (an animated GIF / WebP always runs at its own speed).
const HOME_CAT = { still: "/img/cat-headphones.webp", dance: "/img/cat-dance-frames.webp" };
function setHomeCat(playing) {
  const cat = $("emptyCat");
  const dance = playing && !matchMedia("(prefers-reduced-motion: reduce)").matches;
  const src = dance ? HOME_CAT.dance : HOME_CAT.still;
  if (cat.getAttribute("src") === src) return;
  cat.setAttribute("src", src); // the dancing one is only downloaded once music plays
  cat.classList.toggle("cat-dancing", dance);
  cat.alt = dance ? "Hai chú mèo con đang nhảy theo nhạc" : "Mèo đeo tai nghe đang thưởng thức nhạc";
}

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
    const type = fav || recent ? null : String(saved.key).split("|")[1] || "all";
    let scan = fav
      ? await api("/api/favorites/files")
      : recent
        ? await api("/api/recent/files")
        : await api(`/api/files?chat=${encodeURIComponent(saved.chat)}&type=${encodeURIComponent(type)}`);
    // the song may be on a later page of a long list (500 files each)
    for (let pages = 0; !scan.files.some((f) => f.id === saved.id) && scan.more && pages < 20; pages++) {
      const r = await api(`/api/files/more?key=${encodeURIComponent(scan.key)}`);
      scan.files.push(...r.files.filter((f) => !scan.files.some((x) => x.id === f.id)));
      scan.more = r.more;
    }
    const f = scan.files.find((x) => x.id === saved.id);
    if (!f || state.playingId !== null) return; // gone from the chat, or the user already started another song
    if (!recent) state.keyChat.set(scan.key, saved.chat);
    state.playQueue = scan.files.filter(playable).map((x) => x.id);
    state.playOrder = orderFrom(saved.id);
    player.addEventListener(
      "loadedmetadata",
      () => {
        player.currentTime = saved.time || 0;
        lastTime = saved.time || 0;
        if (!saved.playing) return player.pause();
        player.play().catch(() => {
          // the browser blocks sound until the user clicks something on the page
          toast(`Bấm ▶ để nghe tiếp “${displayName(f)}” từ ${fmtDur(Math.floor(saved.time || 0)) || "0:00"}`, "info");
        });
      },
      { once: true },
    );
    playFrom(scan, saved.id);
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
  toast(`Đã có mạng lại — phát tiếp từ ${fmtDur(Math.floor(time)) || "0:00"}`, "success");
}

window.addEventListener("offline", () => {
  if (state.playingId === null) return;
  resumeAt = {
    key: state.playingKey,
    id: state.playingId,
    time: lastTime || player.currentTime,
    playing: state.isPlaying || !player.paused,
  };
  toast("Mất kết nối mạng — sẽ phát tiếp khi có mạng lại", "warn");
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
  const name = f ? `“${displayName(f)}”` : "bài này";
  if (++failedInARow > MAX_SKIPS) {
    failedInARow = 0;
    return toast("Nhiều bài liên tiếp không phát được nên đã dừng. Kiểm tra mạng rồi thử lại.", "error");
  }
  const failed = state.playingId;
  toast(`Không phát được ${name} — chuyển sang bài tiếp theo`, "warn");
  // unless the user picked another song meanwhile
  setTimeout(() => state.playingId === failed && playNext(true, { skip: true }), 600);
});

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
        fail("Trình duyệt không phát được video này (định dạng không hỗ trợ). Bạn vẫn có thể tải về.");
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
        fail("Không xem được ảnh này.");
      },
      { once: true },
    );
    img.src = src;
    stage.append(img);
  }

  const list = previewList();
  const i = list.findIndex((x) => x.id === f.id);
  $("previewTitle").textContent = displayName(f);
  $("previewInfo").textContent = [
    `${i + 1}/${list.length}`,
    fmt(f.size),
    fmtDur(f.duration),
    f.downloaded ? "Đã tải" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  $("previewPrev").disabled = i <= 0;
  $("previewNext").disabled = i < 0 || i >= list.length - 1;
  const sel = state.selected.has(f.id);
  $("previewSelect").className = `btn btn-sm ${sel ? "btn-primary" : "btn-outline-primary"}`;
  $("previewSelect").querySelector("span").textContent = sel ? "Đã chọn" : "Chọn để tải";
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
async function ask({ title, body, ok = "Đồng ý", okClass = "btn-primary" }) {
  await hideOpenModals();
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
  askAnswer = true;
  askModal.hide();
});
$("askModal").addEventListener("shown.bs.modal", () => $("askOk").focus());
$("askModal").addEventListener("hidden.bs.modal", () => {
  const r = askResolve;
  askResolve = null;
  r?.(askAnswer);
  askAnswer = false;
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
    : `<div class="list-group-item small text-body-secondary text-center py-3">Không có thư mục con</div>`;
}

/**
 * Let the user pick a folder. remember: null hides the "remember as default" checkbox, true/false sets it.
 * Resolves { path, remember } or null when cancelled.
 */
async function pickFolder({ start, remember = null, title = "Chọn thư mục tải xuống" } = {}) {
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
  const base = settingsDraft.downloadDir || "…/thư-mục-tải";
  $("setExample").innerHTML =
    `Ví dụ file sẽ lưu tại: <code>${esc(base)}${settingsDraft.subfolderPerChat ? "/Tên kênh" : ""}/Tên bài.mp3</code>`;
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
    toast("Đã lưu cài đặt");
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
         <i class="bi bi-download text-primary"></i><span>Lưu vào <strong>thư mục Tải về</strong> của trình duyệt</span></div>`
    : !askDir
      ? ""
      : `<div class="d-flex align-items-center gap-2 mt-2 p-2 border rounded bg-body-tertiary">
       <i class="bi bi-folder2-open text-primary"></i>
       <div class="flex-grow-1 min-w-0 small text-break"><span class="text-body-secondary">Lưu vào:</span> ${
         state.dlTarget
           ? `<span class="font-monospace">${esc(state.dlTarget.path)}${state.settings.subfolderPerChat ? `/${esc(state.scan.title)}` : ""}</span>`
           : `<em class="text-warning-emphasis">Chưa chọn thư mục — sẽ hỏi khi bấm Bắt đầu tải</em>`
       }</div>
       <button class="btn btn-sm btn-outline-primary flex-none" id="confirmDirBtn">${state.dlTarget ? "Đổi…" : "Chọn…"}</button></div>`;
  $("confirmSub").innerHTML =
    `<div><strong>${files.length}</strong> file · <strong>${fmt(total) || "?"}</strong></div>` +
    dirRow +
    (already
      ? `<div class="alert alert-info py-2 mt-2 mb-0 small"><i class="bi bi-info-circle"></i> ${already} file đã có sẵn sẽ được bỏ qua.</div>`
      : "");
  $("confirmList").innerHTML = files
    .map(
      (f) =>
        `<li class="list-group-item d-flex gap-2"><span class="flex-grow-1 text-break">${esc(displayName(f))}${displayName(f) !== f.name ? ` <small class="text-body-secondary">(${esc(f.name)})</small>` : ""}${f.downloaded ? ' <span class="badge text-bg-success">Đã có</span>' : ""}</span>` +
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
    toast(`Đã thêm ${added} file vào hàng chờ → ${outDir}`);
    state.selected.clear();
    state.dlTarget = null;
    renderFiles();
    setPanelOpen(true);
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
  show($("activeBox"), jobs.length > 0);
  if (!jobs.length) return;

  const downloading = jobs.filter((j) => j.status === "downloading").length;
  const total = jobs.reduce((s, j) => s + (j.size || 0), 0);
  const got = jobs.reduce((s, j) => s + (j.received || 0), 0);
  $("dlTitle").textContent =
    `Đang tải ${downloading} · chờ ${jobs.length - downloading} · ${fmt(got) || "0 B"} / ${fmt(total)}`;
  const bar = $("dlBar").querySelector(".progress-bar");
  bar.style.width = total ? `${(got / total) * 100}%` : "0";
  bar.className = "progress-bar progress-bar-striped progress-bar-animated";
  $("cancelBtn").disabled = !jobs.some((j) => j.status === "queued");

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
      <span class="badge text-bg-${color}">${label}</span></div>
      <div class="small text-body-secondary">${esc(detail)}</div>
      <div class="progress progress-thin mt-1"><div class="progress-bar bg-${color}${striped}" style="width:${pct}%"></div></div></li>`;
    })
    .join("");
}

// ---------- "Phát gần đây": the songs played lately (shared by every device of the account) ----------

/** "5 phút trước", "Hôm qua 21:04", "12/10 08:30" */
function ago(at) {
  const min = Math.floor((Date.now() - at) / 60000);
  if (min < 1) return "Vừa xong";
  if (min < 60) return `${min} phút trước`;
  const d = new Date(at);
  const hm = d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `Hôm nay ${hm}`;
  if (d.toDateString() === new Date(today - 86_400_000).toDateString()) return `Hôm qua ${hm}`;
  return `${d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" })} ${hm}`;
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
      <button class="btn btn-sm btn-outline-secondary btn-icon border-0 flex-none" data-recent-del="${esc(h.id)}" title="Bỏ khỏi danh sách"><i class="bi bi-x-lg"></i></button></li>`;
        })
        .join("")
    : `<li class="list-group-item small text-body-secondary text-center py-4">${all.length ? "Không có bài khớp" : "Chưa nghe bài nào — bài bạn nghe sẽ hiện ở đây"}</li>`;
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
    if (!f) return toast("Bài này không còn mở được (đã rời kênh hoặc tin đã bị xoá)", "warn");
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
    title: '<i class="bi bi-trash3 text-danger"></i> Xoá danh sách phát gần đây',
    body: `Xoá <strong>${state.recent.length}</strong> bài khỏi danh sách phát gần đây?`,
    ok: "Xoá",
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
    .then((r) => toast(`Đã huỷ ${r.cancelled} file`, "info"))
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
  scan: ({ scanId, count }) => {
    // Only the latest scan of this page: an earlier scan (same chat reloaded, other type / chat) or
    // another tab's scan must not make the number jump.
    if (!scanId || scanId !== state.scanId) return;
    const msg = $("scanMsg");
    if (msg) msg.textContent = `Đang quét kênh… ${count} file`;
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
}

applyCaps();
setView(homeView(), false);
connectEvents();
setPanelOpen(state.panelOpen && matchMedia("(min-width: 992px)").matches);
setSort("default");
