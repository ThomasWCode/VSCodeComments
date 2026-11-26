// Integration: the add / reply / edit / resolve / delete round trip, live
// anchoring, changes on disk and export, inside a real VS Code.
import * as assert from 'assert';
import * as fs from 'fs';
import * as vscode from 'vscode';
import type { MarginNotesApi } from '../../src/extension';
import type { NoteCommentItem } from '../../src/commentController';
import { collectEntries, toHtml, toMarkdown } from '../../src/export';
import { parseSidecar } from '../../src/store';
import { api, key, reset, SAMPLE, samplePath, sidecar, sleep, waitFor } from './helpers';

describe('Margin Notes round trip', function () {
  this.timeout(30000);
  let a: MarginNotesApi;
  let editor: vscode.TextEditor;

  before(async () => {
    a = await api();
  });

  beforeEach(async () => {
    editor = await reset(a);
  });

  after(async () => {
    await reset(a);
    fs.rmSync(samplePath(), { force: true });
  });

  function create(startLine: number, endLine: number, body = 'Why read it all?') {
    const range = new vscode.Range(startLine, 0, endLine, editor.document.lineAt(endLine).text.length);
    return a.actions.createThread(key(), editor.document, range, body, 'question');
  }

  it('adds a thread, saves its sidecar and draws a native thread', async () => {
    const t = create(3, 5);
    await a.store.flush();
    const data = parseSidecar(fs.readFileSync(sidecar(), 'utf8'));
    assert.strictEqual(data.file, 'sample.py');
    assert.strictEqual(data.threads.length, 1);
    assert.strictEqual(data.threads[0].category, 'question');
    assert.strictEqual(data.threads[0].anchor.text, SAMPLE.split('\n').slice(3, 6).join('\n'));
    const native = a.native.native(t.id)!;
    assert.ok(native, 'native thread exists');
    assert.strictEqual(native.range.start.line, 3);
    assert.strictEqual(native.comments.length, 1);
    assert.strictEqual(native.state, vscode.CommentThreadState.Unresolved);
    assert.strictEqual((native.comments[0] as NoteCommentItem).author.name, 'Note');
  });

  it('replies, edits, resolves, reopens and deletes', async () => {
    const t = create(3, 5);
    a.actions.reply(t.id, 'Because it is small.');
    assert.strictEqual(a.native.native(t.id)!.comments.length, 2);

    const second = t.comments[1].id;
    a.actions.editComment(second, 'Because it is small enough.');
    const item = a.native.native(t.id)!.comments[1] as NoteCommentItem;
    assert.strictEqual(item.label, '(edited)');
    assert.ok(t.comments[1].edited);

    a.actions.setStatus(t.id, 'resolved');
    assert.strictEqual(a.native.native(t.id)!.state, vscode.CommentThreadState.Resolved);
    assert.match(a.native.native(t.id)!.contextValue!, /\bresolved\b/);
    a.actions.setStatus(t.id, 'open');
    assert.match(a.native.native(t.id)!.contextValue!, /\bopen\b/);

    a.actions.deleteComment(second);
    assert.strictEqual(t.comments.length, 1);

    await a.store.flush();
    assert.ok(fs.existsSync(sidecar()));
    await a.actions.deleteThread(t.id, false);
    await a.store.flush();
    assert.strictEqual(a.native.native(t.id), undefined);
    assert.ok(!fs.existsSync(sidecar()), 'the sidecar goes with the last comment');
  });

  it('deleting the last comment deletes the thread', async () => {
    const t = create(3, 3);
    a.actions.deleteComment(t.comments[0].id);
    assert.strictEqual(a.model.find(t.id), undefined);
  });

  it('creates a thread from the comment widget, through the category quick pick', async () => {
    const draft = a.native.controller.createCommentThread(editor.document.uri, new vscode.Range(4, 0, 4, 0), []);
    const done = vscode.commands.executeCommand('marginNotes.createThread', { thread: draft, text: 'From the gutter' });
    await sleep(500);
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    await done;
    const [only] = a.model.threads(key());
    assert.ok(only);
    assert.strictEqual(only.category, 'note', 'the default category is offered first');
    assert.strictEqual(only.comments[0].body, 'From the gutter');
    // From the gutter the anchor covers the whole line.
    assert.strictEqual(only.anchor.text, '        data = f.read()');
    assert.strictEqual(a.native.native(only.id), draft, 'the widget the user typed into is kept');
  });

  it('moves anchors with live edits, and writes the new position on save', async () => {
    const t = create(3, 5);
    await editor.edit((e) => e.insert(new vscode.Position(2, 0), '# one\n# two\n'));
    assert.strictEqual(t.anchor.startLine, 5);
    assert.strictEqual(a.native.native(t.id)!.range.start.line, 5);
    await editor.document.save();
    await a.store.flush();
    const saved = parseSidecar(fs.readFileSync(sidecar(), 'utf8')).threads[0];
    assert.strictEqual(saved.anchor.startLine, 5);
    assert.strictEqual(saved.anchor.before, '# two\ndef load(path):');
  });

  it('grows the range with edits inside it and updates the text on save', async () => {
    const t = create(3, 5);
    await editor.edit((e) => e.insert(new vscode.Position(4, 23), '\n        data = data.strip()'));
    assert.deepStrictEqual([t.anchor.startLine, t.anchor.endLine], [3, 6]);
    await editor.document.save();
    assert.ok(t.anchor.text.includes('data.strip()'));
  });

  it('orphans a thread whose code is deleted, and reattaches it on undo', async () => {
    const t = create(3, 5);
    await editor.edit((e) => e.delete(new vscode.Range(3, 0, 6, 0)));
    assert.strictEqual(t.orphaned, true);
    assert.strictEqual(a.native.native(t.id), undefined, 'orphans have no inline thread');
    assert.ok(a.model.find(t.id), 'orphans are never dropped');
    await vscode.commands.executeCommand('undo');
    await waitFor(() => !t.orphaned, 'reattach on undo');
    assert.strictEqual(t.anchor.startLine, 3);
  });

  it('reattaches an orphan to the selection', async () => {
    const t = create(3, 3);
    await editor.edit((e) => e.delete(new vscode.Range(3, 0, 4, 0)));
    assert.ok(t.orphaned);
    editor.selection = new vscode.Selection(10, 0, 11, 5);
    await a.actions.reattach(t.id);
    assert.strictEqual(t.orphaned, false);
    assert.deepStrictEqual([t.anchor.startLine, t.anchor.endLine], [10, 11]);
  });

  it('re-anchors when the file is rewritten on disk (a git checkout)', async () => {
    const t = create(3, 5);
    await a.store.flush();
    fs.writeFileSync(samplePath(), '# added by checkout\n# and more\n' + SAMPLE);
    await waitFor(() => t.anchor.startLine === 5, 'the anchor to follow the rewrite');
    assert.strictEqual(t.orphaned, false);
  });

  it('stays attached when a rewrite on disk also changes the commented code', async () => {
    const t = create(3, 5);
    await a.store.flush();
    const lines = SAMPLE.split('\n');
    lines[4] = '        data = f.read()  # changed on another branch';
    lines.splice(2, 0, '# inserted');
    fs.writeFileSync(samplePath(), lines.join('\n'));
    await waitFor(() => editor.document.getText() === lines.join('\n'), 'the reload');
    await sleep(300);
    assert.strictEqual(t.orphaned, false);
    assert.strictEqual(t.anchor.startLine, 4);
  });

  it('re-anchors a thread whose whole block is replaced by a reload', async () => {
    const t = create(4, 4);
    await a.store.flush();
    // Every line around the anchor changes, so the reload replaces the whole block.
    const lines = SAMPLE.split('\n');
    const replaced = ['def load(p):', '    with open(p) as fh:', '        data = f.read()', '    return data.strip()', '# end'];
    lines.splice(2, 4, ...replaced);
    fs.writeFileSync(samplePath(), lines.join('\n'));
    await waitFor(() => editor.document.getText() === lines.join('\n'), 'the reload');
    await waitFor(() => !t.orphaned, 'the thread to be re-anchored, not orphaned');
    assert.strictEqual(t.anchor.startLine, 4);
  });

  it('reloads a sidecar changed outside the extension', async () => {
    const t = create(3, 5);
    await a.store.flush();
    const data = parseSidecar(fs.readFileSync(sidecar(), 'utf8'));
    data.threads[0].comments[0].body = 'Changed by a sync tool';
    fs.writeFileSync(sidecar(), JSON.stringify(data));
    await waitFor(() => a.model.find(t.id)?.thread.comments[0].body === 'Changed by a sync tool', 'the reload');
  });

  it('drops the threads of a sidecar deleted outside the extension', async () => {
    const t = create(3, 5);
    await a.store.flush();
    fs.rmSync(sidecar());
    await waitFor(() => a.model.find(t.id) === undefined, 'the threads to go');
  });

  it('keeps threads through a late watcher event for a sidecar that exists again', async () => {
    // Deleting and re-creating a sidecar quickly leaves a "deleted" event in
    // flight for a file that is back: the threads must survive it.
    const t = create(3, 5);
    await a.store.flush();
    await a.actions.deleteThread(t.id, false);
    await a.store.flush();
    const again = create(3, 5);
    await a.store.flush();
    await sleep(1500);
    assert.ok(a.model.find(again.id), 'the new thread is still there');
    assert.ok(fs.existsSync(sidecar()));
  });

  it('hides resolved threads when showResolved is off', async () => {
    const t = create(3, 3);
    a.actions.setStatus(t.id, 'resolved');
    const cfg = vscode.workspace.getConfiguration('marginNotes');
    await cfg.update('showResolved', false, vscode.ConfigurationTarget.Workspace);
    try {
      await waitFor(() => a.native.native(t.id) === undefined, 'the resolved thread to hide');
      assert.strictEqual(a.panel.state().threads.length, 0);
    } finally {
      await cfg.update('showResolved', undefined, vscode.ConfigurationTarget.Workspace);
    }
    await waitFor(() => a.native.native(t.id) !== undefined, 'the resolved thread to come back');
  });

  it('exports Markdown and HTML with snippet, category, status and thread', async () => {
    const t = create(3, 5, 'Needs a <b>check</b>');
    a.actions.setStatus(t.id, 'resolved');
    const entries = await collectEntries(a.model, { keys: [key()], includeResolved: true, categories: null });
    const md = toMarkdown(entries, 'Comments');
    assert.match(md, /## sample\.py/);
    assert.match(md, /### L4–L6 · Question · resolved/);
    assert.match(md, /```python\n {4}with open\(path\) as f:/);
    assert.match(md, /Needs a <b>check<\/b>/);
    const html = toHtml(entries, 'Comments');
    assert.match(html, /Needs a &lt;b&gt;check&lt;\/b&gt;/, 'comment text is escaped');
    assert.doesNotMatch(html, /<script|<link|src=/, 'standalone: no scripts or external assets');
    const openOnly = await collectEntries(a.model, { keys: [key()], includeResolved: false, categories: null });
    assert.strictEqual(openOnly.length, 0);
    const otherCategory = await collectEntries(a.model, { keys: [key()], includeResolved: true, categories: ['bug'] });
    assert.strictEqual(otherCategory.length, 0);
  });

  it('counts open threads in the sidebar badge', async () => {
    create(3, 3);
    const t = create(10, 10);
    await waitFor(() => a.tree.view.badge?.value === 2, 'badge 2');
    a.actions.setStatus(t.id, 'resolved');
    await waitFor(() => a.tree.view.badge?.value === 1, 'badge 1');
  });
});
