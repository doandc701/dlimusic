// Static checks of the single-page UI (public/index.html + public/js/ui.js), shared by the local and the browser build.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

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

test("each show filter group (desktop bar, phone sheet) has every filter exactly once", () => {
  for (const group of ["showSeg", "showSegM"]) {
    const start = markup.indexOf(`id="${group}"`);
    const block = markup.slice(start, markup.indexOf("</div>", start));
    const shows = [...block.matchAll(/data-show="(\w+)"/g)].map((m) => m[1]);
    assert.deepEqual(shows, ["all", "new", "done"], group);
  }
});

test("no two functions of the page share a name (the second silently replaces the first)", () => {
  const names = [...script.matchAll(/^\s*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]);
  const dup = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  assert.deepEqual(dup, []);
});
