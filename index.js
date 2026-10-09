#!/usr/bin/env node
// Download all media files from a Telegram chat / group / channel using a user account (MTProto).
//
// Usage:
//   node index.js --list                         # list your chats with their IDs
//   node index.js --chat <username|id|link>      # show the file list, pick files, then download
//   node index.js --chat mychannel --type music  # only audio files
//   node index.js --chat mychannel -t music --all # download everything without picking
//
// Options:
//   --chat, -c         target chat (username, @username, t.me link, numeric id, or "me" for Saved Messages)
//   --type, -t         all | music | video | photo | document | voice   (default: all)
//   --out, -o          output directory (default: ./downloads/<chat title>)
//   --limit, -l        max number of messages to scan (default: unlimited)
//   --concurrency, -j  parallel downloads (default: 3)
//   --all, -a          download every file without showing the picker
//   --list             list dialogs and exit

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  FILTERS,
  createClient,
  saveSession,
  sanitize,
  formatBytes,
  fileInfo,
  resolveTarget,
  claimTarget,
  downloadFile,
  dialogType,
  resolveChat,
  entityTitle,
} from "./lib.js";

// ---------- helpers ----------

// One shared readline with a line buffer, so piped / fast-typed input is never lost between questions.
let rl = null;
const lines = [];
const waiters = [];
let inputClosed = false;

/** Ask a question; resolves to the trimmed answer, or null when stdin is closed. */
function ask(question) {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on("line", (line) => (waiters.length ? waiters.shift()(line) : lines.push(line)));
    rl.on("close", () => {
      inputClosed = true;
      while (waiters.length) waiters.shift()(null);
    });
  }
  process.stdout.write(question);
  if (lines.length) return Promise.resolve(lines.shift().trim());
  if (inputClosed) return Promise.resolve(null);
  return new Promise((resolve) => waiters.push((line) => resolve(line?.trim() ?? null)));
}

function closeInput() {
  rl?.close();
  rl = null;
  lines.length = 0;
  inputClosed = false;
}

// ---------- telegram ----------

async function connect() {
  let client;
  try {
    client = createClient();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  await client.start({
    phoneNumber: async () => process.env.PHONE || (await ask("Phone number (+84...): ")),
    password: async () => await ask("2FA password: "),
    phoneCode: async () => await ask("Login code sent to Telegram: "),
    onError: (err) => console.error("Login error:", err.message),
  });

  saveSession(client);
  return client;
}

async function listDialogs(client) {
  const dialogs = await client.getDialogs({});
  console.log(`${"ID".padEnd(18)} ${"TYPE".padEnd(8)} TITLE`);
  for (const d of dialogs) {
    const type = dialogType(d);
    const username = d.entity?.username ? ` (@${d.entity.username})` : "";
    console.log(`${String(d.id).padEnd(18)} ${type.padEnd(8)} ${d.title}${username}`);
  }
}

/** Parse "1,3,5-10" into a set of 1-based indexes within [1, max]. Returns null on bad input. */
function parseSelection(input, max) {
  const result = new Set();
  for (const part of input.split(/[,\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    let [a, b] = [Number(m[1]), Number(m[2] ?? m[1])];
    if (a > b) [a, b] = [b, a];
    for (let i = Math.max(1, a); i <= Math.min(max, b); i++) result.add(i);
  }
  return result;
}

/** Interactive picker: show a numbered list and let the user choose files by number, range or keyword. */
async function pickFiles(jobs, outDir) {
  const isDownloaded = ({ msg, info }) => resolveTarget(outDir, info.name, info.size, msg.id).skip;
  const show = (items) => {
    for (const { idx, job } of items) {
      const mark = isDownloaded(job) ? "✓" : " ";
      const size = job.info.size ? formatBytes(job.info.size) : "";
      console.log(`${String(idx).padStart(4)}. [${mark}] ${job.info.name}  ${size}`);
    }
  };

  const indexed = jobs.map((job, i) => ({ idx: i + 1, job }));
  show(indexed);
  console.log(`\n${jobs.length} files ([✓] = already downloaded).`);
  console.log("Select: numbers/ranges (1,3,5-10) | all | /keyword to search | ls to list again | q to quit");

  while (true) {
    const input = await ask("> ");
    if (input === null || input === "q") return [];
    if (!input) continue;
    if (input === "all") return jobs;
    if (input === "ls") {
      show(indexed);
      continue;
    }
    if (input.startsWith("/")) {
      const kw = input.slice(1).trim().toLowerCase();
      const hits = indexed.filter(({ job }) => job.info.name.toLowerCase().includes(kw));
      if (hits.length) show(hits);
      console.log(`${hits.length} match(es). Enter the numbers to download.`);
      continue;
    }

    const picked = parseSelection(input, jobs.length);
    if (!picked || !picked.size) {
      console.log("Invalid selection. Example: 1,3,5-10");
      continue;
    }
    const selected = [...picked].sort((a, b) => a - b).map((i) => jobs[i - 1]);
    console.log(`Selected ${selected.length} file(s):`);
    selected.forEach((j) => console.log(`  - ${j.info.name}`));
    const ok = (await ask("Download? (Y/n) "))?.toLowerCase();
    if (ok === null) return [];
    if (ok === "" || ok === "y") return selected;
  }
}

/** Full-screen checkbox list: arrows to move, Space to tick, type to search, Enter to confirm. */
function pickFilesTui(jobs, outDir, title, selected = new Set()) {
  const downloaded = jobs.map(({ msg, info }) => resolveTarget(outDir, info.name, info.size, msg.id).skip);
  let query = "";
  let view = jobs.map((_, i) => i);
  let cursor = 0;
  let top = 0;

  const out = process.stdout;
  const write = (str) => out.write(str);
  const fit = (str, width) => (str.length > width ? str.slice(0, Math.max(0, width - 1)) + "…" : str.padEnd(width));
  const selectedBytes = () => [...selected].reduce((sum, i) => sum + (jobs[i].info.size || 0), 0);

  const applyFilter = () => {
    const q = query.toLowerCase();
    view = jobs.map((_, i) => i).filter((i) => jobs[i].info.name.toLowerCase().includes(q));
    cursor = Math.min(cursor, Math.max(0, view.length - 1));
  };

  const render = () => {
    const cols = out.columns || 80;
    const rows = out.rows || 24;
    const pageSize = Math.max(3, rows - 7);
    if (cursor < top) top = cursor;
    if (cursor >= top + pageSize) top = cursor - pageSize + 1;

    const lines = [];
    lines.push(`\x1b[1m${fit(`${title} — ${jobs.length} files`, cols)}\x1b[0m`);
    lines.push(`\x1b[36mSearch:\x1b[0m ${query}\x1b[90m${query ? "" : " (type to filter)"}\x1b[0m`);
    lines.push("");
    for (let r = 0; r < pageSize; r++) {
      const vi = top + r;
      if (vi >= view.length) {
        lines.push(vi === 0 ? "\x1b[90m  No matches\x1b[0m" : "");
        continue;
      }
      const i = view[vi];
      const { info } = jobs[i];
      const box = selected.has(i) ? "\x1b[32m[x]\x1b[0m" : "[ ]";
      const size = info.size ? formatBytes(info.size) : "";
      const tag = downloaded[i] ? " ✓" : "  ";
      const name = fit(`${String(i + 1).padStart(4)}. ${info.name}`, Math.max(10, cols - 20));
      const row = `${vi === cursor ? "\x1b[36m❯\x1b[0m" : " "} ${box} ${name} ${size.padStart(9)}${tag}`;
      lines.push(vi === cursor ? `\x1b[7m${row}\x1b[0m` : row);
    }
    lines.push("");
    lines.push(
      `\x1b[1mSelected: ${selected.size}\x1b[0m (${formatBytes(selectedBytes())})` +
        `   \x1b[90m${view.length ? cursor + 1 : 0}/${view.length}  ✓ = downloaded\x1b[0m`
    );
    lines.push(
      "\x1b[90m↑↓ move · PgUp/PgDn · Space tick · Ctrl+A tick all shown · Ctrl+D untick all · Enter confirm · Esc clear search/quit\x1b[0m"
    );
    write("\x1b[H" + lines.map((l) => l + "\x1b[K").join("\n") + "\x1b[J");
  };

  return new Promise((resolve) => {
    const stdin = process.stdin;
    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    write("\x1b[?1049h\x1b[?25l"); // alternate screen, hide cursor

    const finish = (result) => {
      stdin.off("keypress", onKey);
      out.off("resize", render);
      stdin.setRawMode(false);
      stdin.pause();
      write("\x1b[?25h\x1b[?1049l"); // restore screen and cursor
      resolve(result);
    };

    const onKey = (str, key = {}) => {
      const page = Math.max(3, (out.rows || 24) - 7);
      if (key.ctrl && key.name === "c") return finish(null);
      switch (key.name) {
        case "up":
          cursor = Math.max(0, cursor - 1);
          break;
        case "down":
          cursor = Math.min(view.length - 1, cursor + 1);
          break;
        case "pageup":
          cursor = Math.max(0, cursor - page);
          break;
        case "pagedown":
          cursor = Math.min(view.length - 1, cursor + page);
          break;
        case "home":
          cursor = 0;
          break;
        case "end":
          cursor = view.length - 1;
          break;
        case "space":
          if (view.length) {
            const i = view[cursor];
            selected.has(i) ? selected.delete(i) : selected.add(i);
            cursor = Math.min(view.length - 1, cursor + 1);
          }
          break;
        case "return":
        case "enter":
          return finish([...selected].sort((a, b) => a - b).map((i) => jobs[i]));
        case "escape":
          if (!query) return finish(null);
          query = "";
          applyFilter();
          break;
        case "backspace":
          query = query.slice(0, -1);
          applyFilter();
          break;
        default:
          if (key.ctrl && key.name === "a") view.forEach((i) => selected.add(i));
          else if (key.ctrl && key.name === "d") selected.clear();
          else if (str && !key.ctrl && !key.meta && str >= " ") {
            query += str;
            applyFilter();
          }
      }
      cursor = Math.max(0, cursor);
      render();
    };

    stdin.on("keypress", onKey);
    out.on("resize", render);
    render();
  });
}

/** Let the user pick files, then confirm before downloading. Returns [] when cancelled. */
async function chooseFiles(jobs, outDir, title) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return pickFiles(jobs, outDir);

  closeInput(); // the full-screen list reads raw keys from stdin itself
  const ticked = new Set(); // kept across "back to list" so choices are not lost
  while (true) {
    const selected = await pickFilesTui(jobs, outDir, title, ticked);
    if (!selected) return [];
    if (!selected.length) {
      const again = await ask("No file selected. Back to the list? (Y/n) ");
      if (again === null || again.toLowerCase() === "n") return [];
      closeInput();
      continue;
    }

    const total = selected.reduce((sum, j) => sum + (j.info.size || 0), 0);
    console.log(`\nSelected ${selected.length} file(s), ${formatBytes(total)}:`);
    selected.forEach((j) => console.log(`  - ${j.info.name}`));
    const ok = await ask("\nStart download? (Y = start / n = back to list / q = quit) ");
    if (ok === null || ok.toLowerCase() === "q") return [];
    if (ok === "" || ok.toLowerCase() === "y") return selected;
    closeInput();
  }
}

async function downloadAll(client, opts) {
  const entity = await resolveChat(client, opts.chat);
  const title = entityTitle(entity);
  const outDir = path.resolve(opts.out || path.join("downloads", sanitize(title)));
  fs.mkdirSync(outDir, { recursive: true });

  const Filter = FILTERS[opts.type];
  console.log(`Chat: ${title}\nType: ${opts.type}\nOutput: ${outDir}\n`);

  const stats = { found: 0, done: 0, skipped: 0, failed: 0, bytes: 0 };
  const queue = [];
  let scanning = true;

  const scan = async (onFile) => {
    for await (const msg of client.iterMessages(entity, {
      limit: opts.limit,
      filter: Filter ? new Filter() : undefined,
    })) {
      const info = fileInfo(msg);
      if (info) onFile({ msg, info });
    }
  };

  let producer;
  if (opts.pick) {
    // Pick mode: scan everything first, let the user choose, then download the selection.
    const all = [];
    await scan((job) => {
      all.push(job);
      if (process.stdout.isTTY) process.stdout.write(`Scanning chat... ${all.length} files\r`);
    });
    console.log(`Scanning chat... ${all.length} files`);
    if (!all.length) {
      console.log("No files found.");
      return;
    }
    const selected = await chooseFiles(all, outDir, title);
    if (!selected.length) {
      console.log("Nothing selected.");
      return;
    }
    stats.found = selected.length;
    queue.push(...selected);
    scanning = false;
    producer = Promise.resolve();
  } else {
    // Producer: walk the chat history and queue messages that carry a file.
    producer = scan((job) => {
      stats.found++;
      queue.push(job);
    }).finally(() => {
      scanning = false;
    });
  }

  // Consumers: download in parallel.
  const worker = async () => {
    while (scanning || queue.length) {
      const job = queue.shift();
      if (!job) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      const { msg, info } = job;
      const { filePath, skip, release } = await claimTarget(outDir, info.name, info.size, msg.id);
      const label = path.basename(filePath);

      if (skip) {
        stats.skipped++;
        console.log(`= skip   ${label}`);
        continue;
      }

      try {
        let lastPct = -1;
        const size = await downloadFile(client, msg, filePath, (received, total) => {
          const pct = total ? Math.floor((received / total) * 100) : 0;
          if (process.stdout.isTTY && pct !== lastPct && pct % 10 === 0) {
            lastPct = pct;
            process.stdout.write(`  ... ${label} ${pct}%\r`);
          }
        });
        stats.done++;
        stats.bytes += size;
        console.log(`✓ ok     ${label} (${formatBytes(size)})`);
      } catch (err) {
        stats.failed++;
        if (err.seconds) {
          // FLOOD_WAIT: Telegram asks us to slow down; wait and retry later.
          console.warn(`! flood wait ${err.seconds}s, retrying ${label}`);
          stats.failed--;
          await new Promise((r) => setTimeout(r, err.seconds * 1000));
          queue.push(job);
        } else {
          console.error(`✗ failed ${label}: ${err.message}`);
        }
      } finally {
        release();
      }
    }
  };

  await Promise.all([producer, ...Array.from({ length: opts.concurrency }, worker)]);

  console.log(
    `\nDone. Found ${stats.found}, downloaded ${stats.done} (${formatBytes(stats.bytes)}), ` +
      `skipped ${stats.skipped}, failed ${stats.failed}.`
  );
}

// ---------- main ----------

async function main() {
  const { values } = parseArgs({
    options: {
      chat: { type: "string", short: "c" },
      type: { type: "string", short: "t", default: "all" },
      out: { type: "string", short: "o" },
      limit: { type: "string", short: "l" },
      concurrency: { type: "string", short: "j", default: "3" },
      list: { type: "boolean", default: false },
      all: { type: "boolean", short: "a", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 18).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    return;
  }
  if (!(values.type in FILTERS)) {
    console.error(`Invalid --type "${values.type}". Use one of: ${Object.keys(FILTERS).join(", ")}`);
    process.exit(1);
  }

  const client = await connect();
  try {
    if (values.list) {
      await listDialogs(client);
      return;
    }
    const chat = values.chat || (await ask("Chat (username / link / id / me): "));
    if (!chat) return;
    await downloadAll(client, {
      chat,
      type: values.type,
      out: values.out,
      limit: values.limit ? Number(values.limit) : undefined,
      concurrency: Math.max(1, Number(values.concurrency) || 3),
      pick: !values.all,
    });
  } finally {
    closeInput();
    await client.disconnect();
    await client.destroy();
  }
}

export { parseSelection };

// Run the CLI only when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
