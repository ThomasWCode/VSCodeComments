// Display layer B: the Word-style margin panel, a webview beside the editor
// whose boxes line up with the commented lines.
import * as vscode from 'vscode';
import * as config from './config';
import { keyFor } from './documents';
import { CommentModel, ThreadStatus } from './model';

/** What the panel's buttons do; implemented once in extension.ts for both display layers. */
export interface PanelActions {
  reveal(threadId: string, viewColumn: vscode.ViewColumn | undefined): Promise<void>;
  reply(threadId: string, body: string): void;
  editComment(commentId: string, body: string): void;
  deleteComment(commentId: string): void;
  deleteThread(threadId: string): Promise<void>;
  setStatus(threadId: string, status: ThreadStatus): void;
  setCategory(threadId: string, category: string): void;
  reattach(threadId: string): Promise<void>;
}

/** Where a line is drawn: its visual row in the editor's viewport, or off-screen. */
export type Placement = { where: 'above' } | { where: 'below' } | { where: 'visible'; row: number };

/**
 * Maps a line to its visual row from the editor's visible ranges. Folded
 * regions split the visible ranges, so lines hidden in a fold take the row of
 * the fold's first line, and lines after it move up.
 */
export function placeLine(line: number, visible: readonly { start: number; end: number }[]): Placement {
  if (visible.length === 0 || line < visible[0].start) {
    return { where: 'above' };
  }
  if (line > visible[visible.length - 1].end) {
    return { where: 'below' };
  }
  let row = 0;
  for (let i = 0; i < visible.length; i++) {
    const r = visible[i];
    if (line >= r.start && line <= r.end) {
      return { where: 'visible', row: row + (line - r.start) };
    }
    const next = visible[i + 1];
    if (next && line > r.end && line < next.start) {
      return { where: 'visible', row: row + (r.end - r.start) };
    }
    row += r.end - r.start + 1;
  }
  return { where: 'below' };
}

/** The editor's line height in pixels, as VS Code computes it. */
export function lineHeight(fontSize: number, setting: number, platform: string = process.platform): number {
  const size = fontSize > 0 ? fontSize : platform === 'darwin' ? 12 : 14;
  if (setting <= 0) {
    // VS Code's automatic line height: the golden ratio for the platform.
    return Math.round(size * (platform === 'darwin' ? 1.5 : 1.35));
  }
  if (setting < 8) {
    // Small values are a multiplier of the font size.
    return Math.round(size * setting);
  }
  return Math.round(setting);
}

interface Tracked {
  uri: vscode.Uri;
  viewColumn: vscode.ViewColumn | undefined;
}

export class MarginPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private tracked: Tracked | undefined;
  private activeThreadId: string | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private renderTimer: NodeJS.Timeout | undefined;
  /** Messages the webview has sent, newest last (for tests). */
  readonly received: { type: string }[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly model: CommentModel,
    private readonly actions: PanelActions,
  ) {
    this.track(vscode.window.activeTextEditor);
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((e) => {
        if (e && this.track(e)) {
          this.maybeAutoOpen(e);
          this.render();
        }
      }),
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
        if (this.isTracked(e.textEditor)) {
          this.render();
        }
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (this.isTracked(e.textEditor)) {
          this.followCursor(e.textEditor);
        }
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.tracked && e.document.uri.toString() === this.tracked.uri.toString()) {
          this.scheduleRender();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('editor') || e.affectsConfiguration('breadcrumbs') || e.affectsConfiguration('marginNotes')) {
          this.render();
        }
      }),
    );
  }

  dispose(): void {
    this.panel?.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  get isOpen(): boolean {
    return this.panel !== undefined;
  }

  get trackedUri(): vscode.Uri | undefined {
    return this.tracked?.uri;
  }

  get trackedColumn(): vscode.ViewColumn | undefined {
    return this.tracked?.viewColumn;
  }

  get active(): string | undefined {
    return this.activeThreadId;
  }

  /** Follows a text editor; editors outside the workspace and focus moving to the panel keep the last one. */
  private track(editor: vscode.TextEditor | undefined): boolean {
    if (!editor || !keyFor(editor.document.uri)) {
      return false;
    }
    const changed =
      !this.tracked ||
      this.tracked.uri.toString() !== editor.document.uri.toString() ||
      this.tracked.viewColumn !== editor.viewColumn;
    this.tracked = { uri: editor.document.uri, viewColumn: editor.viewColumn };
    if (changed) {
      this.activeThreadId = undefined;
    }
    return true;
  }

  private isTracked(editor: vscode.TextEditor): boolean {
    if (!this.tracked || editor.document.uri.toString() !== this.tracked.uri.toString()) {
      return false;
    }
    return this.tracked.viewColumn === undefined || editor.viewColumn === this.tracked.viewColumn;
  }

  private trackedEditor(): vscode.TextEditor | undefined {
    const editors = vscode.window.visibleTextEditors.filter(
      (e) => this.tracked && e.document.uri.toString() === this.tracked.uri.toString(),
    );
    return editors.find((e) => e.viewColumn === this.tracked?.viewColumn) ?? editors[0];
  }

  /** Opens the panel for the active editor when autoOpenMargin asks for it (after the first load, too). */
  checkAutoOpen(): void {
    const editor = vscode.window.activeTextEditor;
    if (editor && this.track(editor)) {
      this.maybeAutoOpen(editor);
    }
  }

  private maybeAutoOpen(editor: vscode.TextEditor): void {
    if (this.panel || !config.autoOpenMargin()) {
      return;
    }
    const key = keyFor(editor.document.uri);
    if (key && this.model.threads(key).length > 0) {
      this.open(true);
    }
  }

  toggle(): void {
    if (this.panel) {
      this.panel.dispose();
    } else {
      this.open(false);
    }
  }

  open(preserveFocus: boolean): void {
    if (this.panel) {
      this.panel.reveal(undefined, preserveFocus);
      return;
    }
    this.track(vscode.window.activeTextEditor);
    this.received.length = 0;
    const media = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    this.panel = vscode.window.createWebviewPanel(
      'marginNotes.margin',
      'Margin Notes',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus },
      { enableScripts: true, localResourceRoots: [media] },
    );
    this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'notes.svg');
    this.panel.webview.html = this.html(this.panel.webview, media);
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
    this.panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.visible) {
        this.render();
      }
    });
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = [...Array(32)].map(() => Math.floor(Math.random() * 36).toString(36)).join('');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'margin.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'margin.js'));
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}">
<title>Margin Notes</title>
</head>
<body>
<div id="header"></div>
<button id="above" class="marker" hidden></button>
<div id="lane"><svg id="connectors" aria-hidden="true"></svg></div>
<button id="below" class="marker" hidden></button>
<div id="orphans"></div>
<div id="empty" hidden>No comments in this file.<br>Click the + beside a line number to add one.</div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  private scheduleRender(): void {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
    }
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.render();
    }, 50);
  }

  /** Sends the tracked editor's threads and their positions to the webview. */
  render(): void {
    if (!this.panel || !this.panel.visible) {
      return;
    }
    void this.panel.webview.postMessage(this.state());
  }

  /** What the webview draws (exposed for tests). */
  state() {
    const editor = this.trackedEditor();
    const key = this.tracked ? keyFor(this.tracked.uri) : undefined;
    const showResolved = config.showResolved();
    const threads = key ? this.model.threads(key).filter((t) => showResolved || t.status === 'open') : [];
    const visible = (editor?.visibleRanges ?? []).map((r) => ({ start: r.start.line, end: r.end.line }));
    const editorConfig = vscode.workspace.getConfiguration('editor', editor?.document);
    const height = lineHeight(editorConfig.get<number>('fontSize') ?? 14, editorConfig.get<number>('lineHeight') ?? 0);
    const breadcrumbs = vscode.workspace.getConfiguration('breadcrumbs').get<boolean>('enabled') !== false;
    const padding = editorConfig.get<{ top?: number }>('padding')?.top ?? 0;
    const categories = config.categories();
    return {
      type: 'render' as const,
      file: key?.rel ?? '',
      lineHeight: height,
      // The editor's text starts below its breadcrumbs bar (22px), which the panel doesn't have.
      topOffset: (breadcrumbs ? 22 : 0) + padding,
      activeId: this.activeThreadId,
      categories,
      threads: threads.map((t) => {
        const cat = config.category(t.category);
        return {
          id: t.id,
          category: t.category,
          colour: cat.colour,
          categoryLabel: cat.label,
          status: t.status,
          orphaned: t.orphaned,
          startLine: t.anchor.startLine,
          endLine: t.anchor.endLine,
          snippet: t.orphaned ? t.anchor.text : '',
          placement: t.orphaned ? ({ where: 'below' } as Placement) : placeLine(t.anchor.startLine, visible),
          comments: t.comments.map((c) => ({
            id: c.id,
            body: c.body,
            created: new Date(c.created).toLocaleString(),
            edited: c.edited ? new Date(c.edited).toLocaleString() : null,
          })),
        };
      }),
    };
  }

  /** Outlines a box as active and scrolls it into view (after a reveal, or the cursor entering its code). */
  setActive(threadId: string | undefined): void {
    this.activeThreadId = threadId;
    if (this.panel?.visible) {
      void this.panel.webview.postMessage({ type: 'active', threadId });
    }
  }

  private followCursor(editor: vscode.TextEditor): void {
    const key = keyFor(editor.document.uri);
    if (!key) {
      return;
    }
    const line = editor.selection.active.line;
    const threads = this.model.threads(key).filter((t) => !t.orphaned);
    const current = this.activeThreadId ? threads.find((t) => t.id === this.activeThreadId) : undefined;
    if (current && line >= current.anchor.startLine && line <= current.anchor.endLine) {
      return;
    }
    const inside = threads.find((t) => line >= t.anchor.startLine && line <= t.anchor.endLine);
    if (inside?.id !== this.activeThreadId) {
      this.setActive(inside?.id);
    }
  }

  /** The tracked editor scrolled to the nearest thread above or below its viewport. */
  private scrollTo(direction: 'up' | 'down'): void {
    const editor = this.trackedEditor();
    const key = this.tracked ? keyFor(this.tracked.uri) : undefined;
    if (!editor || !key || editor.visibleRanges.length === 0) {
      return;
    }
    const first = editor.visibleRanges[0].start.line;
    const last = editor.visibleRanges[editor.visibleRanges.length - 1].end.line;
    const showResolved = config.showResolved();
    const lines = this.model
      .threads(key)
      .filter((t) => !t.orphaned && (showResolved || t.status === 'open'))
      .map((t) => t.anchor.startLine);
    const target =
      direction === 'up'
        ? Math.max(...lines.filter((l) => l < first))
        : Math.min(...lines.filter((l) => l > last));
    if (Number.isFinite(target)) {
      editor.revealRange(new vscode.Range(target, 0, target, 0), vscode.TextEditorRevealType.InCenter);
    }
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  async onMessage(m: any): Promise<void> {
    if (!m || typeof m.type !== 'string') {
      return;
    }
    this.received.push(m);
    switch (m.type) {
      case 'ready':
        this.render();
        break;
      case 'reveal':
        this.activeThreadId = m.threadId;
        await this.actions.reveal(m.threadId, this.tracked?.viewColumn);
        break;
      case 'scrollTo':
        this.scrollTo(m.direction === 'up' ? 'up' : 'down');
        break;
      case 'reply':
        if (typeof m.body === 'string' && m.body.trim() !== '') {
          this.actions.reply(m.threadId, m.body);
        }
        break;
      case 'edit':
        if (typeof m.body === 'string' && m.body.trim() !== '') {
          this.actions.editComment(m.commentId, m.body);
        }
        break;
      case 'deleteComment':
        this.actions.deleteComment(m.commentId);
        break;
      case 'deleteThread':
        await this.actions.deleteThread(m.threadId);
        break;
      case 'setStatus':
        this.actions.setStatus(m.threadId, m.status === 'resolved' ? 'resolved' : 'open');
        break;
      case 'setCategory':
        if (typeof m.category === 'string') {
          this.actions.setCategory(m.threadId, m.category);
        }
        break;
      case 'reattach':
        await this.actions.reattach(m.threadId);
        break;
    }
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
