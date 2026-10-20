// Builds the browser version (static files for Vercel) into dist/.
//   node web/build.mjs
// TG_API_ID / TG_API_HASH (optional) are baked into the bundle; without them users enter their own.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// Local builds take the API ID/hash from the project's .env (API_ID / API_HASH) unless TG_API_ID /
// TG_API_HASH are set. On Vercel there is no .env (it is never uploaded): its env vars are used.
if (!process.env.TG_API_ID && !process.env.TG_API_HASH) {
  try {
    const env = Object.fromEntries(
      fs
        .readFileSync(path.join(ROOT, ".env"), "utf8")
        .split(/\r?\n/)
        .map((l) => /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(l))
        .filter(Boolean)
        .map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]),
    );
    if (env.API_ID && env.API_HASH) {
      process.env.TG_API_ID = env.API_ID;
      process.env.TG_API_HASH = env.API_HASH;
      console.log('Dùng API ID/hash từ .env (lựa chọn "Dùng API có sẵn").');
    }
  } catch {
    // no .env: users enter their own API ID
  }
}
const OUT = path.join(ROOT, "dist");
const req = (p) => path.join(ROOT, "node_modules", p);
const STUB = path.join(ROOT, "web/stubs.js");

const alias = {
  crypto: req("telegram/crypto/crypto.js"), // GramJS' own browser crypto
  path: req("path-browserify/index.js"),
  events: req("events/events.js"),
  util: req("util/util.js"),
};
const stubbed = new Set([
  "fs",
  "net",
  "os",
  "tls",
  "stream",
  "assert",
  "constants",
  "child_process",
  "socks",
  "node-localstorage",
  "graceful-fs",
  "write-file-atomic",
  "store2",
]);

const nodeShims = {
  name: "node-shims",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      const id = args.path.replace(/^node:/, "");
      if (alias[id]) return { path: alias[id] };
      if (stubbed.has(id)) return { path: STUB };
      return undefined;
    });
  },
};

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

await build({
  entryPoints: { app: path.join(ROOT, "web/backend.js") },
  bundle: true,
  platform: "browser",
  format: "iife",
  target: ["es2022"],
  minify: true,
  sourcemap: false,
  outdir: OUT,
  inject: [path.join(ROOT, "web/shim.js")],
  plugins: [nodeShims],
  define: {
    "process.env.NODE_ENV": '"production"',
    __TG_API_ID__: JSON.stringify(process.env.TG_API_ID || ""),
    __TG_API_HASH__: JSON.stringify(process.env.TG_API_HASH || ""),
  },
  logLevel: "warning",
});

await build({
  entryPoints: { sw: path.join(ROOT, "web/sw.js") },
  bundle: true,
  platform: "browser",
  format: "iife",
  target: ["es2022"],
  minify: true,
  outdir: OUT,
  logLevel: "warning",
});

// The UI is the same page as the local version (public/): copy its files; the browser backend (app.js)
// is loaded right before ui.js.
let html = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");
if (/<script>/.test(html))
  throw new Error("public/index.html must not contain inline scripts (CSP is script-src 'self')");
const UI_TAG = '<script src="js/ui.js"></script>';
if (!html.includes(UI_TAG)) throw new Error(`${UI_TAG} not found in public/index.html`);
html = html.replace(UI_TAG, `<script src="app.js"></script>\n${UI_TAG}`);
fs.writeFileSync(path.join(OUT, "index.html"), html);
for (const dir of ["css", "js", "img"])
  fs.cpSync(path.join(ROOT, "public", dir), path.join(OUT, dir), {
    recursive: true,
    filter: (src) => !src.endsWith(".md"), // notes for whoever edits the files (js/lang/README.md)
  });
// for search engines: what to crawl, and the page's address
for (const file of ["robots.txt", "sitemap.xml"])
  fs.copyFileSync(path.join(ROOT, "public", file), path.join(OUT, file));

const size = (f) => (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0) + " KB";
const files = fs.readdirSync(OUT, { recursive: true }).filter((f) => fs.statSync(path.join(OUT, f)).isFile());
console.log(`dist/: ${files.map((f) => `${f} (${size(f)})`).join(", ")}`);
