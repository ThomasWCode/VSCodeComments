// Unit tests for the model's merge of sidecars loaded after comments were
// added. Plain Node: npm run test:unit.
import * as assert from 'assert';
import { mergeLoaded, NoteThread } from '../src/model';

function thread(id: string, body: string): NoteThread {
  return {
    id,
    category: 'note',
    status: 'open',
    anchor: { startLine: 0, startChar: 0, endLine: 0, endChar: 0, text: '', before: '', after: '', hash: '' },
    orphaned: false,
    comments: [{ id: id + '-c', body, created: '2026-01-01T00:00:00.000Z', edited: null }],
  };
}

describe('mergeLoaded', () => {
  it('keeps a thread added while loading, alongside the loaded ones', () => {
    const added = thread('new', 'added during load');
    const merged = mergeLoaded([added], [thread('a', 'on disk'), thread('b', 'on disk')]);
    assert.deepStrictEqual(
      merged.map((t) => t.id),
      ['a', 'b', 'new'],
    );
    assert.strictEqual(merged[2], added, 'the model keeps its own object');
  });

  it("prefers the model's version of a thread that is also on disk", () => {
    const edited = thread('a', 'edited in memory');
    const merged = mergeLoaded([edited], [thread('a', 'older on disk')]);
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].comments[0].body, 'edited in memory');
  });
});
