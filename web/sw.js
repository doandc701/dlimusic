// Service worker of the browser build.
//
// <audio>, <video> and <img> need a URL, and big downloads must be streamed to disk instead of being
// held in memory. This worker answers two kinds of requests and pulls the bytes, chunk by chunk, from
// the page that holds the Telegram connection (web/backend.js -> serveStream):
//   /api/media?key=&id=          play / preview, with Range support so the player can seek
//   /__dl?key=&id=&job=&c=       a download into the browser's Downloads folder (attachment)
// and, for the page of a shared playlist (public/js/share.js):
//   /api/cloud/share-audio?…     the range the player asks for, whole, from the function's pieces (see shareAudio)

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
  else if (url.pathname === "/api/cloud/share-audio") event.respondWith(shareAudio(event.request, url));
  else if (url.pathname === "/__dl") event.respondWith(serve(event, url, true));
});

const SAFE_HEADERS = { "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'" };
// Defense in depth: only media types are served as-is, whatever the page says (same list as core.js).
const SAFE_MEDIA = /^(audio\/[\w.+-]+|video\/[\w.+-]+|image\/(jpeg|png|gif|webp|bmp|avif))$/i;
const safeType = (mime) =>
  SAFE_MEDIA.test(String(mime || "").trim()) ? String(mime).trim().toLowerCase() : "application/octet-stream";

// The next songs, fetched ahead by the page (web/backend.js -> prefetch): served from here, no page needed.
const NEXT_CACHE = "tdl-next-songs";

async function fromCache(url, range) {
  let res;
  try {
    res = await (await caches.open(NEXT_CACHE)).match(url.pathname + url.search);
  } catch {
    return null;
  }
  if (!res) return null;
  const blob = await res.blob();
  const type = safeType(res.headers.get("Content-Type"));
  const size = blob.size;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range || "");
  if (!m)
    return new Response(blob, {
      status: 200,
      headers: { ...SAFE_HEADERS, "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": String(size) },
    });
  const start = m[1] === "" ? size - Number(m[2]) : Number(m[1]);
  const end = m[1] === "" || m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (!(start >= 0) || start > end || start >= size)
    return new Response("", { status: 416, headers: { ...SAFE_HEADERS, "Content-Range": `bytes */${size}` } });
  return new Response(blob.slice(start, end + 1, type), {
    status: 206,
    headers: {
      ...SAFE_HEADERS,
      "Content-Type": type,
      "Accept-Ranges": "bytes",
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${size}`,
    },
  });
}

async function serve(event, url, download) {
  if (!download) {
    const cached = await fromCache(url, event.request.headers.get("range"));
    if (cached) return cached;
  }
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

// ---------- a shared playlist's song: the whole range asked, from the function's pieces ----------
// /api/cloud/share-audio answers one piece at most (the function's answers are 4.5 MB at most): Chrome asks again
// for the rest, but Safari takes the first piece for the whole song and stops there (a 30 s song ended at 17 s).
// Here the player gets what it asked for, the pieces fetched one after another as it reads them.

const SHARE_PIECE = 3 * 1024 * 1024; // core.js SHARE_CHUNK

async function shareAudio(request, url) {
  const size = Number(url.searchParams.get("n"));
  if (!(size > 0)) return fetch(request);
  const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") || "");
  let start = 0;
  let end = size - 1;
  if (m && m[1] === "") start = Math.max(0, size - Number(m[2]));
  else if (m) {
    start = Number(m[1]);
    if (m[2] !== "") end = Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || end < start)
    return new Response("", { status: 416, headers: { ...SAFE_HEADERS, "Content-Range": `bytes */${size}` } });
  const pieceEnd = (at) => Math.min(end, (Math.floor(at / SHARE_PIECE) + 1) * SHARE_PIECE - 1);
  const get = (from) => fetch(url.href, { headers: { Range: `bytes=${from}-${pieceEnd(from)}` } });
  // within one piece (the page's own prefetch, Safari's first "bytes=0-1"): as it is
  if (m && pieceEnd(start) === end) return get(start);
  const first = await get(start);
  if (!first.ok || !first.body) return first; // an expired URL (403): the page asks for a new one
  let at = start;
  let reader = first.body.getReader();
  const body = new ReadableStream(
    {
      async pull(controller) {
        for (;;) {
          if (!reader) {
            if (at > end) return controller.close();
            const res = await get(at).catch(() => null);
            if (!res?.ok || !res.body) return controller.error(new Error(`share-audio ${res?.status}`));
            reader = res.body.getReader();
          }
          const { done, value } = await reader.read();
          if (done) {
            reader = null;
            continue;
          }
          at += value.length;
          controller.enqueue(value);
          return;
        }
      },
      cancel() {
        reader?.cancel().catch(() => {});
      },
    },
    { highWaterMark: 1 }, // fetched only as fast as the player reads
  );
  const headers = {
    ...SAFE_HEADERS,
    "Content-Type": safeType(url.searchParams.get("t")),
    "Accept-Ranges": "bytes",
    "Content-Length": String(end - start + 1),
  };
  if (m) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  return new Response(body, { status: m ? 206 : 200, headers });
}
