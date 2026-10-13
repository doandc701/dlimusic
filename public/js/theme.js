// Colour theme: "light", "dark" or "system" (follows the device, also when it switches by itself at sunset).
// Applied before first paint; ui.js builds the menu on top of window.tdlTheme.
(() => {
  const KEY = "theme"; // "light" / "dark"; nothing saved = follow the system
  const MODES = ["light", "dark", "system"];
  const dark = matchMedia("(prefers-color-scheme: dark)");
  const saved = () => {
    try {
      const s = localStorage.getItem(KEY);
      return s === "light" || s === "dark" ? s : "system";
    } catch {
      return "system";
    }
  };
  let mode = saved();
  const apply = () => {
    const theme = mode === "system" ? (dark.matches ? "dark" : "light") : mode;
    document.documentElement.setAttribute("data-bs-theme", theme);
    document.dispatchEvent(new CustomEvent("tdl:theme", { detail: { mode, theme } }));
  };
  const follow = () => mode === "system" && apply();
  if (dark.addEventListener) dark.addEventListener("change", follow);
  else dark.addListener?.(follow); // Safari before 14
  // Some phones don't tell a page in the background that the system theme changed: check when it comes back.
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && follow());
  // Another tab of the app changed the choice.
  addEventListener("storage", (e) => {
    if (e.key !== KEY && e.key !== null) return;
    mode = saved();
    apply();
  });
  window.tdlTheme = {
    MODES,
    get mode() {
      return mode;
    },
    set(next) {
      mode = MODES.includes(next) ? next : "system";
      // Picking what the system already shows = follow the system again (and keep following it).
      if (mode === (dark.matches ? "dark" : "light")) mode = "system";
      try {
        if (mode === "system") localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, mode);
      } catch {}
      apply();
    },
  };
  apply();
})();

// The layout is made for 320px and up. On a narrower phone, lay the page out at 320px and let the browser
// scale it down to fit, instead of squeezing it any further (styles.css also keeps 320px as the minimum).
(() => {
  const MIN = 320;
  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return;
  const fit = () => {
    const want = screen.width < MIN ? `width=${MIN}` : "width=device-width, initial-scale=1";
    if (meta.content !== want) meta.content = want;
  };
  fit();
  addEventListener("orientationchange", fit);
  addEventListener("resize", fit);
})();
