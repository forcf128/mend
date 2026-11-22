// mend — one patch tool for every AI edit format.
//
// mend reads a patch written by an AI model — a unified diff, SEARCH/REPLACE
// blocks, a V4A patch, or JSON edits — and applies it to a tree of text
// files, exactly as SPEC.md says. Every file is changed or nothing is: a
// failed edit changes nothing, the edits after it still run, and when any
// edit failed no file is written at all.
//
// Written from scratch for this entry, from SPEC.md alone. Node 22, the
// standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): that
// hand-over and runner.ts stay as the kit has them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------- errors

// A parse failure: exit 2 with `error: parse <line>`.
class ParseFault extends Error {
  readonly lineNo: number;
  constructor(lineNo: number) {
    super(`error: parse ${lineNo}`);
    this.lineNo = lineNo;
  }
}

// A failed edit: exit 1 with `error: <code> <path>`.
class EditFault extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`error: ${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

// ---------------------------------------------------------------- small helpers

const isBlankLine = (s: string): boolean => s.trim() === '';

// A patch's lines (SPEC section 3): split at \n, one trailing \r removed,
// no empty piece after a final \n.
function splitPatchText(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].endsWith('\r')) parts[i] = parts[i].slice(0, -1);
  }
  return parts;
}

// A path is safe (SPEC section 3) when it is not empty, does not start with
// /, holds no \, and none of its /-separated segments is empty, . or ...
function pathIsSafe(p: string): boolean {
  if (p === '') return false;
  if (p[0] === '/') return false;
  if (p.indexOf('\\') >= 0) return false;
  const segs = p.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') return false;
  }
  return true;
}

function stripTrailingWs(s: string): string {
  let e = s.length;
  while (e > 0 && (s[e - 1] === ' ' || s[e - 1] === '\t')) e -= 1;
  return s.slice(0, e);
}

function stripBothWs(s: string): string {
  let b = 0;
  let e = s.length;
  while (b < e && (s[b] === ' ' || s[b] === '\t')) b += 1;
  while (e > b && (s[e - 1] === ' ' || s[e - 1] === '\t')) e -= 1;
  return s.slice(b, e);
}

function leadingWs(s: string): string {
  let b = 0;
  while (b < s.length && (s[b] === ' ' || s[b] === '\t')) b += 1;
  return s.slice(0, b);
}

function onlyWs(s: string): boolean {
  if (s === '') return false;
  for (const ch of s) {
    if (ch !== ' ' && ch !== '\t') return false;
  }
  return true;
}

// ---------------------------------------------------------------- files

type Eol = '\n' | '\r\n';

// A file as lines, with its own line break and whether it ends with one.
interface Doc {
  lines: string[];
  eol: Eol;
  finalBreak: boolean;
}

function docFromText(text: string): Doc {
  if (text === '') return { lines: [], eol: '\n', finalBreak: false };
  const firstNl = text.indexOf('\n');
  const eol: Eol = firstNl > 0 && text[firstNl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(eol);
  const finalBreak = text.endsWith(eol);
  if (finalBreak) parts.pop();
  return { lines: parts, eol, finalBreak };
}

function docToText(doc: Doc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.eol) + (doc.finalBreak ? doc.eol : '');
}

// ---------------------------------------------------------------- the tree

// The tree as the edits leave it. `pending` holds every path an edit has
// touched (null: deleted); anything else is read from disk as it stands.
class WorkTree {
  private disk = new Map<string, string | null>();
  private pending = new Map<string, string | null>();
  private moved: Array<{ from: string; to: string }> = [];

  diskText(p: string): string | null {
    if (!this.disk.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p) as string | null;
  }

  textNow(p: string): string | null {
    return this.pending.has(p) ? (this.pending.get(p) as string | null) : this.diskText(p);
  }

  setText(p: string, text: string | null): void {
    this.pending.set(p, text);
  }

  noteMove(from: string, to: string): void {
    this.moved.push({ from, to });
  }

  snapshot(): { pending: Map<string, string | null>; moves: number } {
    return { pending: new Map(this.pending), moves: this.moved.length };
  }

  restore(snap: { pending: Map<string, string | null>; moves: number }): void {
    this.pending = new Map(snap.pending);
    this.moved.length = snap.moves;
  }

  // The output rows for exit 0 (SPEC section 2), in byte order of the
  // paths; a successful move is one `R old -> new` line, sorted by <new>.
  outputRows(): string[] {
    const rows: Array<{ key: string; row: string }> = [];
    const covered = new Set<string>();
    for (const m of this.moved) {
      const oldWas = this.diskText(m.from);
      const oldIs = this.textNow(m.from);
      const newWas = this.diskText(m.to);
      const newIs = this.textNow(m.to);
      if (oldWas !== null && oldIs === null && newWas === null && newIs !== null) {
        rows.push({ key: m.to, row: `R ${m.from} -> ${m.to}` });
        covered.add(m.from);
        covered.add(m.to);
      }
    }
    for (const [p, cur] of this.pending) {
      if (covered.has(p)) continue;
      const was = this.diskText(p);
      if (was === cur) continue;
      if (was === null) rows.push({ key: p, row: `A ${p}` });
      else if (cur === null) rows.push({ key: p, row: `D ${p}` });
      else rows.push({ key: p, row: `M ${p}` });
    }
    rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
    return rows.map((r) => r.row);
  }

  writeAll(): void {
    for (const [p, cur] of this.pending) {
      if (this.diskText(p) === cur) continue;
      if (cur === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, cur, 'utf8');
      }
    }
  }
}

// ---------------------------------------------------------------- matching (SPEC section 5)

function linesMatchAt(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailingWs(a) === stripTrailingWs(b);
  return stripBothWs(a) === stripBothWs(b);
}

// Every start position where oldLines matches fileLines at this tier.
function occurrencesAt(fileLines: string[], oldLines: string[], tier: number): number[] {
  const found: number[] = [];
  const n = oldLines.length;
  if (n === 0) return found;
  for (let i = 0; i + n <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (!linesMatchAt(fileLines[i + j], oldLines[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) found.push(i);
  }
  return found;
}

// The first tier at which oldLines occurs at least once, with every
// occurrence at that tier; null when it occurs at no tier.
function matchFirstTier(
  fileLines: string[],
  oldLines: string[],
  strict: boolean,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAt(fileLines, oldLines, t);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

// The first occurrence of oldLines at or after `from`, at the first tier
// with one; for an end-of-file chunk only an occurrence that ends at the
// file's last line counts.
function matchFrom(
  fileLines: string[],
  oldLines: string[],
  from: number,
  strict: boolean,
  atEof: boolean,
): { tier: number; start: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAt(fileLines, oldLines, t).filter(
      (p) => p >= from && (!atEof || p + oldLines.length === fileLines.length),
    );
    if (pos.length > 0) return { tier: t, start: pos[0] };
  }
  return null;
}

// The first line at or after `from` equal to a single-line anchor, at the
// first tier where one is; -1 when there is none.
function findAnchorLine(
  fileLines: string[],
  anchor: string,
  from: number,
  strict: boolean,
): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < fileLines.length; i++) {
      if (linesMatchAt(fileLines[i], anchor, t)) return i;
    }
  }
  return -1;
}

// One line of N: a context line (ctx >= 0: the file's own matched line at
// that index of O) or an added line (ctx -1: the patch's text).
interface NewLine {
  text: string;
  ctx: number;
}

// Build the lines that replace a matched run. Context lines are written as
// the file's own matched lines, never the patch's. At tier 2 every other
// line is re-indented: P, the leading whitespace of O's first line, is
// replaced by F, the leading whitespace of the file's first matched line.
function buildReplacement(
  fileLines: string[],
  start: number,
  oldLines: string[],
  newLines: NewLine[],
  tier: number,
): string[] {
  const out: string[] = [];
  const fLead = leadingWs(fileLines[start] ?? '');
  const pLead = leadingWs(oldLines[0] ?? '');
  for (const nl of newLines) {
    if (nl.ctx >= 0) {
      out.push(fileLines[start + nl.ctx]);
    } else if (tier === 2) {
      const t = nl.text;
      if (t !== '' && !onlyWs(t) && t.startsWith(pLead)) {
        out.push(fLead + t.slice(pLead.length));
      } else {
        out.push(t);
      }
    } else {
      out.push(nl.text);
    }
  }
  return out;
}

// ---------------------------------------------------------------- edits

// A hunk (unified) or a chunk (V4A): O is its context and `-` lines, N its
// context and `+` lines. `noeol` says a `\` line follows the hunk's last
// context or `+` line; `lastPlusNoeol` says one follows its last `+` line
// (null when it has none) — the two final-break rules of section 6.
interface Hunk {
  a: number;
  o: string[];
  n: NewLine[];
  noeol: boolean;
  lastPlusNoeol: boolean | null;
}

// A V4A chunk: like a hunk, plus its anchor and whether `*** End of File`
// anchored it to the end of the file.
interface VChunk extends Hunk {
  anchor: string | null;
  eof: boolean;
}

type Edit =
  | { kind: 'unified'; oldPath: string | null | undefined; newPath: string | null | undefined; isNew: boolean; isDeleted: boolean; hunks: Hunk[] }
  | { kind: 'sr'; path: string; oldLines: string[]; newLines: string[] }
  | { kind: 'v4a-add'; path: string; lines: string[] }
  | { kind: 'v4a-del'; path: string }
  | { kind: 'v4a-upd'; path: string; newPath: string | null; chunks: VChunk[] }
  | { kind: 'json-create'; path: string; text: string }
  | { kind: 'json-str'; path: string; oldStr: string; newStr: string }
  | { kind: 'json-ins'; path: string; line: number; newLines: string[] };

// Build a hunk/chunk from its raw body lines. A body line is ` ` (context),
// `-` (old), `+` (new), `\` (a marker, not a line) or empty (a context
// line whose text is empty).
function buildHunk(a: number, body: string[]): Hunk {
  const o: string[] = [];
  const n: NewLine[] = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const bl = body[k];
    if (bl === '') {
      o.push('');
      n.push({ text: '', ctx: o.length - 1 });
      lastCtxPlus = k;
    } else if (bl[0] === ' ') {
      const t = bl.slice(1);
      o.push(t);
      n.push({ text: t, ctx: o.length - 1 });
      lastCtxPlus = k;
    } else if (bl[0] === '-') {
      o.push(bl.slice(1));
    } else if (bl[0] === '+') {
      n.push({ text: bl.slice(1), ctx: -1 });
      lastCtxPlus = k;
      lastPlus = k;
    }
    // a `\` line is a marker for the line before it, not a line itself
  }
  const noeol =
    lastCtxPlus >= 0 && lastCtxPlus + 1 < body.length && body[lastCtxPlus + 1][0] === '\\';
  const lastPlusNoeol =
    lastPlus >= 0 ? lastPlus + 1 < body.length && body[lastPlus + 1][0] === '\\' : null;
  return { a, o, n, noeol, lastPlusNoeol };
}

// ---------------------------------------------------------------- format detection (SPEC section 4)

function detectFormat(lines: string[]): string | null {
  let first = -1;
  for (let k = 0; k < lines.length; k++) {
    if (!isBlankLine(lines[k])) {
      first = k;
      break;
    }
  }
  if (first < 0) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first].trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  for (const l of lines) {
    if (l.trimEnd() === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].startsWith('diff --git ')) return 'unified';
    if (lines[k].startsWith('--- ') && k + 1 < lines.length && lines[k + 1].startsWith('+++ ')) {
      return 'unified';
    }
  }
  return null;
}

// ---------------------------------------------------------------- unified diffs (SPEC section 6)

// The path after `--- ` or `+++ `: the text after the four characters, up
// to the first tab, with surrounding spaces removed; a leading a/ or b/
// removed; /dev/null means no file (null).
function headerPath(line: string): string | null {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest === '/dev/null') return null;
  if (rest.startsWith('a/') || rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

interface SectionDraft {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renOld: string | undefined;
  renNew: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  isNew: boolean;
  isDeleted: boolean;
  hunks: Hunk[];
}

function parseUnified(lines: string[]): Edit[] {
  const sections: SectionDraft[] = [];
  let cur: SectionDraft | null = null;
  let pairSeen = false;
  let body: string[] | null = null;
  let bodyA = 0;

  const closeHunk = (): void => {
    if (body === null || cur === null) return;
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    cur.hunks.push(buildHunk(bodyA, body));
    body = null;
  };
  const closeSection = (): void => {
    closeHunk();
    if (cur !== null) {
      sections.push(cur);
      cur = null;
      pairSeen = false;
    }
  };
  const freshSection = (): SectionDraft => ({
    pairOld: undefined,
    pairNew: undefined,
    renOld: undefined,
    renNew: undefined,
    diffOld: undefined,
    diffNew: undefined,
    isNew: false,
    isDeleted: false,
    hunks: [],
  });
  const hunkAOf = (line: string): number | null => {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    return m ? parseInt(m[1], 10) : null;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (body !== null) {
      const startsPair =
        line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ');
      const isBodyLine =
        line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\';
      if (!startsPair && isBodyLine) {
        body.push(line);
        i += 1;
        continue;
      }
      closeHunk();
      continue; // re-read this line outside the body
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!m) throw new ParseFault(i + 1);
      closeSection();
      cur = freshSection();
      cur.diffOld = m[1];
      cur.diffNew = m[2];
      pairSeen = false;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      if (cur !== null && !pairSeen && cur.hunks.length === 0) {
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]);
        pairSeen = true;
      } else {
        closeSection();
        cur = freshSection();
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]);
        pairSeen = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      // A `--- ` line not followed by `+++ `, inside a section's header.
      if (cur !== null && cur.hunks.length === 0) throw new ParseFault(i + 2);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new ParseFault(i + 1);
      const a = hunkAOf(line);
      if (a === null) throw new ParseFault(i + 1);
      bodyA = a;
      body = [];
      i += 1;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.isNew = true;
      else if (line.startsWith('deleted file mode')) cur.isDeleted = true;
      // index, old/new mode, similarity, dissimilarity, Index: and every
      // other header line are ignored
      i += 1;
      continue;
    }
    i += 1; // prose and anything else outside a body or a header
  }
  closeSection();

  return sections.map((s) => {
    const oldPath = s.pairOld !== undefined ? s.pairOld : s.renOld !== undefined ? s.renOld : s.diffOld;
    const newPath = s.pairNew !== undefined ? s.pairNew : s.renNew !== undefined ? s.renNew : s.diffNew;
    return {
      kind: 'unified' as const,
      oldPath,
      newPath,
      isNew: s.isNew,
      isDeleted: s.isDeleted,
      hunks: s.hunks,
    };
  });
}

// Apply a section's hunks to a doc's lines, in order, each to the result
// of the ones before it. d is the drift so far: N's length minus O's.
function applyHunks(doc: Doc, hunks: Hunk[], strict: boolean, path: string): Doc {
  const lines = doc.lines.slice();
  let finalBreak = doc.finalBreak;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const pos = Math.min(h.a + d, lines.length);
      const atEnd = pos === lines.length;
      const ins = h.n.map((e) => e.text);
      if (ins.length > 0) {
        lines.splice(pos, 0, ...ins);
        if (atEnd) finalBreak = !h.noeol;
      }
      d += h.n.length;
      continue;
    }
    const found = matchFirstTier(lines, h.o, strict);
    if (found === null) throw new EditFault('no-match', path);
    const target = h.a - 1 + d;
    let best = found.positions[0];
    for (const p of found.positions) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const atEnd = best + h.o.length === lines.length;
    const repl = buildReplacement(lines, best, h.o, h.n, found.tier);
    lines.splice(best, h.o.length, ...repl);
    if (atEnd) finalBreak = !h.noeol;
    d += h.n.length - h.o.length;
  }
  return { lines, eol: doc.eol, finalBreak };
}

// ---------------------------------------------------------------- SEARCH/REPLACE (SPEC section 7)

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1; // index after the previous block's REPLACE line
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const sIdx = i;
    let path: string | null = null;
    for (let k = sIdx - 1; k > prevEnd; k--) {
      const t = lines[k];
      if (t.trim() === '') continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseFault(sIdx + 1);
      path = prevPath;
    }
    let eq = -1;
    for (let k = sIdx + 1; k < lines.length; k++) {
      const t = lines[k].trimEnd();
      if (t === '=======') {
        eq = k;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq === -1) throw new ParseFault(sIdx + 1);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      if (lines[k].trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep === -1) throw new ParseFault(sIdx + 1);
    edits.push({
      kind: 'sr',
      path,
      oldLines: lines.slice(sIdx + 1, eq),
      newLines: lines.slice(eq + 1, rep),
    });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---------------------------------------------------------------- V4A (SPEC section 8)

function finishVChunk(c: { anchor: string | null; body: string[]; eof: boolean }): VChunk {
  const h = buildHunk(0, c.body);
  return { ...h, anchor: c.anchor, eof: c.eof };
}

function parseV4a(lines: string[]): Edit[] {
  let first = -1;
  for (let k = 0; k < lines.length; k++) {
    if (!isBlankLine(lines[k])) {
      first = k;
      break;
    }
  }
  if (first === -1) throw new ParseFault(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseFault(first + 1);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!isBlankLine(lines[k])) {
      last = k;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);

  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

  let k = first + 1;
  while (k < last) {
    if (isBlankLine(lines[k])) {
      k += 1;
      continue;
    }
    const line = lines[k];
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      // The section's lines run to the next section or *** End Patch; blank
      // lines at the end of the section are not part of it.
      let end = k + 1;
      while (end < last && !isSectionStart(lines[end])) end += 1;
      let effEnd = end;
      while (effEnd > k + 1 && isBlankLine(lines[effEnd - 1])) effEnd -= 1;
      const raw: string[] = [];
      for (let j = k + 1; j < effEnd; j++) {
        const l = lines[j];
        if (l.startsWith('+')) raw.push(l.slice(1));
        else if (l === '') raw.push('');
        else throw new ParseFault(j + 1);
      }
      edits.push({ kind: 'v4a-add', path, lines: raw });
      k = end;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      edits.push({ kind: 'v4a-del', path });
      k += 1;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updLineNo = k + 1;
      // The section's lines run to the next section or *** End Patch; blank
      // lines at the end of the section are not part of it.
      let end = k + 1;
      while (end < last && !isSectionStart(lines[end])) end += 1;
      let effEnd = end;
      while (effEnd > k + 1 && isBlankLine(lines[effEnd - 1])) effEnd -= 1;
      k += 1;
      let newPath: string | null = null;
      if (k < effEnd && lines[k].startsWith('*** Move to: ')) {
        newPath = lines[k].slice('*** Move to: '.length).trim();
        k += 1;
      }
      const chunks: VChunk[] = [];
      let curChunk: { anchor: string | null; body: string[]; eof: boolean } | null = null;
      const closeChunk = (): void => {
        if (curChunk === null) return;
        chunks.push(finishVChunk(curChunk));
        curChunk = null;
      };
      while (k < effEnd) {
        const l = lines[k];
        if (l.trim() === '*** End of File') {
          if (curChunk === null) throw new ParseFault(k + 1);
          curChunk.eof = true;
          closeChunk();
          k += 1;
          continue;
        }
        if (l.startsWith('@@')) {
          closeChunk();
          curChunk = { anchor: l.slice(2).trim() || null, body: [], eof: false };
          k += 1;
          continue;
        }
        if (l.startsWith('*** Move to: ')) throw new ParseFault(k + 1);
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (curChunk === null) {
            if (chunks.length > 0) {
              if (l === '') {
                k += 1; // a blank line between chunks is a separator
                continue;
              }
              throw new ParseFault(k + 1);
            }
            curChunk = { anchor: null, body: [], eof: false };
          }
          curChunk.body.push(l);
          k += 1;
          continue;
        }
        throw new ParseFault(k + 1);
      }
      closeChunk();
      if (chunks.length === 0 && newPath === null) throw new ParseFault(updLineNo);
      edits.push({ kind: 'v4a-upd', path, newPath, chunks });
      k = end;
      continue;
    }
    throw new ParseFault(k + 1);
  }
  return edits;
}

// ---------------------------------------------------------------- JSON (SPEC section 9)

function jsonEditToEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  if (typeof o.command !== 'string') return null;
  const path = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { kind: 'json-create', path, text: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    return { kind: 'json-str', path, oldStr: o.old_str, newStr: (o.new_str as string | undefined) ?? '' };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return { kind: 'json-ins', path, line: o.insert_line, newLines: splitPatchText(o.new_str) };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  let first = -1;
  for (let k = 0; k < lines.length; k++) {
    if (!isBlankLine(lines[k])) {
      first = k;
      break;
    }
  }
  if (first === -1) throw new ParseFault(1);
  const edits: Edit[] = [];
  if (lines[first].trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseFault(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseFault(first + 1);
    for (const x of v) {
      const e = jsonEditToEdit(x);
      if (e === null) throw new ParseFault(first + 1);
      edits.push(e);
    }
    if (edits.length === 0) throw new ParseFault(1);
    return edits;
  }
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k];
    if (isBlankLine(l)) continue;
    let v: unknown;
    try {
      v = JSON.parse(l);
    } catch {
      throw new ParseFault(k + 1);
    }
    const e = jsonEditToEdit(v);
    if (e === null) throw new ParseFault(k + 1);
    edits.push(e);
  }
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

// ---------------------------------------------------------------- applying edits (SPEC section 10)

function applyEdit(tree: WorkTree, edit: Edit, strict: boolean): void {
  switch (edit.kind) {
    case 'unified': {
      const oldPath = edit.oldPath;
      const newPath = edit.newPath;
      if (oldPath !== null && oldPath !== undefined && !pathIsSafe(oldPath)) {
        throw new EditFault('unsafe', oldPath);
      }
      if (newPath !== null && newPath !== undefined && !pathIsSafe(newPath)) {
        throw new EditFault('unsafe', newPath);
      }
      if (edit.isNew || oldPath === null) {
        // creation: the file is the + lines of all its hunks, in order
        if (newPath === null || newPath === undefined) return;
        if (tree.textNow(newPath) !== null) throw new EditFault('exists', newPath);
        const plus: string[] = [];
        for (const h of edit.hunks) {
          for (const nl of h.n) {
            if (nl.ctx === -1) plus.push(nl.text);
          }
        }
        if (plus.length === 0) {
          tree.setText(newPath, '');
          return;
        }
        let finalBreak = true;
        for (let hi = edit.hunks.length - 1; hi >= 0; hi--) {
          const lp = edit.hunks[hi].lastPlusNoeol;
          if (lp !== null) {
            finalBreak = !lp;
            break;
          }
        }
        tree.setText(newPath, plus.join('\n') + (finalBreak ? '\n' : ''));
        return;
      }
      if (edit.isDeleted || newPath === null) {
        // deletion: the old path exists, it is deleted, hunks not read
        if (oldPath === null || oldPath === undefined) return;
        if (tree.textNow(oldPath) === null) throw new EditFault('missing', oldPath);
        tree.setText(oldPath, null);
        return;
      }
      if (oldPath !== newPath) {
        // move: hunks apply to the old file, the result goes to the new path
        if (oldPath === undefined || newPath === undefined) return;
        const cur = tree.textNow(oldPath);
        if (cur === null) throw new EditFault('missing', oldPath);
        if (tree.textNow(newPath) !== null) throw new EditFault('exists', newPath);
        const doc = applyHunks(docFromText(cur), edit.hunks, strict, oldPath);
        tree.setText(newPath, docToText(doc));
        tree.setText(oldPath, null);
        tree.noteMove(oldPath, newPath);
        return;
      }
      // change of the one path
      if (oldPath === undefined) return;
      const cur = tree.textNow(oldPath);
      if (cur === null) throw new EditFault('missing', oldPath);
      const doc = applyHunks(docFromText(cur), edit.hunks, strict, oldPath);
      tree.setText(oldPath, docToText(doc));
      return;
    }
    case 'sr': {
      if (!pathIsSafe(edit.path)) throw new EditFault('unsafe', edit.path);
      if (edit.oldLines.length === 0) {
        if (tree.textNow(edit.path) !== null) throw new EditFault('exists', edit.path);
        tree.setText(edit.path, edit.newLines.length === 0 ? '' : edit.newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.textNow(edit.path);
      if (cur === null) throw new EditFault('missing', edit.path);
      const doc = docFromText(cur);
      const found = matchFirstTier(doc.lines, edit.oldLines, strict);
      if (found === null) throw new EditFault('no-match', edit.path);
      if (found.positions.length > 1) throw new EditFault('ambiguous', edit.path);
      const start = found.positions[0];
      const n = edit.newLines.map((t) => ({ text: t, ctx: -1 }));
      const repl = buildReplacement(doc.lines, start, edit.oldLines, n, found.tier);
      const lines = [...doc.lines.slice(0, start), ...repl, ...doc.lines.slice(start + edit.oldLines.length)];
      tree.setText(edit.path, docToText({ lines, eol: doc.eol, finalBreak: doc.finalBreak }));
      return;
    }
    case 'v4a-add': {
      if (!pathIsSafe(edit.path)) throw new EditFault('unsafe', edit.path);
      if (tree.textNow(edit.path) !== null) throw new EditFault('exists', edit.path);
      tree.setText(edit.path, edit.lines.length === 0 ? '' : edit.lines.join('\n') + '\n');
      return;
    }
    case 'v4a-del': {
      if (!pathIsSafe(edit.path)) throw new EditFault('unsafe', edit.path);
      if (tree.textNow(edit.path) === null) throw new EditFault('missing', edit.path);
      tree.setText(edit.path, null);
      return;
    }
    case 'v4a-upd': {
      if (!pathIsSafe(edit.path)) throw new EditFault('unsafe', edit.path);
      if (edit.newPath !== null && !pathIsSafe(edit.newPath)) {
        throw new EditFault('unsafe', edit.newPath);
      }
      const cur = tree.textNow(edit.path);
      if (cur === null) throw new EditFault('missing', edit.path);
      if (edit.newPath !== null && tree.textNow(edit.newPath) !== null) {
        throw new EditFault('exists', edit.newPath);
      }
      const doc = docFromText(cur);
      const lines = doc.lines.slice();
      let cursor = 0;
      for (const ch of edit.chunks) {
        if (ch.anchor !== null) {
          const at = findAnchorLine(lines, ch.anchor, cursor, strict);
          if (at === -1) throw new EditFault('no-match', edit.path);
          cursor = at + 1;
        }
        if (ch.o.length === 0) {
          const pos = ch.eof ? lines.length : cursor;
          const ins = ch.n.map((e) => e.text);
          lines.splice(pos, 0, ...ins);
          cursor = pos + ins.length;
          continue;
        }
        const found = matchFrom(lines, ch.o, cursor, strict, ch.eof);
        if (found === null) throw new EditFault('no-match', edit.path);
        const repl = buildReplacement(lines, found.start, ch.o, ch.n, found.tier);
        lines.splice(found.start, ch.o.length, ...repl);
        cursor = found.start + repl.length;
      }
      const text = docToText({ lines, eol: doc.eol, finalBreak: doc.finalBreak });
      if (edit.newPath !== null) {
        tree.setText(edit.newPath, text);
        tree.setText(edit.path, null);
        tree.noteMove(edit.path, edit.newPath);
      } else {
        tree.setText(edit.path, text);
      }
      return;
    }
    case 'json-create': {
      if (!pathIsSafe(edit.path)) throw new EditFault('unsafe', edit.path);
      if (tree.textNow(edit.path) !== null) throw new EditFault('exists', edit.path);
      tree.setText(edit.path, edit.text);
      return;
    }
    case 'json-str': {
      if (!pathIsSafe(edit.path)) throw new EditFault('unsafe', edit.path);
      const cur = tree.textNow(edit.path);
      if (cur === null) throw new EditFault('missing', edit.path);
      const nl = cur.indexOf('\n');
      const crlf = nl > 0 && cur[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(cur);
      const old = toLf(edit.oldStr);
      const nw = toLf(edit.newStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFault('no-match', edit.path);
      if (count > 1) throw new EditFault('ambiguous', edit.path);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + nw + t.slice(at + old.length);
      tree.setText(edit.path, crlf ? out.replaceAll('\n', '\r\n') : out);
      return;
    }
    case 'json-ins': {
      if (!pathIsSafe(edit.path)) throw new EditFault('unsafe', edit.path);
      const cur = tree.textNow(edit.path);
      if (cur === null) throw new EditFault('missing', edit.path);
      const doc = docFromText(cur);
      if (edit.line < 0 || edit.line > doc.lines.length) throw new EditFault('no-match', edit.path);
      const lines = doc.lines.slice();
      lines.splice(edit.line, 0, ...edit.newLines);
      tree.setText(edit.path, docToText({ lines, eol: doc.eol, finalBreak: doc.finalBreak }));
      return;
    }
  }
}

// ---------------------------------------------------------------- the command line (SPEC sections 1-2)

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

function runCli(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null) return { code: 2, out: ['error: usage'] };
        const v = a.slice('--format='.length);
        if (!FORMAT_NAMES.includes(v)) return { code: 2, out: ['error: usage'] };
        format = v;
      } else if (a === '--check') {
        if (check) return { code: 2, out: ['error: usage'] };
        check = true;
      } else if (a === '--strict') {
        if (strict) return { code: 2, out: ['error: usage'] };
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const patchFile = pos.length === 0 || pos[0] === '-' ? null : pos[0];

  let patchText = '';
  try {
    patchText = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const pLines = splitPatchText(patchText);
  const kind = format === null || format === 'auto' ? detectFormat(pLines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    if (kind === 'unified') edits = parseUnified(pLines);
    else if (kind === 'search-replace') edits = parseSearchReplace(pLines);
    else if (kind === 'v4a') edits = parseV4a(pLines);
    else edits = parseJson(patchText, pLines);
    if (edits.length === 0) throw new ParseFault(1);
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [`error: parse ${e.lineNo}`] };
    throw e;
  }

  const tree = new WorkTree();
  const fails: EditFault[] = [];
  for (const ed of edits) {
    const snap = tree.snapshot();
    try {
      applyEdit(tree, ed, strict);
    } catch (e) {
      if (!(e instanceof EditFault)) throw e;
      tree.restore(snap);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const rows = tree.outputRows();
  if (!check) tree.writeAll();
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

// ---------------------------------------------------------------- entry point

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this
  // file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = runCli(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
