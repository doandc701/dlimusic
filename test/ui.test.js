// Static checks of the single-page UI (public/index.html), shared by the local and the browser build.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const html = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");
const scriptStart = html.indexOf("<script>\nconst $");
const markup = html.slice(0, scriptStart);
const script = html.slice(scriptStart);

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
  assert.deepEqual(used.filter((id) => !ids.has(id)), []);
});

test("phone numbers: +84 is fixed in front and common ways of typing are understood", () => {
  const src = script.slice(script.indexOf("function composePhone("), script.indexOf('$("loginForm").addEventListener("submit"'));
  const composePhone = new Function(`${src}; return composePhone;`)();
  const cases = [
    ["84", "912345678", "+84912345678"], ["84", "0912345678", "+84912345678"], ["84", "0912 345 678", "+84912345678"],
    ["84", "091.234.5678", "+84912345678"], ["84", "+84912345678", "+84912345678"], ["84", "+84 912 345 678", "+84912345678"],
    ["84", "84912345678", "+84912345678"], ["84", "0084912345678", "+84912345678"], ["84", "(091) 234-5678", "+84912345678"],
    ["84", "91234567", null], ["84", "09123456789", null], ["84", "abc", null], ["84", "", null],
    ["84", "+6591234567", "+6591234567"], ["1", "4155552671", "+14155552671"], ["65", "9123 4567", "+6591234567"],
  ];
  for (const [code, typed, want] of cases) assert.equal(composePhone(code, typed), want, `+${code} "${typed}"`);
});
