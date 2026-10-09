// Unit tests for the shared helpers — no network, no Telegram account needed.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Api } from "telegram";
import { sanitize, safeMediaType, formatBytes, fileInfo, mediaKind, resolveTarget, claimTarget, FILTERS } from "../lib.js";
import { parseSelection } from "../index.js";

function docMessage(id, { mimeType = "audio/mpeg", size = 1000, attributes = [] } = {}) {
  return new Api.Message({
    id,
    media: new Api.MessageMediaDocument({
      document: new Api.Document({ id: BigInt(id), mimeType, size, attributes }),
    }),
  });
}

describe("sanitize", () => {
  test("replaces characters that are invalid in file names", () => {
    assert.equal(sanitize('a/b\\c:d*e?f"g<h>i|j'), "a_b_c_d_e_f_g_h_i_j");
  });
  test("collapses whitespace and trims", () => {
    assert.equal(sanitize("  Sơn Tùng   -  Lạc Trôi \n.mp3 "), "Sơn Tùng - Lạc Trôi .mp3");
  });
  test("keeps Vietnamese and emoji", () => {
    assert.equal(sanitize("Nhạc Lọt Club 🎧"), "Nhạc Lọt Club 🎧");
  });
  test("falls back to 'file' when empty", () => {
    assert.equal(sanitize("   "), "file");
  });
  test("limits length to 200 characters", () => {
    assert.equal(sanitize("x".repeat(500)).length, 200);
  });
});

describe("security: names from Telegram can never leave the download folder (R5)", () => {
  const base = "/home/u/Music";
  const evil = ["..", ".", " .. ", "...", "../..", "..\\..", "a/../../b", "\u202Etxt.exe", ".bashrc", "CON", "nul.txt", "x\x7f", "", "   "];
  for (const name of evil) {
    test(`${JSON.stringify(name)} stays inside`, () => {
      const out = sanitize(name);
      const full = path.join(base, out);
      assert.ok(full.startsWith(base + path.sep), `${JSON.stringify(name)} -> ${full}`);
      assert.equal(path.dirname(full), base, "exactly one level below the folder");
      assert.ok(!/^\.+$/.test(out) && !out.startsWith("."), "no dot-only or hidden names");
      assert.ok(!/[\u202A-\u202E\u2066-\u2069\x00-\x1f\x7f]/.test(out), "no control / bidi characters");
    });
  }
  test("normal Vietnamese names are unchanged", () => {
    for (const n of ["Lạc Trôi.mp3", "Nhạc Lọt Club 🎧", "Đen - Mang Tiền Về Cho Mẹ.m4a"]) assert.equal(sanitize(n), n);
  });
});

describe("security: MIME types from Telegram (R6)", () => {
  test("media types pass through", () => {
    for (const m of ["audio/mpeg", "audio/mp4", "video/mp4", "video/x-matroska", "image/jpeg", "image/webp"]) assert.equal(safeMediaType(m), m);
  });
  test("anything a browser could run, or header injection, becomes a download", () => {
    for (const m of ["text/html", "TEXT/HTML", "image/svg+xml", "application/javascript", "text/xml", "application/xhtml+xml",
      "audio/mpeg\r\nSet-Cookie: x=1", "audio/mpeg; x", "", null, undefined]) {
      assert.equal(safeMediaType(m), "application/octet-stream", String(m));
    }
  });
});

describe("formatBytes", () => {
  test("formats each unit", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(512), "512.0 B");
    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(formatBytes(25.9 * 1024 ** 2), "25.9 MB");
    assert.equal(formatBytes(1.6 * 1024 ** 3), "1.6 GB");
  });
});

describe("fileInfo", () => {
  test("uses the document file name when present", () => {
    const msg = docMessage(1, { attributes: [new Api.DocumentAttributeFilename({ fileName: "Lạc Trôi.mp3" })] });
    assert.deepEqual(fileInfo(msg), { name: "Lạc Trôi.mp3", size: 1000 });
  });

  test("builds 'Performer - Title.ext' from audio tags when there is no file name", () => {
    const msg = docMessage(2, {
      mimeType: "audio/mp4",
      attributes: [new Api.DocumentAttributeAudio({ duration: 200, performer: "Đen", title: "Mang Tiền Về Cho Mẹ" })],
    });
    assert.equal(fileInfo(msg).name, "Đen - Mang Tiền Về Cho Mẹ.m4a");
  });

  test("keeps the audio tags Telegram shows, even when the file name is different", () => {
    const msg = docMessage(10, {
      size: 289651899,
      attributes: [
        new Api.DocumentAttributeFilename({ fileName: "Tặng anh em.mp3" }),
        new Api.DocumentAttributeAudio({ duration: 7200, title: "Nhún Nhảy Chạm Cảm Xúc 2026 - Như Đức", performer: "Như Đức" }),
      ],
    });
    assert.deepEqual(fileInfo(msg), {
      name: "Tặng anh em.mp3",
      size: 289651899,
      title: "Nhún Nhảy Chạm Cảm Xúc 2026 - Như Đức",
      performer: "Như Đức",
      duration: 7200,
    });
  });

  test("falls back to kind_id.ext", () => {
    assert.equal(fileInfo(docMessage(3, { mimeType: "video/mp4" })).name, "video_3.mp4");
    const voice = docMessage(4, { mimeType: "audio/ogg", attributes: [new Api.DocumentAttributeAudio({ duration: 3, voice: true })] });
    assert.equal(fileInfo(voice).name, "voice_4.ogg");
  });

  test("sanitizes unsafe names coming from Telegram", () => {
    const msg = docMessage(5, { attributes: [new Api.DocumentAttributeFilename({ fileName: "../../etc/passwd" })] });
    assert.ok(!fileInfo(msg).name.includes("/"));
  });

  test("names photos photo_<id>.jpg", () => {
    const msg = new Api.Message({ id: 6, media: new Api.MessageMediaPhoto({ photo: new Api.Photo({ id: 1n }) }) });
    assert.deepEqual(fileInfo(msg), { name: "photo_6.jpg", size: 0 });
  });

  test("skips stickers, text messages and non-file media", () => {
    const sticker = docMessage(7, { mimeType: "image/webp", attributes: [new Api.DocumentAttributeSticker({ alt: "😀" })] });
    assert.equal(fileInfo(sticker), null);
    assert.equal(fileInfo(new Api.Message({ id: 8, message: "hello" })), null);
    assert.equal(fileInfo(new Api.Message({ id: 9, media: new Api.MessageMediaGeo({}) })), null);
  });
});

describe("mediaKind", () => {
  test("classifies photos, videos, music, voice, images and other files", () => {
    const photo = new Api.Message({ id: 1, media: new Api.MessageMediaPhoto({ photo: new Api.Photo({ id: 1n }) }) });
    assert.equal(mediaKind(photo), "photo");
    assert.equal(mediaKind(docMessage(2, { mimeType: "video/mp4", attributes: [new Api.DocumentAttributeVideo({ duration: 10, w: 1, h: 1 })] })), "video");
    assert.equal(mediaKind(docMessage(3, { mimeType: "video/x-matroska" })), "video");
    assert.equal(mediaKind(docMessage(4, { attributes: [new Api.DocumentAttributeAudio({ duration: 3 })] })), "audio");
    assert.equal(mediaKind(docMessage(5, { mimeType: "audio/ogg", attributes: [new Api.DocumentAttributeAudio({ duration: 3, voice: true })] })), "voice");
    assert.equal(mediaKind(docMessage(6, { mimeType: "image/png" })), "image");
    assert.equal(mediaKind(docMessage(7, { mimeType: "application/pdf" })), "document");
    assert.equal(mediaKind(new Api.Message({ id: 8, message: "hi" })), null);
  });
});

describe("resolveTarget", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tele-dl-test-"));
  const write = (name, bytes) => fs.writeFileSync(path.join(dir, name), Buffer.alloc(bytes));

  test("new file -> download to its own name", () => {
    assert.deepEqual(resolveTarget(dir, "new.mp3", 10, 1), { filePath: path.join(dir, "new.mp3"), skip: false });
  });

  test("same name and same size -> skip", () => {
    write("same.mp3", 10);
    assert.deepEqual(resolveTarget(dir, "same.mp3", 10, 1), { filePath: path.join(dir, "same.mp3"), skip: true });
  });

  test("same name, different size -> save as name_<msgId>", () => {
    write("clash.mp3", 10);
    assert.deepEqual(resolveTarget(dir, "clash.mp3", 99, 42), { filePath: path.join(dir, "clash_42.mp3"), skip: false });
  });

  test("the renamed copy is skipped once it is complete", () => {
    write("clash_42.mp3", 99);
    assert.deepEqual(resolveTarget(dir, "clash.mp3", 99, 42), { filePath: path.join(dir, "clash_42.mp3"), skip: true });
  });

  test("a leftover .part file is not treated as downloaded", () => {
    write("partial.mp3.part", 5);
    assert.equal(resolveTarget(dir, "partial.mp3", 10, 1).skip, false);
  });
});

describe("claimTarget (re-posted duplicates)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tele-dl-claim-"));

  test("3 concurrent jobs for the same name+size: one downloads, the others end up skipped", async () => {
    const claims = [1, 2, 3].map((id) => claimTarget(dir, "dup.mp3", 10, id));
    const first = await claims[0];
    assert.equal(first.skip, false);

    // The others must still be waiting while the first one holds the target.
    let settled = 0;
    claims.slice(1).forEach((c) => c.then(() => settled++));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(settled, 0, "duplicates wait instead of writing the same .part file");

    fs.writeFileSync(first.filePath, Buffer.alloc(10)); // first download completes
    first.release();
    const rest = await Promise.all(claims.slice(1));
    assert.deepEqual(rest.map((c) => c.skip), [true, true]);
  });

  test("if the first download fails, a waiting duplicate takes over", async () => {
    const a = await claimTarget(dir, "retry.mp3", 10, 1);
    const b = claimTarget(dir, "retry.mp3", 10, 2);
    a.release(); // failed: no file written
    const taken = await b;
    assert.equal(taken.skip, false);
    assert.equal(taken.filePath, path.join(dir, "retry.mp3"));
    taken.release();
  });
});

describe("parseSelection (CLI picker)", () => {
  const sorted = (s) => [...s].sort((a, b) => a - b);
  test("single numbers, lists and ranges", () => {
    assert.deepEqual(sorted(parseSelection("1,3, 5-7", 10)), [1, 3, 5, 6, 7]);
  });
  test("reversed ranges and out-of-range values are clamped", () => {
    assert.deepEqual(sorted(parseSelection("9-8 99 0", 10)), [8, 9]);
  });
  test("rejects garbage", () => {
    assert.equal(parseSelection("abc", 10), null);
    assert.equal(parseSelection("1,x", 10), null);
  });
});

test("FILTERS covers every type offered in the UI", () => {
  for (const t of ["all", "music", "video", "photo", "document", "voice"]) assert.ok(t in FILTERS, t);
});
