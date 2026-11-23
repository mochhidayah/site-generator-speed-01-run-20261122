// sitegen — a fast drop-in for make.fun's makefun-site 1.0.0.
//
// run(input) returns exactly the output tree makefun-site's build returns for
// the same input: every page, index, tag page, static file and build-report,
// byte for byte. It is written from the makefun-site README's rules, not by
// reusing makefun-site's code: one file, no dependencies, no I/O, no clock,
// no randomness. The speed comes from doing the same work with less of it —
// a single pass over each body instead of lex-then-render, a hand-rolled
// escaper that skips strings with nothing to escape, an ASCII fast path for
// slugs, and a template interpreter that renders straight into a chunk list.

/** An error that refuses one source or one template, carrying its report line. */
class Refuse extends Error {}

/** Code-unit order, never the locale's. */
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** The days of month m (1-12) of year y, by the Gregorian rule. */
function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return DAYS_IN_MONTH[m - 1];
}

/** The characters a backslash escapes in inline Markdown, as a lookup table. */
const ESCAPABLE = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE[ch.charCodeAt(0)] = 1;

function isEscapable(code) {
  return code < 128 && ESCAPABLE[code] === 1;
}

/** Whether a code unit is JavaScript whitespace (\s). */
function isWs(code) {
  return (
    code === 32 || (code >= 9 && code <= 13) || code === 160 || code === 5760 ||
    (code >= 8192 && code <= 8202) || code === 8232 || code === 8233 ||
    code === 8239 || code === 8287 || code === 12288 || code === 65279
  );
}

/** `text` with & < > " and ' escaped; a string with none of them comes back itself. */
function escText(text) {
  if (!/[&<>"']/.test(text)) return text;
  let out = '';
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    else continue;
    out += text.slice(last, i) + rep;
    last = i + 1;
  }
  return out + text.slice(last);
}

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), "untitled" when nothing is left.
 * Plain ASCII text never needs the normaliser, so it takes the short path.
 */
function slugFrom(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  const plain = ascii ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = 0;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === 0) {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  if (out.length > 64) out = out.slice(0, 64);
  while (out.endsWith('-')) out = out.slice(0, -1);
  return out === '' ? 'untitled' : out;
}

/** `base` made unique against `taken` (and added to it): base, base-2, base-3 ... */
function slugUniq(base, taken) {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  let n = 2;
  let cand = `${base}-2`;
  while (taken.has(cand)) {
    n++;
    cand = `${base}-${n}`;
  }
  taken.add(cand);
  return cand;
}

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longForm(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** The words of a body: its runs of characters other than whitespace. The
 * common case — an ASCII word character — takes two comparisons. */
function countWords(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13)) {
      inWord = false;
      continue;
    }
    if (c < 127) {
      if (!inWord) {
        n++;
        inWord = true;
      }
      continue;
    }
    if (
      c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 ||
      c === 8239 || c === 8287 || c === 12288 || c === 65279
    ) {
      inWord = false;
      continue;
    }
    if (!inWord) {
      n++;
      inWord = true;
    }
  }
  return n;
}

/** Whether `s` holds any whitespace character. */
function hasWs(s) {
  for (let k = 0; k < s.length; k++) if (isWs(s.charCodeAt(k))) return true;
  return false;
}

/** `path`'s directory: everything before its last "/", or "" at the root. */
function dirOfPath(path) {
  const at = path.lastIndexOf('/');
  return at === -1 ? '' : path.slice(0, at);
}

// --------------------------------------------------------------- front matter

const HEAD_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** A quoted or bare string value: a quoted one unescaped, a bare one as written. */
function headString(key, raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) {
      throw new Refuse(`key "${key}": a quoted string is not closed`);
    }
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === raw.length - 1) {
          throw new Refuse(`key "${key}": a quoted string holds an escape other than \\" or \\`);
        }
        out += nx;
        i++;
      } else if (c === '"') {
        throw new Refuse(`key "${key}": a quoted string holds a stray quote`);
      } else out += c;
    }
    return out;
  }
  if (raw.charCodeAt(0) === 91) throw new Refuse(`key "${key}": a bare string opens on [`);
  return raw;
}

/** A date value: YYYY-MM-DD, a real day from 1970-01-01 to 2099-12-31. */
function headDate(raw) {
  let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
  if (ok) {
    for (let i = 0; i < 10; i++) {
      if (i === 4 || i === 7) continue;
      const c = raw.charCodeAt(i);
      if (c < 48 || c > 57) {
        ok = false;
        break;
      }
    }
  }
  const y = ok ? Number(raw.slice(0, 4)) : 0;
  const mo = ok ? Number(raw.slice(5, 7)) : 0;
  const d = ok ? Number(raw.slice(8, 10)) : 0;
  if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) {
    throw new Refuse('key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)');
  }
  return raw;
}

/** A tags value: [a, b, c], each name trimmed, none empty or holding " [ or ]. */
function headTags(raw) {
  if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
    throw new Refuse('key "tags": not a list [a, b]');
  }
  const inner = raw.slice(1, -1);
  if (inner.trim() === '') return [];
  const tags = [];
  for (const part of inner.split(',')) {
    const t = part.trim();
    let bad = t === '';
    if (!bad) {
      for (let i = 0; i < t.length; i++) {
        const c = t[i];
        if (c === '"' || c === '[' || c === ']') {
          bad = true;
          break;
        }
      }
    }
    if (bad) throw new Refuse('key "tags": an empty tag, or one holding " [ or ]');
    tags.push(t);
  }
  return tags;
}

/** Whether `raw` is a template name (a-z, 0-9 and "-"). */
function isTplName(raw) {
  if (raw.length === 0) return false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** Whether `raw` is a slug (a-z and 0-9, single "-" between). */
function isSlug(raw) {
  if (raw.length === 0) return false;
  let prevDash = true;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 45) {
      if (prevDash) return false;
      prevDash = true;
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
    else return false;
  }
  return !prevDash;
}

/** One key's value, or the reason it is refused. */
function headValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary':
      return headString(key, raw);
    case 'date':
      return headDate(raw);
    case 'tags':
      return headTags(raw);
    case 'draft':
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      throw new Refuse('key "draft": true or false');
    case 'layout':
      if (isTplName(raw)) return raw;
      throw new Refuse('key "layout": not a template name');
    case 'slug':
      if (isSlug(raw) && raw.length <= 64) return raw;
      throw new Refuse('key "slug": not a slug');
    default:
      throw new Refuse(`unknown key "${key}"`);
  }
}

/**
 * One front-matter line: null when it is blank, a comment or a good key, else
 * the reason the source is refused. `n` counts from 1 at the opening "---".
 */
function headLine(data, line, n) {
  let j = 0;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  if (j === line.length) return null;
  if (line.charCodeAt(0) === 35) return null;
  let k = 0;
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if ((c >= 97 && c <= 122) || c === 95) k++;
    else break;
  }
  if (k === 0 || line.charCodeAt(k) !== 58) return `line ${n} is not "key: value"`;
  const key = line.slice(0, k);
  let raw;
  if (k + 1 === line.length) raw = '';
  else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
  else return `line ${n} is not "key: value"`;
  let rEnd = raw.length;
  while (rEnd > 0) {
    const c = raw.charCodeAt(rEnd - 1);
    if (c === 32 || c === 9) rEnd--;
    else break;
  }
  raw = raw.slice(0, rEnd);
  if (!HEAD_KEYS.has(key)) return `unknown key "${key}"`;
  if (Object.hasOwn(data, key)) return `key "${key}" is given twice`;
  if (raw === '') return `key "${key}" has no value`;
  try {
    data[key] = headValue(key, raw);
  } catch (err) {
    if (err instanceof Refuse) return err.message;
    throw err;
  }
  return null;
}

/**
 * A source's front matter and body: { data, body }, or { err } with the first
 * reason it is refused.
 */
function readHead(text) {
  let e = text.indexOf('\n');
  const first = e === -1 ? text : text.slice(0, e);
  if (first !== '---') return { err: 'no front matter' };
  const data = {};
  let i = e === -1 ? text.length : e + 1;
  let n = 2;
  let bodyStart = -1;
  for (;;) {
    if (i > text.length) break;
    e = text.indexOf('\n', i);
    const end = e === -1 ? text.length : e;
    const line = text.slice(i, end);
    if (line === '---') {
      bodyStart = end + 1;
      break;
    }
    const bad = headLine(data, line, n);
    if (bad !== null) return { err: bad };
    if (e === -1) break;
    i = end + 1;
    n++;
  }
  if (bodyStart === -1) return { err: 'the front matter is not closed' };
  if (!Object.hasOwn(data, 'title')) return { err: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ------------------------------------------------------------------ Markdown

/** Whether a line is blank (spaces and tabs only). */
function isBlankLine(line) {
  for (let k = 0; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A line with its spaces and tabs at either end dropped. */
function trimST(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** A fence's language when the line opens one, else null. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  const lang = line.slice(3, j);
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  return j === line.length ? lang : null;
}

/** Whether the line closes a fence: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  let j = 3;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  return j === line.length;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) === 35 && j < 6) j++;
  if (j === 0) return null;
  let k = j;
  while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
  if (k === j) return null;
  let b = line.length;
  while (b > k && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  const text = line.slice(k, b);
  if (text === '') return null;
  return { depth: j, text };
}

/** Whether the line is a thematic break: --- or ***, then spaces or tabs only. */
function isHr(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  let j = 3;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  return j === line.length;
}

/**
 * A list's opening when the line starts one: { ordered, start, text }, or null.
 * A bullet list takes "- " or "* "; an ordered one takes digits and ". ".
 */
function listOpen(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) {
    return { ordered: false, start: 1, text: line.slice(2) };
  }
  if (c0 >= 48 && c0 <= 57) {
    let j = 0;
    while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
    if (j >= 1 && j <= 9 && line.charCodeAt(j) === 46 && line.charCodeAt(j + 1) === 32) {
      return { ordered: true, start: Number(line.slice(0, j)), text: line.slice(j + 2) };
    }
  }
  return null;
}

/** Whether the line continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  if (j < 2 || j >= line.length) return false;
  return !isWs(line.charCodeAt(j));
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a break. */
function endsPara(line) {
  if (line.length === 0) return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlankLine(line);
  if (c0 === 96) return fenceOpen(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHr(line);
  return false;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnesc(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** The characters that change inline rendering, as one native scan. A plain run
 * between two of them holds nothing to escape, so it is copied as it is. */
const INLINE_NEEDLE = /[\\`*\[&<>"']/g;

/**
 * `s` rendered inline; `link(target)` is a link's href. The native scan finds
 * the next character that matters; everything between two of them is plain
 * text, copied whole. (The one shared scan is re-entered by the recursion
 * below, so every branch sets its lastIndex again after the recursive call.)
 */
function inlineStr(s, link) {
  const chunks = [];
  let plain = 0;
  let touched = false;
  INLINE_NEEDLE.lastIndex = 0;
  let m;
  while ((m = INLINE_NEEDLE.exec(s)) !== null) {
    const i = m.index;
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < s.length && isEscapable(s.charCodeAt(i + 1))) {
        if (i > plain) chunks.push(s.slice(plain, i));
        chunks.push(s[i + 1]);
        plain = i + 2;
        touched = true;
        INLINE_NEEDLE.lastIndex = i + 2;
      } else {
        INLINE_NEEDLE.lastIndex = i + 1;
      }
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > plain) chunks.push(s.slice(plain, i));
        chunks.push(`<code>${escText(s.slice(i + 1, j))}</code>`);
        plain = j + 1;
        touched = true;
        INLINE_NEEDLE.lastIndex = j + 1;
      } else {
        INLINE_NEEDLE.lastIndex = i + 1;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnesc(s, '**', i + 2);
        if (j > i + 2) {
          if (i > plain) chunks.push(s.slice(plain, i));
          chunks.push(`<strong>${inlineStr(s.slice(i + 2, j), link)}</strong>`);
          plain = j + 2;
          touched = true;
          INLINE_NEEDLE.lastIndex = j + 2;
        } else {
          INLINE_NEEDLE.lastIndex = i + 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > plain) chunks.push(s.slice(plain, i));
        chunks.push(`<em>${inlineStr(s.slice(i + 1, j), link)}</em>`);
        plain = j + 1;
        touched = true;
        INLINE_NEEDLE.lastIndex = j + 1;
      } else {
        INLINE_NEEDLE.lastIndex = i + 1;
      }
      continue;
    }
    if (c === 91) {
      const k = findUnesc(s, ']', i + 1);
      let m2 = -1;
      let target = '';
      if (k !== -1 && s.charCodeAt(k + 1) === 40) {
        m2 = s.indexOf(')', k + 2);
        if (m2 !== -1) target = s.slice(k + 2, m2);
      }
      if (m2 !== -1 && target !== '' && !hasWs(target)) {
        if (i > plain) chunks.push(s.slice(plain, i));
        chunks.push(`<a href="${escText(link(target))}">${inlineStr(s.slice(i + 1, k), link)}</a>`);
        plain = m2 + 1;
        touched = true;
        INLINE_NEEDLE.lastIndex = m2 + 1;
      } else {
        INLINE_NEEDLE.lastIndex = i + 1;
      }
      continue;
    }
    if (i > plain) chunks.push(s.slice(plain, i));
    chunks.push(c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;');
    plain = i + 1;
    touched = true;
    INLINE_NEEDLE.lastIndex = i + 1;
  }
  if (!touched) return s;
  if (s.length > plain) chunks.push(s.slice(plain));
  return chunks.join('');
}

/**
 * `src` rendered in one pass: its HTML (each block on its own lines, a "\n"
 * after the last), its table of contents (every level 2 and 3 heading: level,
 * id and its inline HTML) and its excerpt (the first paragraph's inline HTML,
 * or ""). `link(target)` resolves a link's href.
 */
function renderBody(src, link) {
  const chunks = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  let i = 0;
  const N = src.length;
  const lineEnd = (p) => {
    const e = src.indexOf('\n', p);
    return e === -1 ? N : e;
  };
  while (i < N) {
    let e = lineEnd(i);
    let line = src.slice(i, e);
    // Most lines are paragraph text, so the first character alone decides
    // which block can start here; only that block's test runs.
    const c0 = line.charCodeAt(0);
    if (line.length === 0 || c0 === 32 || c0 === 9) {
      if (isBlankLine(line)) {
        i = e + 1;
        continue;
      }
    } else if (c0 === 96) {
      const lang = fenceOpen(line);
      if (lang !== null) {
        const cls = lang === '' ? '' : ` class="language-${escText(lang)}"`;
        chunks.push(`<pre><code${cls}>`);
        i = e + 1;
        while (i < N) {
          e = lineEnd(i);
          line = src.slice(i, e);
          if (isFenceClose(line)) {
            i = e + 1;
            break;
          }
          chunks.push(escText(line));
          chunks.push('\n');
          i = e + 1;
        }
        chunks.push('</code></pre>\n');
        continue;
      }
    } else if (c0 === 35) {
      const hd = headingOf(line);
      if (hd !== null) {
        const id = slugUniq(slugFrom(hd.text), ids);
        const html = inlineStr(hd.text, link);
        chunks.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>\n`);
        if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
        i = e + 1;
        continue;
      }
    } else if (c0 === 45 || c0 === 42 || (c0 >= 48 && c0 <= 57)) {
      if ((c0 === 45 || c0 === 42) && isHr(line)) {
        chunks.push('<hr>\n');
        i = e + 1;
        continue;
      }
      const open = listOpen(line);
      if (open !== null) {
        const items = [];
        let cur = null;
        while (i < N) {
          e = lineEnd(i);
          line = src.slice(i, e);
          const m = listOpen(line);
          if (m !== null && m.ordered === open.ordered) {
            cur = [trimST(m.text)];
            items.push(cur);
            i = e + 1;
          } else if (cur !== null && isContinued(line)) {
            cur.push(trimST(line));
            i = e + 1;
          } else break;
        }
        const tag = open.ordered ? 'ol' : 'ul';
        const openTag = open.ordered && open.start !== 1 ? `<ol start="${open.start}">` : `<${tag}>`;
        chunks.push(`${openTag}\n`);
        for (const parts of items) chunks.push(`<li>${inlineStr(parts.join('\n'), link)}</li>\n`);
        chunks.push(`</${tag}>\n`);
        continue;
      }
    } else if (c0 === 62) {
      const parts = [];
      for (;;) {
        const body = line.charCodeAt(1) === 32 ? line.slice(2) : line.slice(1);
        parts.push(body);
        i = e + 1;
        if (i >= N) break;
        e = lineEnd(i);
        line = src.slice(i, e);
        if (line.charCodeAt(0) !== 62) break;
      }
      const inner = [];
      for (const p of parts) {
        const t = trimST(p);
        if (t !== '') inner.push(t);
      }
      if (inner.length === 0) chunks.push('<blockquote>\n</blockquote>\n');
      else chunks.push(`<blockquote>\n<p>${inlineStr(inner.join('\n'), link)}</p>\n</blockquote>\n`);
      continue;
    }
    const parts = [trimST(line)];
    i = e + 1;
    while (i < N) {
      e = lineEnd(i);
      line = src.slice(i, e);
      if (endsPara(line)) break;
      parts.push(trimST(line));
      i = e + 1;
    }
    const html = inlineStr(parts.join('\n'), link);
    if (excerpt === null) excerpt = html;
    chunks.push(`<p>${html}</p>\n`);
  }
  return { html: chunks.join(''), toc, excerpt: excerpt ?? '' };
}

// ----------------------------------------------------------------- Templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/** A template that does not parse: its name and why. */
class TplFail extends Error {}

/** The path `text` names, split at its dots, or a TplFail. */
function pathParts(name, text) {
  const parts = text.split('.');
  for (const p of parts) {
    if (p.length === 0) throw new TplFail(`template "${name}": ${JSON.stringify(text)} is not a path`);
    const c0 = p.charCodeAt(0);
    if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122) || c0 === 95)) {
      throw new TplFail(`template "${name}": ${JSON.stringify(text)} is not a path`);
    }
    for (let k = 1; k < p.length; k++) {
      const c = p.charCodeAt(k);
      if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95)) {
        throw new TplFail(`template "${name}": ${JSON.stringify(text)} is not a path`);
      }
    }
  }
  return parts;
}

/** Whether `src[a..b)` holds spaces and tabs only. */
function onlySpaces(src, a, b) {
  for (let k = a; k < b; k++) {
    const c = src.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/**
 * `src`'s tokens: text, {{ }} / {{{ }}} and {% %}, a standalone tag's line
 * taken with it.
 */
function tokenizeTpl(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TplFail(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathParts(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TplFail(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = onlySpaces(src, lineStart, open) && onlySpaces(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

// Node kinds: 0 text, 1 var (escaped), 2 raw, 3 if, 4 for, 5 include.
//   text:    [0, string]
//   var/raw: [1|2, parts]
//   if:      [3, not, parts, then, else|null]
//   for:     [4, name, parts, body]
//   include: [5, name]

/** `src` parsed into its tree of nodes (a TplFail when it does not parse). */
function parseTpl(name, src) {
  const root = [];
  const stack = [{ kind: 'root', body: root }];
  let body = root;
  for (const tok of tokenizeTpl(name, src)) {
    if (tok.t === 'text') body.push([0, tok.text]);
    else if (tok.t === 'var' || tok.t === 'raw') body.push([tok.t === 'var' ? 1 : 2, tok.path]);
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = [4, m[1], pathParts(name, m[2]), []];
        body.push(node);
        stack.push({ kind: 'for', body: node[3] });
        body = node[3];
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = [3, m[1] !== undefined, pathParts(name, m[2]), [], null];
        body.push(node);
        stack.push({ kind: 'if', node, body: node[3] });
        body = node[3];
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.node[4] !== null) {
          throw new TplFail(`template "${name}": an else outside an if`);
        }
        top.node[4] = [];
        top.body = top.node[4];
        body = top.node[4];
      } else if (tag === 'endfor' || tag === 'endif') {
        const want = tag === 'endfor' ? 'for' : 'if';
        if (top.kind !== want) {
          throw new TplFail(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        }
        stack.pop();
        body = stack[stack.length - 1].body;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push([5, m[1]]);
      else throw new TplFail(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TplFail(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(frames, root, parts) {
  let v;
  if (frames.length === 0) {
    if (!Object.hasOwn(root, parts[0])) return undefined;
    v = root[parts[0]];
  } else {
    let found = false;
    for (let f = frames.length - 1; f >= 0; f--) {
      if (Object.hasOwn(frames[f], parts[0])) {
        v = frames[f][parts[0]];
        found = true;
        break;
      }
    }
    if (!found) {
      if (!Object.hasOwn(root, parts[0])) return undefined;
      v = root[parts[0]];
    }
  }
  for (let k = 1; k < parts.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, parts[k])) return undefined;
    v = v[parts[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function valText(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let k = 0; k < v.length; k++) {
      if (k !== 0) s += ', ';
      s += valText(v[k]);
    }
    return s;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function valTrue(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `out`, in the scope chain `frames` over `root`.
 * `tpls` holds the parsed templates, `depth` the include depth.
 */
function renderTpl(nodes, frames, root, tpls, depth, out) {
  for (const n of nodes) {
    const k = n[0];
    if (k === 0) out.push(n[1]);
    else if (k === 1) {
      const v = lookup(frames, root, n[1]);
      if (typeof v === 'string') out.push(escText(v));
      else if (typeof v === 'number' || typeof v === 'boolean') out.push(valText(v));
      else if (Array.isArray(v)) out.push(escText(valText(v)));
      else out.push('');
    } else if (k === 2) out.push(valText(lookup(frames, root, n[1])));
    else if (k === 3) {
      const branch = valTrue(lookup(frames, root, n[2])) !== n[1] ? n[3] : n[4];
      if (branch !== null) renderTpl(branch, frames, root, tpls, depth, out);
    } else if (k === 4) {
      const xs = lookup(frames, root, n[2]);
      if (Array.isArray(xs)) {
        const len = xs.length;
        for (let idx = 0; idx < len; idx++) {
          const frame = { [n[1]]: xs[idx], loop: { index: idx + 1, first: idx === 0, last: idx === len - 1, length: len } };
          frames.push(frame);
          renderTpl(n[3], frames, root, tpls, depth, out);
          frames.pop();
        }
      }
    } else {
      const t = tpls.get(n[1]);
      if (t !== undefined && depth < INCLUDE_DEPTH) renderTpl(t, frames, root, tpls, depth + 1, out);
    }
  }
}

// ------------------------------------------------------- template codegen
//
// A parsed template also compiles to a plain function: the same nodes, but as
// JavaScript the engine runs straight — native loops for `for`, native `if`,
// and a loop variable read straight off its local instead of through a scope
// walk. Every generated name starts with "$", which no template path can
// hold, so a template's own names can never collide with one. The compiled
// form is only an accelerator: where `new Function` is unavailable the
// interpreter above renders instead, with the same answer.

/** First-segment lookup for generated code: the nearest frame holding `name`, else the root's own property. */
function gv(F, V, name) {
  for (let f = F.length - 1; f >= 0; f--) {
    if (Object.hasOwn(F[f], name)) return F[f][name];
  }
  if (Object.hasOwn(V, name)) return V[name];
  return undefined;
}

/** One descent step for generated code: an own property of an object, else undefined. */
function gp(v, key) {
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, key)) return undefined;
  return v[key];
}

/** The JavaScript expression for the value at `parts`, with `bound` the loop
 * names in scope (innermost last), each with its local. */
function valExpr(parts, bound) {
  const first = parts[0];
  let expr = null;
  for (let b = bound.length - 1; b >= 0; b--) {
    if (bound[b].name === first) {
      expr = bound[b].local;
      break;
    }
  }
  if (expr === null) expr = `$gv($F,$V,${JSON.stringify(first)})`;
  for (let k = 1; k < parts.length; k++) expr = `$gp(${expr},${JSON.stringify(parts[k])})`;
  return expr;
}

/** `nodes` written as JavaScript into `code`, with `bound` the loop names in scope. */
function genTpl(nodes, code, bound, ctr) {
  for (const n of nodes) {
    const k = n[0];
    if (k === 0) code.push(`$O.push(${JSON.stringify(n[1])});`);
    else if (k === 1) code.push(`$O.push($E($tx(${valExpr(n[1], bound)})));`);
    else if (k === 2) code.push(`$O.push($tx(${valExpr(n[1], bound)}));`);
    else if (k === 3) {
      const not = n[1] ? 'true' : 'false';
      code.push(`if($tr(${valExpr(n[2], bound)})!==${not}){`);
      genTpl(n[3], code, bound, ctr);
      code.push('}');
      if (n[4] !== null) {
        code.push('else{');
        genTpl(n[4], code, bound, ctr);
        code.push('}');
      }
    } else if (k === 4) {
      const id = ctr.n++;
      const xs = `$x${id}`;
      const nn = `$n${id}`;
      const kk = `$k${id}`;
      const el = `$e${id}`;
      const lp = `$l${id}`;
      const fr = `$f${id}`;
      code.push(`{const ${xs}=${valExpr(n[2], bound)};if(Array.isArray(${xs})){const ${nn}=${xs}.length;for(let ${kk}=0;${kk}<${nn};${kk}++){const ${el}=${xs}[${kk}];const ${lp}={index:${kk}+1,first:${kk}===0,last:${kk}===${nn}-1,length:${nn}};const ${fr}={[${JSON.stringify(n[1])}]:${el},loop:${lp}};$F.push(${fr});`);
      bound.push({ name: n[1], local: el }, { name: 'loop', local: lp });
      genTpl(n[3], code, bound, ctr);
      bound.pop();
      bound.pop();
      code.push(`$F.pop();}}}`);
    } else {
      const id = ctr.n++;
      code.push(`if($D<${INCLUDE_DEPTH}){const $g${id}=$T.get(${JSON.stringify(n[1])});if($g${id}!==undefined)$g${id}($V,$F,$T,$E,$D+1,$O,$gv,$gp,$tx,$tr);}`);
    }
  }
}

/** `nodes` compiled to a function ($V root, $F frames, $T templates, $E escape, $D depth, $O out). */
function compileTpl(nodes) {
  const code = [];
  genTpl(nodes, code, [], { n: 0 });
  return new Function('$V', '$F', '$T', '$E', '$D', '$O', '$gv', '$gp', '$tx', '$tr', code.join(''));
}

// --------------------------------------------------------------------- build

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolveRel(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Whether `target` carries a scheme (https:, mailto: ...). */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let k = 1; k < target.length; k++) {
    const c = target.charCodeAt(k);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** A post's link record as templates read it. */
function linkFor(s) {
  if (s === null) return null;
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longForm(s.data.date),
  };
}

/**
 * A post's card, as lists show it. The reading minutes and the tag links are
 * worked out once per source (see run) and read back here: a card is built
 * twice for every post, once for the lists and once for its own page.
 */
function cardFor(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longForm(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.readMin,
    tags: s.tagLinks,
  };
}

/** A page as its layout reads it: `baseCard` is the card already built for it. */
function pageFor(s, baseCard) {
  const pg = { ...baseCard };
  pg.slug = s.slug;
  pg.content = s.html;
  pg.toc = s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html }));
  pg.newer = linkFor(s.newer ?? null);
  pg.older = linkFor(s.older ?? null);
  pg.is_post = s.post;
  return pg;
}

/** One site's output tree: path -> text. */
export function run(input) {
  const site = input.site;
  const base = site.base_url.replace(/\/+$/, '');

  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(cmp)) {
    try {
      templates.set(name, parseTpl(name, input.templates[name]));
    } catch (err) {
      if (err instanceof TplFail) report.push(err.message);
      else throw err;
    }
  }
  // The compiled form of every template, or null where it cannot be built.
  let compiled = null;
  try {
    compiled = new Map();
    for (const [name, nodes] of templates) compiled.set(name, compileTpl(nodes));
  } catch {
    compiled = null;
  }

  const files = [...input.files].sort((a, b) => cmp(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push(f);
  }

  const kept = [];
  for (const s of sources) {
    const fm = readHead(s.text);
    if (fm.err !== undefined) {
      report.push(`refused ${s.path}: ${fm.err}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : null;
    if (own !== null) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  const bySource = new Map();
  const takenByDir = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOfPath(s.path);
    let taken = takenByDir.get(dir);
    if (taken === undefined) {
      taken = new Set(dir === '' ? ['posts', 'tags', 'page'] : []);
      takenByDir.set(dir, taken);
    }
    const slug = slugUniq(s.data.slug !== undefined ? s.data.slug : slugFrom(s.data.title), taken);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOfPath(s.path);
    const link = (target) => {
      if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolveRel(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderBody(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    const seen = new Set();
    for (const name of p.data.tags ?? []) {
      const slug = slugFrom(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      let t = bySlug.get(slug);
      if (t === undefined) {
        t = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, t);
      }
      t.posts.push(p);
      p.tagRefs.push(t);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = [];
    const seen = new Set();
    for (const name of s.data.tags ?? []) {
      const slug = slugFrom(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      s.tagRefs.push(bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));

  // Once per source: its reading minutes and its tag links, read back by cardFor.
  for (const s of kept) {
    s.readMin = Math.max(1, Math.ceil(countWords(s.body) / 200));
    s.tagLinks = s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url }));
  }

  const output = {};
  const cards = new Map();
  for (const p of posts) cards.set(p, cardFor(p));
  const siteCtx = { title: site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, site.recent).map((p) => cards.get(p));
  // One root scope per render kind, reused: only its page/posts/pager/tag changes.
  const rootPage = { site: siteCtx, tags: allTags, recent };
  const rootIndex = { site: siteCtx, tags: allTags, recent };
  const rootTag = { site: siteCtx, tags: allTags, recent };
  const rootTags = { site: siteCtx, tags: allTags, recent };
  const render = (name, root) => {
    const out = [];
    if (compiled !== null) {
      const fn = compiled.get(name);
      if (fn === undefined) return null;
      fn(root, [], compiled, escText, 0, out, gv, gp, valText, valTrue);
    } else {
      const nodes = templates.get(name);
      if (nodes === undefined) return null;
      renderTpl(nodes, [], root, templates, 0, out);
    }
    return out.join('');
  };
  for (const s of kept) {
    rootPage.page = pageFor(s, s.post ? cards.get(s) : cardFor(s));
    output[`${s.outDir}/index.html`] = render(s.layout, rootPage);
  }
  const per = site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    rootIndex.posts = posts.slice((k - 1) * per, k * per).map((p) => cards.get(p));
    rootIndex.pager = { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) };
    const html = render('index', rootIndex);
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    rootTag.tag = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) };
    const html = render('tag', rootTag);
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', rootTags);
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  const lines = [...report, ...broken].sort(cmp);
  const npages = kept.filter((s) => !s.post).length;
  lines.push(`built ${npages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
