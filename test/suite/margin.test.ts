// Integration: the margin panel's reveal message, its box placement, the
// reverse link from the cursor, and its actions.
import * as assert from 'assert';
import * as fs from 'fs';
import * as vscode from 'vscode';
import type { MarginNotesApi } from '../../src/extension';
import { lineHeight, placeLine } from '../../src/marginPanel';
import { api, key, reset, samplePath, sleep, waitFor } from './helpers';

describe('placeLine and lineHeight', () => {
  it('places lines in, above and below the visible range', () => {
    const visible = [{ start: 10, end: 40 }];
    assert.deepStrictEqual(placeLine(5, visible), { where: 'above' });
    assert.deepStrictEqual(placeLine(10, visible), { where: 'visible', row: 0 });
    assert.deepStrictEqual(placeLine(25, visible), { where: 'visible', row: 15 });
    assert.deepStrictEqual(placeLine(41, visible), { where: 'below' });
  });

  it('accounts for folded regions', () => {
    // Lines 13-19 folded into line 12.
    const visible = [
      { start: 10, end: 12 },
      { start: 20, end: 40 },
    ];
    assert.deepStrictEqual(placeLine(12, visible), { where: 'visible', row: 2 });
    assert.deepStrictEqual(placeLine(15, visible), { where: 'visible', row: 2 }, 'hidden lines sit on the fold');
    assert.deepStrictEqual(placeLine(20, visible), { where: 'visible', row: 3 });
  });

  it('computes the line height as VS Code does', () => {
    assert.strictEqual(lineHeight(14, 0, 'win32'), 19);
    assert.strictEqual(lineHeight(12, 0, 'darwin'), 18);
    assert.strictEqual(lineHeight(14, 1.5, 'win32'), 21);
    assert.strictEqual(lineHeight(14, 22, 'linux'), 22);
  });
});

describe('Margin panel', function () {
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

  function create(startLine: number, endLine: number, startChar = 0) {
    const range = new vscode.Range(startLine, startChar, endLine, editor.document.lineAt(endLine).text.length);
    return a.actions.createThread(key(), editor.document, range, 'A note', 'bug');
  }

  async function openPanel() {
    a.panel.toggle();
    await waitFor(() => a.panel.received.some((m) => m.type === 'ready'), 'the webview to load');
  }

  /** Focus and selection reach the extension host a moment after they change: wait for them. */
  async function focusedAt(selection: vscode.Selection): Promise<vscode.TextEditor> {
    try {
      await waitFor(() => {
        const e = vscode.window.activeTextEditor;
        return e !== undefined && e.document.uri.fsPath === samplePath() && e.selection.isEqual(selection);
      }, `the source editor focused with selection ${JSON.stringify(selection)}`);
    } catch (err) {
      const e = vscode.window.activeTextEditor;
      const state = {
        active: e && { file: e.document.uri.fsPath, column: e.viewColumn, selection: e.selection },
        visible: vscode.window.visibleTextEditors.map((v) => ({ file: v.document.uri.fsPath, column: v.viewColumn, selection: v.selection })),
        tabs: vscode.window.tabGroups.all.map((g) => ({ column: g.viewColumn, active: g.isActive, tabs: g.tabs.map((t) => t.label) })),
        threads: a.model.all().map(({ thread }) => ({ id: thread.id.slice(0, 8), line: thread.anchor.startLine, orphaned: thread.orphaned })),
        received: a.panel.received.map((m) => m.type),
      };
      throw new Error(`${(err as Error).message}\nstate: ${JSON.stringify(state)}`);
    }
    return vscode.window.activeTextEditor!;
  }

  it('opens beside the editor and tracks it', async () => {
    await openPanel();
    assert.ok(a.panel.isOpen);
    assert.strictEqual(a.panel.trackedUri?.fsPath, editor.document.uri.fsPath);
    assert.strictEqual(a.panel.trackedColumn, vscode.ViewColumn.One);
  });

  it('a reveal message selects the anchor, shows it and flashes it', async () => {
    const t = create(150, 152, 4);
    await openPanel();
    // Focus is in the panel, as after a click there.
    a.panel.open(false);
    await waitFor(() => vscode.window.activeTextEditor === undefined, 'focus to move to the panel');
    await sleep(1600); // let earlier flashes end
    const flashing = a.decorations.flashing;
    await a.panel.onMessage({ type: 'reveal', threadId: t.id });
    // The selection equals the anchor.
    const active = await focusedAt(new vscode.Selection(150, 4, 152, editor.document.lineAt(152).text.length));
    assert.strictEqual(active.viewColumn, vscode.ViewColumn.One, 'in the column the panel tracks');
    await waitFor(
      () => active.visibleRanges.some((r) => r.start.line <= 150 && 152 <= r.end.line),
      'the anchor to be visible',
    );
    assert.strictEqual(a.decorations.flashing, flashing + 1, 'the flash is applied');
    assert.strictEqual(a.panel.active, t.id, 'the box is outlined');
    await sleep(1700);
    assert.strictEqual(a.decorations.flashing, flashing, 'and removed again');
  });

  it('does not scroll code that is already visible', async () => {
    const t = create(4, 4);
    const before = editor.visibleRanges[0].start.line;
    await openPanel();
    await a.panel.onMessage({ type: 'reveal', threadId: t.id });
    const active = await focusedAt(new vscode.Selection(4, 0, 4, editor.document.lineAt(4).text.length));
    assert.strictEqual(active.visibleRanges[0].start.line, before);
  });

  it('reopens a closed source file to reveal a box', async () => {
    const t = create(4, 4);
    await openPanel();
    const tab = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .find((t) => t.input instanceof vscode.TabInputText && t.input.uri.fsPath === samplePath());
    await vscode.window.tabGroups.close(tab!);
    await waitFor(() => !vscode.window.visibleTextEditors.some((e) => e.document.uri.fsPath === samplePath()), 'close');
    await a.panel.onMessage({ type: 'reveal', threadId: t.id });
    await focusedAt(new vscode.Selection(4, 0, 4, editor.document.lineAt(4).text.length));
  });

  it('shows the orphan warning instead of jumping', async () => {
    const t = create(4, 4);
    await editor.edit((e) => e.delete(new vscode.Range(4, 0, 5, 0)));
    assert.ok(t.orphaned);
    await openPanel();
    const warnings: string[] = [];
    const original = vscode.window.showWarningMessage;
    let patched = false;
    try {
      (vscode.window as { showWarningMessage: unknown }).showWarningMessage = (m: string) => {
        warnings.push(m);
        return Promise.resolve(undefined);
      };
      patched = vscode.window.showWarningMessage !== original;
    } catch {
      // The API object may be read-only: the other checks still hold.
    }
    // Flashes from earlier tests may still be fading.
    const flashing = a.decorations.flashing;
    try {
      await a.panel.onMessage({ type: 'reveal', threadId: t.id });
    } finally {
      if (patched) {
        (vscode.window as { showWarningMessage: unknown }).showWarningMessage = original;
      }
    }
    // The file opens at the last known line, with nothing uncertain selected.
    await focusedAt(new vscode.Selection(4, 0, 4, 0));
    assert.strictEqual(a.decorations.flashing, flashing, 'no flash');
    if (patched) {
      assert.deepStrictEqual(warnings, ['Code not found — Reattach?']);
    }
  });

  it('places boxes at their lines and counts those off-screen', async () => {
    create(4, 4);
    create(120, 120);
    create(190, 190);
    await openPanel();
    const top = editor.visibleRanges[0].start.line;
    assert.strictEqual(top, 0);
    let state = a.panel.state();
    assert.strictEqual(state.lineHeight, 20, 'from the fixture settings');
    assert.strictEqual(state.topOffset, 22, 'below the breadcrumbs');
    const [first, middle, last] = [...state.threads].sort((x, y) => x.startLine - y.startLine);
    assert.deepStrictEqual(first.placement, { where: 'visible', row: 4 });
    assert.deepStrictEqual(middle.placement, { where: 'below' });
    assert.deepStrictEqual(last.placement, { where: 'below' });

    editor.revealRange(new vscode.Range(120, 0, 120, 0), vscode.TextEditorRevealType.AtTop);
    await waitFor(() => editor.visibleRanges[0].start.line === 120, 'scroll');
    state = a.panel.state();
    const sorted = [...state.threads].sort((x, y) => x.startLine - y.startLine);
    assert.deepStrictEqual(sorted[0].placement, { where: 'above' });
    assert.deepStrictEqual(sorted[1].placement, { where: 'visible', row: 0 });
  });

  it('draws the boxes in the webview without script errors', async () => {
    create(4, 4);
    create(6, 6);
    const orphan = create(8, 8);
    a.actions.reply(orphan.id, 'Second comment');
    create(180, 180);
    orphan.orphaned = true;
    a.model.changed([key()], 'user');
    await openPanel();
    await waitFor(() => a.panel.received.some((m) => m.type === 'rendered'), 'a render');
    a.panel.render();
    await sleep(300);
    assert.deepStrictEqual(a.panel.received.filter((m) => m.type === 'error'), []);
    const rendered = a.panel.received.filter((m) => m.type === 'rendered').pop() as unknown as { boxes: number; orphans: number };
    assert.deepStrictEqual(rendered, { type: 'rendered', boxes: 2, orphans: 1 }, 'two boxes on screen, one orphan, one off-screen');
  });

  it('a marker click scrolls the editor to the next thread', async () => {
    create(170, 170);
    await openPanel();
    await a.panel.onMessage({ type: 'scrollTo', direction: 'down' });
    await waitFor(
      () => editor.visibleRanges.some((r) => r.start.line <= 170 && 170 <= r.end.line),
      'the editor to scroll to line 171',
    );
  });

  it('outlines the box whose code the cursor moves into', async () => {
    const t = create(10, 12);
    await openPanel();
    await vscode.window.showTextDocument(editor.document, vscode.ViewColumn.One);
    editor.selection = new vscode.Selection(11, 2, 11, 2);
    await waitFor(() => a.panel.active === t.id, 'the box to be active');
    editor.selection = new vscode.Selection(30, 0, 30, 0);
    await waitFor(() => a.panel.active === undefined, 'the outline to clear');
  });

  it('applies box actions to the single model', async () => {
    const t = create(10, 10);
    await openPanel();
    await a.panel.onMessage({ type: 'reply', threadId: t.id, body: 'From the margin' });
    assert.strictEqual(t.comments.length, 2);
    assert.strictEqual(a.native.native(t.id)!.comments.length, 2, 'the inline thread agrees');
    await a.panel.onMessage({ type: 'edit', commentId: t.comments[1].id, body: 'Edited in the margin' });
    assert.strictEqual(t.comments[1].body, 'Edited in the margin');
    await a.panel.onMessage({ type: 'setCategory', threadId: t.id, category: 'idea' });
    assert.strictEqual(t.category, 'idea');
    assert.strictEqual(a.native.native(t.id)!.label, 'Idea');
    await a.panel.onMessage({ type: 'setStatus', threadId: t.id, status: 'resolved' });
    assert.strictEqual(a.native.native(t.id)!.state, vscode.CommentThreadState.Resolved);
    await a.panel.onMessage({ type: 'deleteComment', commentId: t.comments[1].id });
    assert.strictEqual(t.comments.length, 1);
    // A reveal never comes from an action: the panel's selection is untouched by them.
    assert.strictEqual(a.decorations.flashing, 0);
  });
});
