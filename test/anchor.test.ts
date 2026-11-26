// Unit tests for anchoring: live shifting through edits, and re-anchoring
// after changes made outside VS Code. Plain Node: npm run test:unit.
import * as assert from 'assert';
import {
  AnchorRange,
  FUZZY_THRESHOLD,
  makeAnchor,
  reanchor,
  shiftAnchor,
  similarity,
  splitLines,
  TextChange,
} from '../src/anchor';

const FILE = [
  'import os', // 0
  '', // 1
  'def load(path):', // 2
  '    with open(path) as f:', // 3
  '        data = f.read()', // 4
  '    return data', // 5
  '', // 6
  'def save(path, data):', // 7
  '    with open(path, "w") as f:', // 8
  '        f.write(data)', // 9
  '', // 10
  'print(load("x"))', // 11
];

/** Lines 3-5 as whole lines, the way the gutter + anchors them. */
const BODY: AnchorRange = { startLine: 3, startChar: 0, endLine: 5, endChar: 15 };

function change(startLine: number, startChar: number, endLine: number, endChar: number, text: string): TextChange {
  return { startLine, startChar, endLine, endChar, text };
}

describe('shiftAnchor (live edits)', () => {
  it('moves the range down when lines are inserted above', () => {
    const r = shiftAnchor(BODY, change(1, 0, 1, 0, 'a\nb\n'));
    assert.deepStrictEqual(r, { kind: 'moved', range: { startLine: 5, startChar: 0, endLine: 7, endChar: 15 } });
  });

  it('moves the range up when lines are deleted above', () => {
    const r = shiftAnchor(BODY, change(0, 0, 2, 0, ''));
    assert.deepStrictEqual(r, { kind: 'moved', range: { startLine: 1, startChar: 0, endLine: 3, endChar: 15 } });
  });

  it('moves with an insertion exactly at its start (Enter at column 0)', () => {
    const r = shiftAnchor(BODY, change(3, 0, 3, 0, '\n'));
    assert.deepStrictEqual(r, { kind: 'moved', range: { startLine: 4, startChar: 0, endLine: 6, endChar: 15 } });
  });

  it('moves the end character with an insertion earlier on the same line', () => {
    const r = shiftAnchor({ startLine: 4, startChar: 8, endLine: 4, endChar: 23 }, change(4, 0, 4, 0, '  '));
    assert.deepStrictEqual(r, { kind: 'moved', range: { startLine: 4, startChar: 10, endLine: 4, endChar: 25 } });
  });

  it('is unchanged by an edit below', () => {
    assert.deepStrictEqual(shiftAnchor(BODY, change(8, 0, 9, 3, 'x')), { kind: 'unchanged' });
  });

  it('is unchanged by an insertion exactly at its end (Enter at the end of the last line)', () => {
    assert.deepStrictEqual(shiftAnchor(BODY, change(5, 15, 5, 15, '\n')), { kind: 'unchanged' });
  });

  it('grows when lines are inserted inside', () => {
    const r = shiftAnchor(BODY, change(4, 23, 4, 23, '\n        data += "!"'));
    assert.deepStrictEqual(r, { kind: 'edited', range: { startLine: 3, startChar: 0, endLine: 6, endChar: 15 } });
  });

  it('shrinks when a line inside is deleted', () => {
    const r = shiftAnchor(BODY, change(4, 0, 5, 0, ''));
    assert.deepStrictEqual(r, { kind: 'edited', range: { startLine: 3, startChar: 0, endLine: 4, endChar: 15 } });
  });

  it('keeps the rest when a deletion overlaps its start', () => {
    // Lines 2-3 deleted: line 4 is now line 2 and the anchor starts there.
    const r = shiftAnchor(BODY, change(2, 0, 4, 0, ''));
    assert.deepStrictEqual(r, {
      kind: 'edited',
      range: { startLine: 2, startChar: 0, endLine: 3, endChar: 15 },
      partial: true,
    });
  });

  it('keeps the rest when a deletion overlaps its end', () => {
    const r = shiftAnchor(BODY, change(5, 4, 7, 0, ''));
    assert.deepStrictEqual(r, {
      kind: 'edited',
      range: { startLine: 3, startChar: 0, endLine: 5, endChar: 4 },
      partial: true,
    });
  });

  it('follows a line joined onto the one above (Backspace at column 0)', () => {
    const r = shiftAnchor(BODY, change(2, 15, 3, 0, ''));
    assert.deepStrictEqual(r, { kind: 'moved', range: { startLine: 2, startChar: 15, endLine: 4, endChar: 15 } });
  });

  it('is deleted when its whole range is deleted', () => {
    assert.deepStrictEqual(shiftAnchor(BODY, change(3, 0, 6, 0, '')), { kind: 'deleted' });
  });

  it('is deleted when a larger replacement covers it', () => {
    assert.deepStrictEqual(shiftAnchor(BODY, change(2, 0, 7, 0, 'pass\n')), { kind: 'deleted' });
  });

  it('is deleted when exactly its text is deleted', () => {
    assert.deepStrictEqual(shiftAnchor(BODY, change(3, 0, 5, 15, '')), { kind: 'deleted' });
  });

  it('survives its exact text being retyped', () => {
    const r = shiftAnchor(BODY, change(3, 0, 5, 15, 'return 1'));
    assert.deepStrictEqual(r, { kind: 'edited', range: { startLine: 3, startChar: 0, endLine: 3, endChar: 8 } });
  });

  it('applies a sequence of changes the way VS Code reports multi-cursor edits (bottom to top)', () => {
    let range: AnchorRange = BODY;
    for (const c of [change(9, 0, 9, 0, '#'), change(4, 0, 4, 0, '#'), change(0, 0, 0, 0, 'x\n')]) {
      const r = shiftAnchor(range, c);
      if (r.kind === 'moved' || r.kind === 'edited') {
        range = r.range;
      }
    }
    assert.deepStrictEqual(range, { startLine: 4, startChar: 0, endLine: 6, endChar: 15 });
  });
});

describe('makeAnchor', () => {
  it('stores the text, context lines and a sha1', () => {
    const a = makeAnchor(FILE, BODY, 2);
    assert.strictEqual(a.text, FILE.slice(3, 6).join('\n'));
    assert.strictEqual(a.before, '\ndef load(path):');
    assert.strictEqual(a.after, '\ndef save(path, data):');
    assert.match(a.hash, /^[0-9a-f]{40}$/);
  });

  it('clamps context at the start and end of the file', () => {
    const a = makeAnchor(FILE, { startLine: 0, startChar: 0, endLine: 0, endChar: 9 }, 2);
    assert.strictEqual(a.before, '');
    const b = makeAnchor(FILE, { startLine: 11, startChar: 0, endLine: 11, endChar: 16 }, 2);
    assert.strictEqual(b.after, '');
  });

  it('clamps a range past the end of the document', () => {
    const a = makeAnchor(FILE, { startLine: 40, startChar: 3, endLine: 50, endChar: 99 }, 2);
    assert.strictEqual(a.startLine, 11);
    assert.strictEqual(a.endLine, 11);
  });
});

describe('reanchor (changes outside VS Code)', () => {
  const anchor = makeAnchor(FILE, BODY, 2);

  it('keeps an exact match at the stored line', () => {
    const r = reanchor(anchor, FILE, 2);
    assert.strictEqual(r.kind, 'exact');
  });

  it('finds the text after lines are inserted above (file rewritten on disk)', () => {
    const lines = ['# header', '# more', ...FILE];
    const r = reanchor(anchor, lines, 2);
    assert.strictEqual(r.kind, 'moved');
    assert.strictEqual(r.kind === 'moved' && r.anchor.startLine, 5);
  });

  it('finds the text after lines are inserted inside the context below', () => {
    const lines = [...FILE.slice(0, 6), '', '# new', ...FILE.slice(6)];
    const r = reanchor(anchor, lines, 2);
    assert.strictEqual(r.kind, 'exact');
  });

  it('prefers the copy whose surroundings match when the text is duplicated', () => {
    // The original moves 5 lines down; a copy with different surroundings sits nearer the old line.
    const copy = ['def other(path):', ...FILE.slice(3, 6), 'x = 1'];
    const lines = [...FILE.slice(0, 2), ...copy, ...FILE.slice(2)];
    const r = reanchor(anchor, lines, 2);
    assert.strictEqual(r.kind, 'moved');
    assert.strictEqual(r.kind === 'moved' && r.anchor.startLine, 3 + copy.length);
  });

  it('picks the nearest of equally good copies', () => {
    const lines = [...FILE, '', 'def load(path):', ...FILE.slice(3, 6), '', 'def save(path, data):'];
    const r = reanchor(anchor, lines, 2);
    assert.strictEqual(r.kind, 'exact');
  });

  it('matches multi-character anchors within a line exactly', () => {
    const a = makeAnchor(FILE, { startLine: 4, startChar: 15, endLine: 4, endChar: 23 }, 2);
    assert.strictEqual(a.text, 'f.read()');
    const lines = [...FILE];
    lines[4] = '        content = f.read()';
    const r = reanchor(a, lines, 2);
    assert.strictEqual(r.kind, 'moved');
    assert.deepStrictEqual(r.kind === 'moved' && [r.anchor.startLine, r.anchor.startChar], [4, 18]);
  });

  it('falls back to a fuzzy match when the code was lightly edited', () => {
    const lines = [...FILE];
    lines[4] = '        data = f.read().strip()';
    lines.splice(0, 0, '# moved');
    const r = reanchor(anchor, lines, 2);
    assert.strictEqual(r.kind, 'fuzzy');
    assert.strictEqual(r.kind === 'fuzzy' && r.anchor.startLine, 4);
    assert.ok(r.kind === 'fuzzy' && r.error <= FUZZY_THRESHOLD);
  });

  it('refreshes the stored text after a fuzzy match, so the next check is exact', () => {
    const lines = [...FILE];
    lines[4] = '        data = f.read().strip()';
    const first = reanchor(anchor, lines, 2);
    assert.strictEqual(first.kind, 'fuzzy');
    const second = reanchor(first.kind === 'fuzzy' ? first.anchor : anchor, lines, 2);
    assert.strictEqual(second.kind, 'exact');
  });

  it('orphans the thread when the code is gone', () => {
    const lines = [...FILE.slice(0, 3), '    return None', ...FILE.slice(6)];
    assert.strictEqual(reanchor(anchor, lines, 2).kind, 'orphaned');
  });

  it('orphans the thread when the file was emptied', () => {
    assert.strictEqual(reanchor(anchor, [''], 2).kind, 'orphaned');
  });

  it('handles CRLF files the same as LF ones', () => {
    const lines = splitLines(['# top', ...FILE].join('\r\n'));
    const r = reanchor(anchor, lines, 2);
    assert.strictEqual(r.kind, 'moved');
    assert.strictEqual(r.kind === 'moved' && r.anchor.startLine, 4);
  });

  it('re-anchors a blank-line anchor by its context, not by matching any blank line', () => {
    const blank = makeAnchor(FILE, { startLine: 6, startChar: 0, endLine: 6, endChar: 0 }, 2);
    const lines = ['', '', ...FILE];
    const r = reanchor(blank, lines, 2);
    assert.notStrictEqual(r.kind, 'orphaned');
    assert.strictEqual(r.kind !== 'orphaned' && r.anchor.startLine, 8);
  });

  describe('fuzzy threshold boundaries', () => {
    // One-line anchors with no context: the error is 1 - similarity (no distance at the old line).
    const word = 'abcdefghij';
    const one = makeAnchor([word], { startLine: 0, startChar: 0, endLine: 0, endChar: 10 }, 0);

    it('accepts a match just inside the threshold', () => {
      // 5 of 10 characters changed: similarity 0.5, error 0.5.
      const r = reanchor(one, ['abcdeVWXYZ'], 0);
      assert.strictEqual(r.kind, 'fuzzy');
    });

    it('rejects a match just outside it', () => {
      // 6 of 10 characters changed: similarity 0.4, error 0.6.
      const r = reanchor(one, ['abcdUVWXYZ'], 0);
      assert.strictEqual(r.kind, 'orphaned');
    });

    it('adds a penalty for distance from the old line', () => {
      // The same 50% match, but 400 lines away, goes over the threshold.
      const lines = [...Array(400).fill('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'), 'abcdeVWXYZ'];
      assert.strictEqual(reanchor(one, lines, 0).kind, 'orphaned');
    });
  });
});

describe('similarity', () => {
  it('is 1 for equal strings and 0 for wholly different ones', () => {
    assert.strictEqual(similarity('abc', 'abc'), 1);
    assert.strictEqual(similarity('', ''), 1);
    assert.strictEqual(similarity('aaa', 'bbb'), 0);
  });

  it('is the share of characters kept', () => {
    assert.strictEqual(similarity('abcd', 'abcx'), 0.75);
  });
});
