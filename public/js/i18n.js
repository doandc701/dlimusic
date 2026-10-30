// Interface language: Vietnamese (the text written everywhere in the page and in ui.js), English,
// Simplified Chinese or Japanese. Loaded right after theme.js, before the page is parsed.
//
// The page, ui.js and the server keep writing Vietnamese. This file swaps it for the chosen language as it
// lands in the page: text nodes and the title / placeholder / aria-label / alt / tooltip attributes whose
// whole text is a known sentence (exact matches only, so song and chat names are left alone). Sentences
// with values in them go through t("… {n} …", { n }) in ui.js. What was translated remembers its
// Vietnamese, so switching back and forth works without a reload.
(() => {
  const KEY = "lang";
  // The languages: one file each in js/lang/ (loaded before this one), in the order of their <script> tags.
  // { code, name, locale, html, dict }; Vietnamese is always there, it is what everything is written in.
  const LANGS = window.TDL_LANGS || {};
  LANGS.vi ||= { code: "VI", name: "Tiếng Việt", locale: "vi-VN", html: "vi", dict: {} };
  const DICT = Object.fromEntries(Object.entries(LANGS).map(([l, v]) => [l, v.dict || {}]));
  const ATTRS = ["title", "placeholder", "aria-label", "alt", "data-bs-original-title", "data-bs-title"];
  // never translated: code, the user's own text, and anything marked translate="no" (names, the language menu)
  const SKIP = 'script, style, textarea, code, kbd, [translate="no"]';

  const norm = (s) => String(s).replace(/\s+/g, " ").trim();
  /** "{n}" -> vars.n; "{n|file|files}" -> "file" when vars.n is 1, else "files" (English plurals). */
  const fill = (s, vars) =>
    vars
      ? s.replace(/\{(\w+)(?:\|([^|}]*)\|([^}]*))?\}/g, (m, k, one, other) =>
          !(k in vars) ? m : one === undefined ? String(vars[k]) : Number(vars[k]) === 1 ? one : other,
        )
      : s;

  const saved = () => {
    try {
      const s = localStorage.getItem(KEY);
      return LANGS[s] ? s : "vi";
    } catch {
      return "vi";
    }
  };
  let lang = saved();

  // normalized Vietnamese -> translation, per language
  const maps = {};
  const mapFor = (l) => (maps[l] ||= new Map(Object.entries(DICT[l]).map(([k, v]) => [norm(k), v])));
  // a sentence of ours: known to any language's dictionary
  let keys = null;
  const isKey = (s) => (keys ||= new Set(Object.keys(DICT).flatMap((l) => [...mapFor(l).keys()]))).has(s);
  // a language's translation -> its Vietnamese, used while switching away from that language: what ui.js
  // wrote with t() goes to the new language (or back). Only then: a song called "音乐" stays "音乐".
  const reverses = {};
  const reverseFor = (l) => {
    if (!reverses[l]) {
      reverses[l] = new Map();
      for (const [k, v] of mapFor(l)) if (!/[{<]/.test(v) && !isKey(norm(v))) reverses[l].set(norm(v), k);
    }
    return reverses[l];
  };
  let switchingFrom = null; // the previous language, while the page is translated again
  // what t() filled in with values -> { vi, vars }, so it can be redrawn in another language too
  const filled = new Map();
  const remember = (out, vi, vars) => {
    filled.delete(out);
    filled.set(out, { vi, vars });
    if (filled.size > 3000) filled.delete(filled.keys().next().value); // the oldest goes
  };
  // server messages with values ("Tối đa 500 file yêu thích"), matched as a whole
  let patterns = null;
  const patternList = () =>
    (patterns ||= PATTERNS.map((vi) => {
      const names = [];
      const re = norm(vi)
        .split(/(\{\w+\})/)
        .map((part) => {
          const m = /^\{(\w+)\}$/.exec(part);
          if (!m) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          names.push(m[1]);
          return "(.+?)";
        })
        .join("");
      return { vi: norm(vi), names, re: new RegExp(`^${re}$`) };
    }));

  /** The text in the chosen language; a sentence without a translation stays Vietnamese. */
  function t(vi, vars) {
    const key = norm(vi);
    const text = lang === "vi" ? vi : (mapFor(lang).get(key) ?? vi);
    const out = fill(text, vars);
    if (vars) remember(norm(out), key, vars);
    return out;
  }

  /** What a text of the page says in Vietnamese ({ vi, vars }), or null when it is not one of ours. */
  function source(text) {
    const s = norm(text);
    if (!s || !/\p{L}/u.test(s)) return null;
    if (isKey(s)) return { vi: s };
    const vi = switchingFrom && switchingFrom !== "vi" && reverseFor(switchingFrom).get(s);
    if (vi) return { vi };
    const f = filled.get(s);
    if (f) return f;
    for (const p of patternList()) {
      const m = p.re.exec(s);
      if (m) return { vi: p.vi, vars: Object.fromEntries(p.names.map((n, i) => [n, m[i + 1]])) };
    }
    return null;
  }

  /** `text` in the chosen language, keeping its surrounding spaces; null = leave it as it is. */
  function render(text) {
    const src = source(text);
    if (!src) return null;
    const out = fill(lang === "vi" ? src.vi : (mapFor(lang).get(src.vi) ?? src.vi), src.vars);
    if (src.vars) remember(norm(out), src.vi, src.vars);
    if (norm(out) === norm(text)) return text;
    return text.match(/^\s*/)[0] + out + text.match(/\s*$/)[0];
  }

  // node / element -> { src, out }: what it said before it was translated, and what was written
  const textMemo = new WeakMap();
  const attrMemo = new WeakMap();
  const htmlMemo = new WeakMap();
  /** Translate from the remembered original while the node still shows what was written into it. */
  const update = (memo, cur, write) => {
    const src = memo && memo.out === cur ? memo.src : cur;
    const out = render(src);
    if (out === null) return null;
    if (out !== cur) write(out);
    return { src, out };
  };

  function fixText(node) {
    const m = update(textMemo.get(node), node.nodeValue, (v) => (node.nodeValue = v));
    if (m) textMemo.set(node, m);
  }

  function fixAttr(el, name) {
    const cur = el.getAttribute(name);
    if (!cur) return;
    let memo = attrMemo.get(el);
    const m = update(memo?.[name], cur, (v) => el.setAttribute(name, v));
    if (!m) return;
    if (!memo) attrMemo.set(el, (memo = {}));
    memo[name] = m;
  }

  /** data-i18n="html": a sentence with markup inside (bold words), translated as a whole. */
  function fixHtml(el) {
    const memo = htmlMemo.get(el);
    const cur = el.innerHTML;
    const src = memo && memo.out === cur ? memo.src : cur;
    const key = norm(src);
    if (!isKey(key)) return;
    const out = lang === "vi" ? src : mapFor(lang).get(key);
    if (out !== cur) el.innerHTML = out;
    htmlMemo.set(el, { src, out: el.innerHTML });
  }

  const skipped = (node) => {
    const el = node.nodeType === 1 ? node : node.parentElement;
    return !el || !!el.closest(`${SKIP}, [data-i18n] *`);
  };

  /** Translate everything under `root` (a node just added, or the whole page). */
  function walk(root) {
    if (root.nodeType === 3) return skipped(root) || fixText(root);
    if (root.nodeType !== 1 || skipped(root)) return;
    const visit = (el) => {
      for (const a of ATTRS) if (el.hasAttribute(a)) fixAttr(el, a);
      if (el.hasAttribute("data-i18n")) fixHtml(el);
    };
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.nodeType === 3
          ? NodeFilter.FILTER_ACCEPT
          : n.matches(SKIP)
            ? NodeFilter.FILTER_REJECT
            : n.hasAttribute("data-i18n")
              ? (visit(n), NodeFilter.FILTER_REJECT) // translated as a whole, not word by word
              : NodeFilter.FILTER_ACCEPT,
    });
    visit(root);
    if (root.hasAttribute("data-i18n")) return;
    for (let n = tw.nextNode(); n; n = tw.nextNode()) n.nodeType === 3 ? fixText(n) : visit(n);
  }

  // Whatever lands in the page later (parsed markup, ui.js redraws, server messages) is translated before it
  // is painted: mutation records are handled before the browser renders the next frame.
  const observer = new MutationObserver((records) => {
    if (lang === "vi") return;
    for (const r of records) {
      if (r.type === "childList") r.addedNodes.forEach((n) => n.isConnected && walk(n));
      else if (!r.target.isConnected || skipped(r.target)) continue;
      else if (r.type === "characterData") fixText(r.target);
      else fixAttr(r.target, r.attributeName);
    }
    observer.takeRecords(); // the changes just made here: nothing more to translate
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ATTRS,
  });

  const TITLE = document.title;
  const listeners = [];
  /** Show the page in `lang` (it was in `prev`); then ui.js redraws what it built. */
  function apply(prev) {
    document.documentElement.lang = LANGS[lang].html || lang;
    document.title = t(TITLE);
    switchingFrom = prev;
    if (document.body) walk(document.body);
    switchingFrom = null;
    observer.takeRecords();
    for (const fn of listeners) fn(lang);
  }

  // templates with values that only the server writes: recognised in the page with the values filled in
  const PATTERNS = [
    "Telegram yêu cầu chờ {n}s",
    "Tối đa {n} bài yêu thích",
    "Thư mục không tồn tại: {path}",
    "Không phải thư mục: {path}",
    "Không có quyền ghi vào thư mục: {path}",
    "Bạn thử quá nhiều lần. Telegram yêu cầu đợi {n} giờ rồi thử lại.",
    "Bạn thử quá nhiều lần. Telegram yêu cầu đợi {n} phút rồi thử lại.",
    "Bạn thử quá nhiều lần. Telegram yêu cầu đợi {n} giây rồi thử lại.",
    "Telegram từ chối đăng nhập ({code}). Vui lòng thử lại.",
    "Tối đa {n} link chia sẻ cùng lúc, hãy thu hồi bớt",
    "Link đã đạt thời hạn tối đa {n} ngày, hãy tạo link mới",
  ];

  // Another tab of the app changed the language.
  addEventListener("storage", (e) => {
    if ((e.key !== KEY && e.key !== null) || saved() === lang) return;
    const prev = lang;
    lang = saved();
    apply(prev);
  });

  window.tdlI18n = {
    LANGS,
    DICT,
    PATTERNS,
    get lang() {
      return lang;
    },
    get locale() {
      return LANGS[lang].locale;
    },
    t,
    setLang(next) {
      if (!LANGS[next] || next === lang) return;
      const prev = lang;
      lang = next;
      try {
        if (lang === "vi") localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, lang);
      } catch {}
      apply(prev);
    },
    /** fn(lang) after the language changed (ui.js redraws what it built). */
    onChange(fn) {
      listeners.push(fn);
    },
  };
  window.t = t;
  if (lang !== "vi") apply("vi");
})();
