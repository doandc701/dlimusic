// Static checks of the single-page UI (public/index.html + public/js/ui.js), shared by the local and the browser build.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const markup = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");
const script = fs.readFileSync(path.join(ROOT, "public/js/ui.js"), "utf8");

test("every element id is unique (a duplicate made the ‹ button also rewind the player)", () => {
  const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const dup = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  assert.deepEqual(dup, []);
});

test('every $("id") used by the script exists in the page', () => {
  const ids = new Set([...markup.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  // ids created at runtime by the script itself
  for (const m of script.matchAll(/\.id = "([^"]+)"/g)) ids.add(m[1]);
  for (const m of script.matchAll(/id="([^"$]+)"/g)) ids.add(m[1]);
  const used = [...new Set([...script.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]))];
  assert.deepEqual(
    used.filter((id) => !ids.has(id)),
    [],
  );
});

test("phone numbers: +84 is fixed in front and common ways of typing are understood", () => {
  const src = script.slice(script.indexOf("function composePhone("), script.indexOf("// ---------- verification code"));
  const composePhone = new Function(`${src}; return composePhone;`)();
  const cases = [
    ["84", "912345678", "+84912345678"],
    ["84", "0912345678", "+84912345678"],
    ["84", "0912 345 678", "+84912345678"],
    ["84", "091.234.5678", "+84912345678"],
    ["84", "+84912345678", "+84912345678"],
    ["84", "+84 912 345 678", "+84912345678"],
    ["84", "84912345678", "+84912345678"],
    ["84", "0084912345678", "+84912345678"],
    ["84", "(091) 234-5678", "+84912345678"],
    ["84", "91234567", null],
    ["84", "09123456789", null],
    ["84", "abc", null],
    ["84", "", null],
    ["84", "+6591234567", "+6591234567"],
    ["1", "4155552671", "+14155552671"],
    ["65", "9123 4567", "+6591234567"],
  ];
  for (const [code, typed, want] of cases) assert.equal(composePhone(code, typed), want, `+${code} "${typed}"`);
});

test("© year is filled in from the clock, never written in the page", () => {
  assert.ok(!/©\s*(<[^>]+>)?\s*\d{4}/.test(markup), "no fixed year after ©");
  assert.match(markup, /class="copy-year"><\/span>/);
  assert.match(script, /\.copy-year[\s\S]{0,80}new Date\(\)\.getFullYear\(\)/);
});

test("no two functions of the page share a name (the second silently replaces the first)", () => {
  const names = [...script.matchAll(/^\s*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]);
  const dup = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  assert.deepEqual(dup, []);
});

// the language files, in the order index.html loads them
const LANG_FILES = [...markup.matchAll(/<script src="(js\/lang\/[\w-]+\.js)"><\/script>/g)].map((m) => m[1]);

/** The language files + public/js/i18n.js, with just enough of a browser around them; returns window.tdlI18n. */
function loadI18n() {
  const window = {};
  const context = vm.createContext({
    window,
    document: { documentElement: {}, title: "", body: null },
    localStorage: { getItem: () => null },
    MutationObserver: class {
      observe() {}
      takeRecords() {}
    },
    addEventListener() {},
  });
  for (const f of [...LANG_FILES, "js/i18n.js"])
    vm.runInContext(fs.readFileSync(path.join(ROOT, "public", f), "utf8"), context);
  return window.tdlI18n;
}

test("i18n: index.html loads every language file of public/js/lang/, before i18n.js", () => {
  const files = fs
    .readdirSync(path.join(ROOT, "public/js/lang"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => `js/lang/${f}`);
  assert.deepEqual([...LANG_FILES].sort(), files.sort());
  assert.ok(markup.indexOf(LANG_FILES.at(-1)) < markup.indexOf('src="js/i18n.js"'));
  const { LANGS } = loadI18n();
  for (const [l, v] of Object.entries(LANGS)) for (const k of ["code", "name", "locale"]) assert.ok(v[k], `${l}.${k}`);
});
const normSpace = (s) => s.replace(/\s+/g, " ").trim();

test("i18n: every language has the same sentences, each with the same {placeholders}", () => {
  const { DICT, PATTERNS, t, setLang } = loadI18n();
  const keys = Object.keys(DICT.en);
  assert.ok(keys.length > 100);
  const names = (s) => [...new Set([...s.matchAll(/\{(\w+)[}|]/g)].map((m) => m[1]))].sort();
  const langs = Object.keys(DICT).filter((l) => l !== "vi");
  assert.ok(langs.length >= 3);
  for (const lang of langs) {
    assert.deepEqual(Object.keys(DICT[lang]).sort(), [...keys].sort(), `${lang}: the same sentences as en.js`);
    for (const vi of keys) assert.deepEqual(names(DICT[lang][vi]), names(vi), `${lang}: ${vi}`);
  }
  for (const p of PATTERNS) assert.ok(keys.includes(p), p);

  // values are filled in, English picks singular / plural, a sentence without a translation stays Vietnamese
  setLang("en");
  assert.equal(t("Đã huỷ {n} file", { n: 1 }), "Cancelled 1 file");
  assert.equal(t("Đã huỷ {n} file", { n: 3 }), "Cancelled 3 files");
  assert.equal(t("Không có trong từ điển {n}", { n: 2 }), "Không có trong từ điển 2");
});

test("i18n: every sentence ui.js passes to t() has a translation", () => {
  const keys = new Set(Object.keys(loadI18n().DICT.en).map(normSpace));
  const used = [...script.matchAll(/\bt\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g)].map((m) =>
    normSpace(m[1].startsWith("'") ? m[1].slice(1, -1) : JSON.parse(m[1])),
  );
  assert.ok(used.length > 100);
  assert.deepEqual(
    used.filter((s) => !keys.has(s)),
    [],
  );
});

test("service worker: a file is only pulled from the page that asked (no link from another site)", async () => {
  const handlers = {};
  const opened = [];
  const port = {
    postMessage(m, [reply]) {
      opened.push(m);
      reply.postMessage({ type: "error", status: 404, message: "test" });
      setTimeout(() => reply.close(), 0);
    },
  };
  const page = { id: "page-1", postMessage() {} };
  const self = {
    location: { origin: "https://dli.example" },
    addEventListener: (type, fn) => (handlers[type] = fn),
    clients: { matchAll: async () => [page], claim: async () => {} },
    skipWaiting() {},
  };
  const code = fs.readFileSync(path.join(ROOT, "web/sw.js"), "utf8");
  vm.runInNewContext(code, { self, URL, Response, ReadableStream, MessageChannel, setTimeout, clearTimeout });
  handlers.message({ data: { type: "provider" }, ports: [port], source: page });

  const fetchFor = (url, clientId) => {
    let answer;
    handlers.fetch({
      request: { url, headers: { get: () => null } },
      clientId,
      respondWith: (p) => (answer = p),
    });
    return answer;
  };
  // another site opens a download / media link: no client id, no (or a wrong) page id
  for (const url of [
    "https://dli.example/__dl?key=k&id=1&job=j",
    "https://dli.example/__dl?key=k&id=1&job=j&c=other",
    "https://dli.example/api/media?key=k&id=1",
  ]) {
    const res = await fetchFor(url, "");
    assert.equal(res.status, 503, url);
  }
  assert.equal(opened.length, 0, "the page was never asked for a file");
  // the page's own hidden frame (its id in c) and its own <audio> (its client id) are served
  assert.equal((await fetchFor("https://dli.example/__dl?key=k&id=1&job=j&c=page-1", "")).status, 404);
  assert.equal((await fetchFor("https://dli.example/api/media?key=k&id=1", "page-1")).status, 404);
  assert.deepEqual(
    opened.map((m) => [m.type, m.download]),
    [
      ["open", true],
      ["open", false],
    ],
  );
  // other origins are never answered by the worker
  assert.equal(fetchFor("https://evil.example/api/media?key=k&id=1", "page-1"), undefined);
});
