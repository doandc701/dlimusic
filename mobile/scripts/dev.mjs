// `npm run dev`: Expo for Expo Go, reachable from a phone on any network (4G, a Wi-Fi that keeps devices apart):
// a Cloudflare quick tunnel to Metro (needs `cloudflared` on the PATH), then `expo start` using that address.
// `npm run dev -- --lan` skips the tunnel (phone on the same Wi-Fi as this computer).
// `npm run dev -- --usb`: this computer on the phone's Personal Hotspot — by cable or by its Wi-Fi (or an Android
// phone's USB tethering):
// phone and computer then share a small network over the cable, Expo Go reaches the computer through it — no
// Internet path needed, the edits show at once (Fast Refresh). Ctrl+C stops both.
// A quick tunnel has no uptime guarantee: one that could not be had or was cut is asked for again (a new address:
// Expo restarts with it, its QR code is shown again).
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PORT = process.env.PORT || "8081";
const usb = process.argv.includes("--usb");
const lan = usb || process.argv.includes("--lan");

/** This computer's address on the phone's tethering network (iPhone: 172.20.10.x; Android: 192.168.42.x…). */
function tetherAddress() {
  for (const [name, addrs] of Object.entries(os.networkInterfaces()))
    for (const a of addrs ?? [])
      if (a.family === "IPv4" && !a.internal && /^(172\.20\.10\.|192\.168\.42\.|192\.168\.44\.)/.test(a.address))
        return { name, address: a.address };
  return null;
}

const TRIES = 5; // a quick tunnel that could not be had / was cut: asked again this many times in a row
let expo = null;
let restarting = false;

function startExpo(proxyUrl, host) {
  const env = { ...process.env };
  if (proxyUrl) env.EXPO_PACKAGER_PROXY_URL = proxyUrl;
  if (host) env.REACT_NATIVE_PACKAGER_HOSTNAME = host; // the address put in the QR code
  const child = spawn("npx", ["expo", "start", "--go", "--port", PORT], { cwd: APP, env, stdio: "inherit" });
  child.on("exit", (code) => !restarting && process.exit(code ?? 0));
  return child;
}

/** Expo again with a new address (the tunnel was made again: its address changed). */
function restartExpo(proxyUrl) {
  const old = expo;
  restarting = true;
  const go = () => {
    restarting = false;
    expo = startExpo(proxyUrl);
  };
  if (!old || old.exitCode !== null) return go();
  old.once("exit", go);
  old.kill("SIGINT");
}

if (usb) {
  const tether = tetherAddress();
  if (!tether) {
    console.error(
      "Chưa thấy mạng qua cáp với điện thoại.\n" +
        "iPhone: bật Cài đặt → Điểm truy cập cá nhân → Cho phép người khác kết nối, rồi nối máy tính vào đó:\n" +
        "  - bằng cáp (chọn Tin cậy máy tính này nếu được hỏi), hoặc\n" +
        "  - bằng Wi-Fi của máy tính: chọn mạng tên iPhone trong danh sách Wi-Fi.\n" +
        "Đợi vài giây rồi chạy lại: npm run dev -- --usb",
    );
    process.exit(1);
  }
  console.log(`\nQua cáp (${tether.name}): ${tether.address} — Expo Go trên điện thoại quét mã QR bên dưới.\n`);
  expo = startExpo(null, tether.address);
} else if (lan) expo = startExpo();
else {
  let tunnel = null;
  let tries = 0;

  function openTunnel() {
    tries++;
    tunnel = spawn(
      process.env.CLOUDFLARED || "cloudflared",
      ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${PORT}`],
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let log = "";
    let url = null;
    tunnel.stderr.setEncoding("utf8");
    tunnel.stderr.on("data", (chunk) => {
      log = (log + chunk).slice(-4000);
      if (url) return;
      // the tunnel's own address — not the service's api.trycloudflare.com, which its errors mention (taken for the
      // tunnel, it made Expo Go show "405 Method Not Allowed")
      url = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/.exec(log)?.[0] ?? null;
      if (!url) return;
      tries = 0;
      console.log(`\nĐường hầm: ${url}\nMở trong Expo Go: ${url.replace("https://", "exps://")}\n`);
      if (expo) {
        console.log("Địa chỉ mới: quét lại mã QR bên dưới trong Expo Go.\n");
        restartExpo(url);
      } else expo = startExpo(url);
    });
    tunnel.on("error", (err) => {
      console.error(
        err.code === "ENOENT"
          ? "Chưa có cloudflared. Cài: curl -L -o ~/.local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x ~/.local/bin/cloudflared\nHoặc chạy cùng Wi-Fi: npm run dev -- --lan"
          : `Không tạo được đường hầm: ${err.message}`,
      );
      process.exit(1);
    });
    tunnel.on("exit", (code) => {
      if (stopping) return;
      // why (the last line cloudflared wrote: "failed to request quick Tunnel…", a lost connection…)
      const why = log.trim().split("\n").pop() ?? "";
      if (url) console.error(`\n⚠ Đường hầm bị ngắt (Expo Go sẽ báo lỗi 405). ${why}`);
      if (tries >= TRIES) {
        console.error(
          `\nKhông tạo được đường hầm sau ${TRIES} lần (cloudflared thoát, mã ${code}): ${why}\n` +
            "Mạng của máy tính đang không vào được trycloudflare.com. Thử lại sau, hoặc cho điện thoại dùng cùng Wi-Fi: npm run dev -- --lan",
        );
        stop(1);
        return;
      }
      console.error(`Đang tạo lại đường hầm (lần ${tries + 1}/${TRIES})…`);
      setTimeout(openTunnel, 3000);
    });
  }

  let stopping = false;
  const stop = (code = 0) => {
    stopping = true;
    tunnel?.kill();
    expo?.kill("SIGINT");
    process.exit(code);
  };
  process.on("SIGINT", () => stop());
  process.on("SIGTERM", () => stop());
  openTunnel();
}
