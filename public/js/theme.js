// Apply the saved / system colour theme before first paint.
(() => {
  let saved = null;
  try { saved = localStorage.getItem("theme"); } catch {}
  const theme = saved || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.setAttribute("data-bs-theme", theme);
})();
