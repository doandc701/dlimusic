// Serve dist/ locally with the same headers as Vercel (vercel.json), to try the browser build.
//   node web/build.mjs && node web/preview.mjs     -> http://127.0.0.1:4173
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DIST = path.join(ROOT, "dist");
const PORT = Number(process.env.PORT) || 4173;
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".json": "application/json" };

// vercel.json "source" patterns are path-to-regexp; the few used here translate directly.
const rules = config.headers.map((h) => ({ re: new RegExp(`^${h.source.replace(/\(\.\*\)/g, ".*")}$`), headers: h.headers }));

const server = http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let file = path.normalize(path.join(DIST, decodeURIComponent(url.pathname)));
    if (!file.startsWith(DIST)) return res.writeHead(403).end();
    if (url.pathname === "/" || (fs.existsSync(file) && fs.statSync(file).isDirectory())) file = path.join(DIST, "index.html");
    for (const r of rules) if (r.re.test(url.pathname)) for (const h of r.headers) res.setHeader(h.key, h.value);
    if (!fs.existsSync(file)) return res.writeHead(404).end("Not found");
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${PORT}`;
    console.log(`Bản trình duyệt (giống Vercel): ${url}   — Ctrl+C để dừng`);
    if (process.argv.includes("--open")) {
      const cmd = process.env.TDL_OPEN_CMD || (process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open");
      spawn(cmd, [url], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
    }
  });

server.on("error", (err) => {
  console.error(err.code === "EADDRINUSE"
    ? `Cổng ${PORT} đang bị chương trình khác dùng. Tắt nó đi, hoặc chạy với cổng khác: PORT=4174 npm run preview:web`
    : `Không khởi động được: ${err.message}`);
  process.exit(1);
});
