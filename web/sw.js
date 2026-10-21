// Service worker of the browser build.
//
// <audio>, <video> and <img> need a URL, and big downloads must be streamed to disk instead of being
// held in memory. This worker answers two kinds of requests and pulls the bytes, chunk by chunk, from
// the page that holds the Telegram connection (web/backend.js -> serveStream):
//   /api/media?key=&id=          play / preview, with Range support so the player can seek
//   /__dl?key=&id=&job=&c=       a download into the browser's Downloads folder (attachment)

const providers = new Map(); // page client id -> MessagePort to that page
const waiting = [];

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("message", (event) => {
  // After a hard reload (Ctrl+Shift+R) the page is not controlled; it asks to be taken over.
  if (event.data?.type === "claim") {
    event.waitUntil(self.clients.claim());
    return;
  }
  if (event.data?.type === "provider" && event.ports[0] && event.source) {
    providers.set(event.source.id, event.ports[0]);
    event.source.postMessage({ type: "provider-ok", clientId: event.source.id });
    waiting.splice(0).forEach((resolve) => resolve());
  }
});

async function providerFor(clientId) {
  if (!clientId) return null;
  const pages = await self.clients.matchAll({ type: "window" });
  const live = new Set(pages.map((c) => c.id));
  for (const id of providers.keys()) if (!live.has(id)) providers.delete(id);
  // Only the page that asked: a link opened from another site (a navigation, no client id) must not get a
  // file from the account of whichever DLiMusic tab is open. The hidden download frame passes its page's id.
  const pick = () => (clientId && providers.get(clientId)) || null;
  if (pick()) return pick();
  // The worker was restarted and forgot the pages: ask them to register again.
  for (const page of pages) page.postMessage({ type: "need-provider" });
  await Promise.race([new Promise((r) => waiting.push(r)), new Promise((r) => setTimeout(r, 4000))]);
  return pick();
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/api/media") event.respondWith(serve(event, url, false));
  else if (url.pathname === "/__dl") event.respondWith(serve(event, url, true));
});

const SAFE_HEADERS = { "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'" };
// Defense in depth: only media types are served as-is, whatever the page says (same list as core.js).
const SAFE_MEDIA = /^(audio\/[\w.+-]+|video\/[\w.+-]+|image\/(jpeg|png|gif|webp|bmp|avif))$/i;
const safeType = (mime) =>
  SAFE_MEDIA.test(String(mime || "").trim()) ? String(mime).trim().toLowerCase() : "application/octet-stream";

async function serve(event, url, download) {
  const port = await providerFor(event.clientId || url.searchParams.get("c"));
  if (!port)
    return new Response("Trang DLiMusic không còn mở, hãy tải lại trang.", { status: 503, headers: SAFE_HEADERS });

  const channel = new MessageChannel();
  const next = (ms) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), ms);
      channel.port1.onmessage = (m) => {
        clearTimeout(timer);
        resolve(m.data);
      };
    });

  const first = next(30_000);
  port.postMessage(
    {
      type: "open",
      key: url.searchParams.get("key"),
      id: url.searchParams.get("id"),
      jobId: url.searchParams.get("job"),
      range: event.request.headers.get("range"),
      download,
    },
    [channel.port2],
  );

  let meta;
  try {
    meta = await first;
  } catch {
    return new Response("Hết thời gian chờ Telegram", { status: 504, headers: SAFE_HEADERS });
  }
  if (meta.type === "error") {
    const headers = { ...SAFE_HEADERS, ...(meta.status === 416 && { "Content-Range": `bytes */${meta.size}` }) };
    return new Response(meta.message || "", { status: meta.status || 500, headers });
  }

  const headers = {
    ...SAFE_HEADERS,
    "Content-Type": download ? "application/octet-stream" : safeType(meta.mime),
    "Accept-Ranges": "bytes",
    "Content-Length": String(meta.end - meta.start + 1),
  };
  if (meta.status === 206) headers["Content-Range"] = `bytes ${meta.start}-${meta.end}/${meta.size}`;
  if (download) headers["Content-Disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(meta.name)}`;

  const body = new ReadableStream(
    {
      async pull(controller) {
        const reply = next(120_000);
        channel.port1.postMessage({ type: "pull" });
        let m;
        try {
          m = await reply;
        } catch (err) {
          controller.error(err);
          return;
        }
        if (m.type === "chunk") controller.enqueue(m.data);
        else if (m.type === "end") controller.close();
        else controller.error(new Error(m.message || "stream error"));
      },
      cancel() {
        channel.port1.postMessage({ type: "cancel" });
      },
    },
    { highWaterMark: 1 }, // pull only as fast as the player / download consumes
  );
  return new Response(body, { status: meta.status, headers });
}
