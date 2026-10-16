// `npm run publish`: put the app as it is now on Expo's servers (EAS Update, channel "preview") and show the QR
// code that opens it in Expo Go. No tunnel, no same Wi-Fi: the phone loads it from expo.dev on any network, the
// computer need not be on. The address never changes: scan it once, Expo Go keeps it in its list; a new
// `npm run publish` is fetched the next time the app is opened (close it fully and open it again).
// `npm run publish -- "what changed"` labels the update on expo.dev.
// The update holds the app's config like any build of it: the Telegram API ID / hash from ../.env included.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CHANNEL = "preview";
const app = JSON.parse(fs.readFileSync(path.join(APP, "app.json"), "utf8")).expo;
const projectId = app.extra?.eas?.projectId;
if (!projectId) {
  console.error("Chưa liên kết dự án Expo (app.json → extra.eas.projectId). Chạy: npx eas-cli@latest init");
  process.exit(1);
}

const message = process.argv.slice(2).join(" ") || `Cập nhật ${new Date().toLocaleString("vi-VN")}`;
const r = spawnSync(
  "npx",
  [
    "-y",
    "eas-cli@latest",
    "update",
    "--branch",
    CHANNEL,
    "--environment",
    "preview",
    "--message",
    message,
    "--non-interactive",
    // a fresh bundle: Metro's cache kept a value of EXPO_PUBLIC_MOCK from another build (the sample screens)
    "--clear-cache",
  ],
  { cwd: APP, stdio: "inherit" },
);
if (r.status !== 0) process.exit(r.status ?? 1);

// Expo Go opens an update by its project, channel and runtime (Expo Go 57 takes "exposdk:57.0.0")
const url =
  `exps://u.expo.dev/${projectId}?channel-name=${CHANNEL}` +
  `&runtime-version=${encodeURIComponent(app.runtimeVersion)}`;
const qrcode = createRequire(import.meta.url)("qrcode-generator");
const qr = qrcode(0, "L");
qr.addData(url);
qr.make();
// two rows of the code per line of text (▀ ▄ █), dark on light: a phone's camera reads it from the terminal
const n = qr.getModuleCount();
const dark = (r, c) => r >= 0 && c >= 0 && r < n && c < n && qr.isDark(r, c);
let out = "";
for (let r = -2; r < n + 2; r += 2) {
  let line = "";
  for (let c = -2; c < n + 2; c++) {
    const top = dark(r, c);
    const bottom = dark(r + 1, c);
    line += top && bottom ? " " : top ? "▄" : bottom ? "▀" : "█";
  }
  out += line + "\n";
}
console.log(`\nĐã đưa lên Expo. Mở trong Expo Go (quét bằng Camera của iPhone, hoặc trong Expo Go trên Android):\n`);
console.log(out);
console.log(url);
console.log(`\nĐã mở từ trước: tắt hẳn app trong Expo Go rồi mở lại để lấy bản mới.\n`);
