// Metro for the DLiMusic app.
// - GramJS (Telegram) is written for Node and browsers: Node built-ins it asks for are mapped to browser
//   versions or empty stubs, like the web build does (web/build.mjs).
// - ../core.js and ../web/cloud-sync.js (MongoDB sync) are shared with the web version: they are watched, and
//   the packages they import come from this app's node_modules (one GramJS only, or its Api classes would not
//   match).
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const APP = __dirname;
const ROOT = path.resolve(APP, "..");
const SHARED = [path.join(ROOT, "core.js"), path.join(ROOT, "web/cloud-sync.js")];
const mod = (p) => path.join(APP, "node_modules", p);

const ALIAS = {
  crypto: mod("telegram/crypto/crypto.js"), // GramJS' own browser crypto (WebCrypto, polyfilled in src/polyfills.ts)
  path: mod("path-browserify/index.js"),
  events: mod("events/events.js"),
  util: mod("util/util.js"),
};
const STUBBED = new Set([
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
const STUB = path.join(APP, "src/shims/node-stub.js");
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const config = getDefaultConfig(APP);
config.watchFolders = [ROOT];
// the web version's own folders are not part of the app
config.resolver.blockList = [
  new RegExp(`^${escape(ROOT)}/(node_modules|dist|downloads|test|public|cloud|api)/.*`),
  new RegExp(`^${escape(ROOT)}/web/(?!cloud-sync\\.js$).*`),
];
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const id = moduleName.replace(/^node:/, "");
  if (ALIAS[id]) return { type: "sourceFile", filePath: ALIAS[id] };
  if (STUBBED.has(id)) return { type: "sourceFile", filePath: STUB };
  // packages imported by the shared web files resolve as if imported from the app
  if (SHARED.includes(context.originModulePath) && !moduleName.startsWith(".")) {
    return context.resolveRequest({ ...context, originModulePath: path.join(APP, "index.js") }, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
