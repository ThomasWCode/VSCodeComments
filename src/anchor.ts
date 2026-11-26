// Anchoring: moving anchors through live edits, re-anchoring after changes
// made outside VS Code, and orphan detection. No vscode imports, so it can be
// unit-tested in plain Node.
import { createHash } from 'crypto';
import DiffMatchPatch from 'diff-match-patch';
import { Anchor } from './model';

/** Highest error score a fuzzy match may have and still be accepted. */
export const FUZZY_THRESHOLD = 0.5;
/** Lines searched either side of the old position by the fuzzy match. */
export const FUZZY_WINDOW = 1000;

export interface Pos {
  line: number;
  char: number;
}

/** One content change, its range in the document as it was before the change. */
export interface TextChange {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
  text: string;
}

export type AnchorRange = Pick<Anchor, 'startLine' | 'startChar' | 'endLine' | 'endChar'>;

export type ShiftResult =
  | { kind: 'unchanged' }
  | { kind: 'moved'; range: AnchorRange }
  /** partial: the change crossed one of the anchor's ends, so part of the anchored text went with it. */
  | { kind: 'edited'; range: AnchorRange; partial?: true }
  | { kind: 'deleted' };

export type ReanchorResult =
  | { kind: 'exact'; anchor: Anchor }
  | { kind: 'moved'; anchor: Anchor }
  | { kind: 'fuzzy'; anchor: Anchor; error: number }
  | { kind: 'orphaned' };

export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

export function sha1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

function cmp(a: Pos, b: Pos): number {
  return a.line - b.line || a.char - b.char;
}

/** Where the end of a change's inserted text lands. */
function insertedEnd(c: TextChange): Pos {
  const ins = splitLines(c.text);
  const last = ins.length - 1;
  return {
    line: c.startLine + last,
    char: last === 0 ? c.startChar + ins[0].length : ins[last].length,
  };
}

/** Maps a position at or after a change's end through that change. */
function mapAfter(p: Pos, c: TextChange): Pos {
  const ins = splitLines(c.text);
  const last = ins.length - 1;
  if (p.line === c.endLine) {
    const base = last === 0 ? c.startChar + ins[0].length : ins[last].length;
    return { line: c.startLine + last, char: base + (p.char - c.endChar) };
  }
  return { line: p.line + last - (c.endLine - c.startLine), char: p.char };
}

/**
 * Moves an anchor's range through one content change. Exact: the result is
 * where the same characters are after the change.
 *
 * - A change wholly before the anchor (an insertion at its start included)
 *   moves it.
 * - A change wholly after it (an insertion at its end included) leaves it.
 * - A change inside it, or overlapping one end, grows or shrinks it.
 * - A change that removes the whole range deletes it, unless it replaces
 *   exactly the anchored text with new text (retyping the anchored code).
 */
export function shiftAnchor(a: AnchorRange, c: TextChange): ShiftResult {
  const A: Pos = { line: a.startLine, char: a.startChar };
  const B: Pos = { line: a.endLine, char: a.endChar };
  const S: Pos = { line: c.startLine, char: c.startChar };
  const E: Pos = { line: c.endLine, char: c.endChar };

  if (cmp(E, A) <= 0) {
    const nA = mapAfter(A, c);
    const nB = mapAfter(B, c);
    if (cmp(nA, A) === 0 && cmp(nB, B) === 0) {
      return { kind: 'unchanged' };
    }
    return { kind: 'moved', range: toRange(nA, nB) };
  }
  if (cmp(S, B) >= 0) {
    return { kind: 'unchanged' };
  }
  if (cmp(S, A) <= 0 && cmp(E, B) >= 0) {
    const exact = cmp(S, A) === 0 && cmp(E, B) === 0;
    if (exact && c.text !== '') {
      return { kind: 'edited', range: toRange(S, insertedEnd(c)) };
    }
    return { kind: 'deleted' };
  }
  if (cmp(S, A) < 0) {
    return { kind: 'edited', range: toRange(insertedEnd(c), mapAfter(B, c)), partial: true };
  }
  if (cmp(E, B) > 0) {
    return { kind: 'edited', range: toRange(A, insertedEnd(c)), partial: true };
  }
  return { kind: 'edited', range: toRange(A, mapAfter(B, c)) };
}

function toRange(a: Pos, b: Pos): AnchorRange {
  return { startLine: a.line, startChar: a.char, endLine: b.line, endChar: b.char };
}

/** Text of a range, its lines joined with '\n'. Positions are clamped to the document. */
export function rangeText(lines: string[], r: AnchorRange): string {
  if (lines.length === 0) {
    return '';
  }
  const sl = clamp(r.startLine, 0, lines.length - 1);
  const el = clamp(r.endLine, sl, lines.length - 1);
  const sc = clamp(r.startChar, 0, lines[sl].length);
  const ec = clamp(r.endChar, 0, lines[el].length);
  if (sl === el) {
    return lines[sl].substring(sc, Math.max(sc, ec));
  }
  const parts = [lines[sl].substring(sc)];
  for (let i = sl + 1; i < el; i++) {
    parts.push(lines[i]);
  }
  parts.push(lines[el].substring(0, ec));
  return parts.join('\n');
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function contextAbove(lines: string[], line: number, count: number): string {
  return lines.slice(Math.max(0, line - count), Math.max(0, line)).join('\n');
}

function contextBelow(lines: string[], line: number, count: number): string {
  return lines.slice(line + 1, line + 1 + count).join('\n');
}

/** Builds a full anchor for a range of a document: its text, context and hash. */
export function makeAnchor(lines: string[], r: AnchorRange, contextLines: number): Anchor {
  const last = Math.max(0, lines.length - 1);
  const startLine = clamp(r.startLine, 0, last);
  const endLine = clamp(r.endLine, startLine, last);
  const range: AnchorRange = {
    startLine,
    startChar: clamp(r.startChar, 0, (lines[startLine] ?? '').length),
    endLine,
    endChar: clamp(r.endChar, 0, (lines[endLine] ?? '').length),
  };
  if (range.startLine === range.endLine && range.endChar < range.startChar) {
    range.endChar = range.startChar;
  }
  const text = rangeText(lines, range);
  return {
    ...range,
    text,
    before: contextAbove(lines, range.startLine, contextLines),
    after: contextBelow(lines, range.endLine, contextLines),
    hash: sha1(text),
  };
}

/** Re-reads an anchor's text, context and hash at its current position. */
export function refreshAnchor(anchor: Anchor, lines: string[], contextLines: number): Anchor {
  return makeAnchor(lines, anchor, contextLines);
}

function lineCount(s: string): number {
  return s === '' ? 0 : splitLines(s).length;
}

function sameLines(a: string, b: string): boolean {
  const la = splitLines(a).map((l) => l.trimEnd());
  const lb = splitLines(b).map((l) => l.trimEnd());
  return la.length === lb.length && la.every((l, i) => l === lb[i]);
}

/** How many sides (0-2) of an occurrence's surroundings match the stored context. */
function contextScore(anchor: Anchor, lines: string[], startLine: number, endLine: number): number {
  const nb = lineCount(anchor.before);
  const na = lineCount(anchor.after);
  let score = 0;
  if (sameLines(contextAbove(lines, startLine, nb), anchor.before)) {
    score++;
  }
  if (sameLines(contextBelow(lines, endLine, na), anchor.after)) {
    score++;
  }
  return score;
}

/** Line start offsets of text joined with '\n'. */
function lineStarts(lines: string[]): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  return starts;
}

function offsetToPos(starts: number[], offset: number): Pos {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return { line: lo, char: offset - starts[lo] };
}

const dmp = new DiffMatchPatch();
dmp.Diff_Timeout = 0.1;

/** Similarity of two strings, 0 to 1, from their Levenshtein distance. */
export function similarity(a: string, b: string): number {
  if (a === b) {
    return 1;
  }
  const max = Math.max(a.length, b.length);
  if (max === 0) {
    return 1;
  }
  const diffs = dmp.diff_main(a, b, false);
  return 1 - dmp.diff_levenshtein(diffs) / max;
}

/**
 * Finds where an anchor's code is now, after changes made outside VS Code.
 *
 * 1. Exact text at the stored position, or 2. elsewhere: among every exact
 *    occurrence, the one whose surrounding lines match the stored context
 *    best, then the nearest to the old line. (The stored position wins a tie,
 *    so unchanged files never move anchors.)
 * 3. Fuzzy: line windows near the old line, scored on the text and its
 *    context; accepted when the error is at most FUZZY_THRESHOLD.
 * 4. Otherwise orphaned.
 *
 * Whitespace-only anchors, which would match any blank line, are matched
 * exactly only where both context sides match too; otherwise fuzzily.
 */
export function reanchor(anchor: Anchor, lines: string[], contextLines: number): ReanchorResult {
  if (anchor.text.trim() === '') {
    const blank = findBlankWithContext(anchor, lines);
    if (blank !== undefined) {
      const textLines = splitLines(anchor.text);
      const endLine = blank + textLines.length - 1;
      return {
        kind: blank === anchor.startLine ? 'exact' : 'moved',
        anchor: makeAnchor(
          lines,
          { startLine: blank, startChar: anchor.startChar, endLine, endChar: anchor.endChar },
          contextLines,
        ),
      };
    }
  } else {
    const exact = findExact(anchor, lines);
    if (exact) {
      const kind = exact.line === anchor.startLine && exact.char === anchor.startChar ? 'exact' : 'moved';
      const textLines = splitLines(anchor.text);
      const endLine = exact.line + textLines.length - 1;
      const endChar = textLines.length === 1 ? exact.char + anchor.text.length : textLines[textLines.length - 1].length;
      return {
        kind,
        anchor: makeAnchor(lines, { startLine: exact.line, startChar: exact.char, endLine, endChar }, contextLines),
      };
    }
  }
  const fuzzy = findFuzzy(anchor, lines);
  if (fuzzy) {
    const endLine = fuzzy.line + fuzzy.count - 1;
    return {
      kind: 'fuzzy',
      error: fuzzy.error,
      anchor: makeAnchor(
        lines,
        { startLine: fuzzy.line, startChar: 0, endLine, endChar: lines[endLine].length },
        contextLines,
      ),
    };
  }
  return { kind: 'orphaned' };
}

function findExact(anchor: Anchor, lines: string[]): Pos | undefined {
  const joined = lines.join('\n');
  const starts = lineStarts(lines);
  const textLineCount = splitLines(anchor.text).length;
  let best: { pos: Pos; ctx: number; dist: number } | undefined;
  let from = 0;
  for (;;) {
    const i = joined.indexOf(anchor.text, from);
    if (i < 0) {
      break;
    }
    from = i + 1;
    const pos = offsetToPos(starts, i);
    const ctx = contextScore(anchor, lines, pos.line, pos.line + textLineCount - 1);
    const dist = Math.abs(pos.line - anchor.startLine) + (pos.line === anchor.startLine ? Math.abs(pos.char - anchor.startChar) / 1e6 : 0);
    if (!best || ctx > best.ctx || (ctx === best.ctx && dist < best.dist)) {
      best = { pos, ctx, dist };
    }
  }
  return best?.pos;
}

/**
 * An exact match for a whitespace-only anchor: the same whole lines, with
 * both stored context sides matching exactly (and some real code among
 * them), nearest the old line. Blank lines alone would match anywhere.
 */
function findBlankWithContext(anchor: Anchor, lines: string[]): number | undefined {
  if ((anchor.before + anchor.after).trim() === '') {
    return undefined;
  }
  const textLines = splitLines(anchor.text);
  const n = textLines.length;
  let best: number | undefined;
  for (let c = 0; c + n <= lines.length; c++) {
    if (!textLines.every((t, i) => lines[c + i].trimEnd() === t.trimEnd())) {
      continue;
    }
    if (contextScore(anchor, lines, c, c + n - 1) < 2) {
      continue;
    }
    if (best === undefined || Math.abs(c - anchor.startLine) < Math.abs(best - anchor.startLine)) {
      best = c;
    }
  }
  return best;
}

function findFuzzy(anchor: Anchor, lines: string[]): { line: number; count: number; error: number } | undefined {
  const count = splitLines(anchor.text).length;
  if (lines.length < count) {
    return undefined;
  }
  const nb = lineCount(anchor.before);
  const na = lineCount(anchor.after);
  const text = anchor.text.trim();
  const textWeight = text === '' ? 0.5 : 2;
  const wb = nb > 0 ? 1 : 0;
  const wa = na > 0 ? 1 : 0;
  const total = textWeight + wb + wa;
  const first = Math.max(0, anchor.startLine - FUZZY_WINDOW);
  const last = Math.min(lines.length - count, anchor.startLine + FUZZY_WINDOW);
  let best: { line: number; error: number } | undefined;
  for (let c = first; c <= last; c++) {
    const distance = Math.abs(c - anchor.startLine) / (FUZZY_WINDOW * 4);
    // The best error this window could reach if its context matched fully.
    const window = lines.slice(c, c + count).join('\n').trim();
    const textSim = similarity(text, window);
    const floor = (1 - (textWeight * textSim + wb + wa) / total) + distance;
    if (floor > FUZZY_THRESHOLD || (best && floor >= best.error)) {
      continue;
    }
    const beforeSim = wb ? similarity(anchor.before, contextAbove(lines, c, nb)) : 0;
    const afterSim = wa ? similarity(anchor.after, contextBelow(lines, c + count - 1, na)) : 0;
    const combined = (textWeight * textSim + wb * beforeSim + wa * afterSim) / total;
    const error = 1 - combined + distance;
    if (error <= FUZZY_THRESHOLD && (!best || error < best.error)) {
      best = { line: c, error };
    }
  }
  return best ? { line: best.line, count, error: best.error } : undefined;
}
