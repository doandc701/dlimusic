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
