// The sidebar overview: every thread in the workspace, grouped by file, with filters.
import * as vscode from 'vscode';
import * as config from './config';
import { uriFor } from './documents';
import { CommentModel, FileKey, keyString, NoteThread } from './model';

export interface TreeFilter {
  /** Category ids shown; null shows all, including categories added later. */
  categories: string[] | null;
  open: boolean;
  resolved: boolean;
  attached: boolean;
  orphaned: boolean;
}

export const ALL: TreeFilter = { categories: null, open: true, resolved: true, attached: true, orphaned: true };
const FILTER_STATE = 'marginNotes.treeFilter';

type Node = { kind: 'file'; key: FileKey } | { kind: 'thread'; key: FileKey; thread: NoteThread };

export function passes(filter: TreeFilter, thread: NoteThread): boolean {
  if (filter.categories && !filter.categories.includes(thread.category)) {
    return false;
  }
  if (thread.status === 'open' ? !filter.open : !filter.resolved) {
    return false;
  }
  return thread.orphaned ? filter.orphaned : filter.attached;
}

/** A thread's first comment line, for labels. */
export function firstLine(thread: NoteThread): string {
  const text = thread.comments[0]?.body ?? '';
  const line = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '(empty)';
  return line.length > 80 ? line.slice(0, 79) + '…' : line;
}

export class OverviewTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  readonly view: vscode.TreeView<Node>;
  private readonly emitter = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  filter: TreeFilter;

  constructor(
    private readonly model: CommentModel,
    private readonly state: vscode.Memento,
  ) {
    this.filter = { ...ALL, ...state.get<TreeFilter>(FILTER_STATE, ALL) };
    this.view = vscode.window.createTreeView('marginNotes.overview', { treeDataProvider: this, showCollapseAll: true });
    this.refresh();
  }

  dispose(): void {
    this.view.dispose();
    this.emitter.dispose();
  }

  refresh(): void {
    this.emitter.fire();
    const open = this.model.all().filter(({ thread }) => thread.status === 'open').length;
    this.view.badge = open > 0 ? { value: open, tooltip: `${open} open comment thread${open === 1 ? '' : 's'}` } : undefined;
    this.view.description = this.isFiltered() ? 'filtered' : undefined;
  }

  isFiltered(): boolean {
    const f = this.filter;
    return f.categories !== null || !f.open || !f.resolved || !f.attached || !f.orphaned;
  }

  async setFilter(filter: TreeFilter): Promise<void> {
    this.filter = filter;
    await this.state.update(FILTER_STATE, filter);
    this.refresh();
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return this.model
        .keys()
        .filter((key) => this.model.threads(key).some((t) => passes(this.filter, t)))
        .sort((a, b) => fileLabel(a).localeCompare(fileLabel(b)))
        .map((key) => ({ kind: 'file', key }));
    }
    if (node.kind === 'file') {
      return this.model
        .threads(node.key)
        .filter((t) => passes(this.filter, t))
        .sort((a, b) => a.anchor.startLine - b.anchor.startLine)
        .map((thread) => ({ kind: 'thread', key: node.key, thread }));
    }
    return [];
  }

  getParent(node: Node): Node | undefined {
    return node.kind === 'thread' ? { kind: 'file', key: node.key } : undefined;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'file') {
      const item = new vscode.TreeItem(fileLabel(node.key), vscode.TreeItemCollapsibleState.Expanded);
      item.id = 'file:' + keyString(node.key);
      item.resourceUri = uriFor(node.key);
      item.description = String(this.model.threads(node.key).filter((t) => passes(this.filter, t)).length);
      item.contextValue = 'file';
      return item;
    }
    const t = node.thread;
    const cat = config.category(t.category);
    const item = new vscode.TreeItem(firstLine(t), vscode.TreeItemCollapsibleState.None);
    item.id = 'thread:' + t.id;
    const where = t.orphaned ? `orphaned, last at L${t.anchor.startLine + 1}` : `L${t.anchor.startLine + 1}`;
    item.description = `${cat.label} · ${t.status} · ${where}`;
    item.iconPath = new vscode.ThemeIcon(
      t.orphaned ? 'warning' : t.status === 'resolved' ? 'pass' : 'comment',
      t.orphaned ? new vscode.ThemeColor('list.warningForeground') : undefined,
    );
    item.tooltip = tooltip(t, cat.label);
    item.contextValue = `thread ${t.status} ${t.orphaned ? 'orphaned' : 'attached'}`;
    item.command = { command: 'marginNotes.revealThread', title: 'Go to Comment', arguments: [t.id] };
    return item;
  }

  /** Asks which categories and states to show. */
  async pickFilter(): Promise<void> {
    type Pick = vscode.QuickPickItem & { apply: (f: TreeFilter) => void };
    const cats = config.categories();
    const f = this.filter;
    const items: Pick[] = [
      { label: 'Categories', kind: vscode.QuickPickItemKind.Separator, apply: () => undefined },
      ...cats.map((c) => ({
        label: c.label,
        description: c.id,
        picked: f.categories === null || f.categories.includes(c.id),
        apply: (n: TreeFilter) => n.categories!.push(c.id),
      })),
      { label: 'Status', kind: vscode.QuickPickItemKind.Separator, apply: () => undefined },
      { label: 'Open', picked: f.open, apply: (n) => (n.open = true) },
      { label: 'Resolved', picked: f.resolved, apply: (n) => (n.resolved = true) },
      { label: 'Anchoring', kind: vscode.QuickPickItemKind.Separator, apply: () => undefined },
      { label: 'Attached', picked: f.attached, apply: (n) => (n.attached = true) },
      { label: 'Orphaned', picked: f.orphaned, apply: (n) => (n.orphaned = true) },
    ];
    const chosen = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: 'Show comments that are…',
    });
    if (!chosen) {
      return;
    }
    const next: TreeFilter = { categories: [], open: false, resolved: false, attached: false, orphaned: false };
    for (const c of chosen) {
      c.apply(next);
    }
    if (next.categories!.length === cats.length) {
      next.categories = null;
    }
    await this.setFilter(next);
  }
}

function fileLabel(key: FileKey): string {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length > 1) {
    const folder = folders.find((f) => f.uri.fsPath === key.root);
    return `${folder?.name ?? key.root}/${key.rel}`;
  }
  return key.rel;
}

function tooltip(t: NoteThread, categoryLabel: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${categoryLabel}** · ${t.status}${t.orphaned ? ' · **orphaned**' : ''}\n\n`);
  if (t.orphaned) {
    md.appendMarkdown('Last known code:\n');
    md.appendCodeblock(t.anchor.text || '(blank line)');
  }
  for (const c of t.comments) {
    md.appendMarkdown(`---\n\n*${new Date(c.created).toLocaleString()}${c.edited ? ' (edited)' : ''}*\n\n`);
    md.appendText(c.body);
    md.appendMarkdown('\n\n');
  }
  return md;
}
