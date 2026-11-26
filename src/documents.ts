// Keeps anchors attached to their code: live shifting on edits in VS Code,
// re-anchoring when a document opens or is reloaded from disk, and fresh
// anchor text when a document is saved.
import { promises as fsp } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { makeAnchor, reanchor, refreshAnchor, shiftAnchor, splitLines } from './anchor';
import * as config from './config';
import { Anchor, CommentModel, FileKey, keyString, NoteThread } from './model';

/** The model key of a document: its workspace folder and path within it. Files outside the workspace have none. */
export function keyFor(uri: vscode.Uri): FileKey | undefined {
  if (uri.scheme !== 'file') {
    return undefined;
  }
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder || folder.uri.scheme !== 'file') {
    return undefined;
  }
  const rel = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
  if (rel === '' || rel.startsWith('..')) {
    return undefined;
  }
  // Sidecar files themselves can't be commented on.
  const storage = config.storageFolder().split(/[\\/]/).join('/');
  if (rel === storage || rel.startsWith(storage + '/')) {
    return undefined;
  }
  return { root: folder.uri.fsPath, rel };
}

export function uriFor(key: FileKey): vscode.Uri {
  return vscode.Uri.file(path.join(key.root, ...key.rel.split('/')));
}

export function documentLines(doc: vscode.TextDocument): string[] {
  return splitLines(doc.getText());
}

/** An open document of a key, if any. */
export function openDocument(key: FileKey): vscode.TextDocument | undefined {
  const k = keyString(key);
  return vscode.workspace.textDocuments.find((d) => {
    const dk = keyFor(d.uri);
    return dk !== undefined && keyString(dk) === k;
  });
}

export class DocumentTracker implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly model: CommentModel) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.onChange(e)),
      vscode.workspace.onDidOpenTextDocument((d) => this.reanchorDocument(d)),
      vscode.workspace.onDidSaveTextDocument((d) => this.onSave(d)),
    );
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private onChange(e: vscode.TextDocumentChangeEvent): void {
    if (e.contentChanges.length === 0) {
      return;
    }
    const key = keyFor(e.document.uri);
    if (!key) {
      return;
    }
    const threads = this.model.threads(key);
    if (threads.length === 0) {
      return;
    }
    let changed = false;
    // Threads a change deleted or cut across: if the change turns out to be a
    // reload from disk, these are re-anchored by text from where they were.
    const suspects: { thread: NoteThread; before: Anchor }[] = [];
    for (const thread of threads) {
      if (thread.orphaned) {
        continue;
      }
      const before = { ...thread.anchor };
      let suspect = false;
      for (const change of e.contentChanges) {
        const result = shiftAnchor(thread.anchor, {
          startLine: change.range.start.line,
          startChar: change.range.start.character,
          endLine: change.range.end.line,
          endChar: change.range.end.character,
          text: change.text,
        });
        if (result.kind === 'deleted') {
          thread.orphaned = true;
          suspect = true;
          changed = true;
          break;
        }
        if (result.kind !== 'unchanged') {
          Object.assign(thread.anchor, result.range);
          suspect = suspect || (result.kind === 'edited' && result.partial === true);
          changed = true;
        }
      }
      if (suspect) {
        suspects.push({ thread, before });
      }
    }
    // isDirty can lag behind the first edit after a save, so it only decides
    // whether to look; checkReload compares the text with the disk.
    if (e.reason === undefined && (suspects.length > 0 || !e.document.isDirty)) {
      void this.checkReload(e.document, e.document.version, key, suspects);
    }
    if (e.reason === vscode.TextDocumentChangeReason.Undo || e.reason === vscode.TextDocumentChangeReason.Redo) {
      // Undoing a deletion brings the code back: reattach its threads when the
      // exact text is found again.
      changed = this.reattachExact(e.document, key) || changed;
    }
    if (changed) {
      // Positions now describe the unsaved text; they are written with the
      // text itself when the document is saved.
      this.model.changed([key], 'edit', false);
    }
  }

  /**
   * A reload from disk (git checkout, another editor) arrives as ordinary
   * content changes, often one large replacement that swallows or cuts across
   * anchors. When the document now matches the file on disk, the change was a
   * reload: the suspect threads are re-anchored by their text from where they
   * were, and every other thread's stored text is brought up to date (its
   * position was already moved exactly).
   */
  private async checkReload(
    doc: vscode.TextDocument,
    version: number,
    key: FileKey,
    suspects: { thread: NoteThread; before: Anchor }[],
  ): Promise<void> {
    let disk: string;
    try {
      disk = await fsp.readFile(doc.uri.fsPath, 'utf8');
    } catch {
      return;
    }
    if (doc.isClosed || doc.version !== version || doc.isDirty || splitLines(disk).join('\n') !== documentLines(doc).join('\n')) {
      return;
    }
    const lines = documentLines(doc);
    const contextLines = config.contextLines();
    const suspectIds = new Set<string>();
    for (const { thread, before } of suspects) {
      if (!this.model.find(thread.id)) {
        continue;
      }
      suspectIds.add(thread.id);
      const result = reanchor(before, lines, contextLines);
      if (result.kind === 'orphaned') {
        thread.orphaned = true;
      } else {
        thread.anchor = result.anchor;
        thread.orphaned = false;
      }
    }
    for (const thread of this.model.threads(key)) {
      if (!thread.orphaned && !suspectIds.has(thread.id)) {
        thread.anchor = refreshAnchor(thread.anchor, lines, contextLines);
      }
    }
    this.model.changed([key], 'reanchor', true);
  }

  private reattachExact(doc: vscode.TextDocument, key: FileKey): boolean {
    const lines = documentLines(doc);
    let changed = false;
    for (const thread of this.model.threads(key)) {
      if (!thread.orphaned) {
        continue;
      }
      const result = reanchor(thread.anchor, lines, config.contextLines());
      if (result.kind === 'exact' || result.kind === 'moved') {
        thread.anchor = result.anchor;
        thread.orphaned = false;
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Checks every thread of a document against its current text: attached
   * threads are re-anchored (exact, moved, fuzzy or orphaned); orphaned ones
   * are reattached only on an exact match.
   */
  reanchorDocument(doc: vscode.TextDocument): void {
    const key = keyFor(doc.uri);
    if (!key) {
      return;
    }
    const threads = this.model.threads(key);
    if (threads.length === 0) {
      return;
    }
    const lines = documentLines(doc);
    const contextLines = config.contextLines();
    let changed = false;
    for (const thread of threads) {
      const result = reanchor(thread.anchor, lines, contextLines);
      if (result.kind === 'orphaned') {
        if (!thread.orphaned) {
          thread.orphaned = true;
          changed = true;
        }
        continue;
      }
      if (thread.orphaned && result.kind === 'fuzzy') {
        continue;
      }
      if (thread.orphaned || !sameAnchor(thread.anchor, result.anchor)) {
        thread.anchor = result.anchor;
        thread.orphaned = false;
        changed = true;
      }
    }
    if (changed) {
      this.model.changed([key], 'reanchor', !doc.isDirty);
    }
  }

  private onSave(doc: vscode.TextDocument): void {
    const key = keyFor(doc.uri);
    if (!key) {
      return;
    }
    const threads = this.model.threads(key);
    if (threads.length === 0) {
      return;
    }
    const lines = documentLines(doc);
    const contextLines = config.contextLines();
    for (const thread of threads) {
      if (!thread.orphaned) {
        thread.anchor = refreshAnchor(thread.anchor, lines, contextLines);
      }
    }
    this.model.changed([key], 'edit', true);
  }

  /** A new anchor for a range of a document, with its text, context and hash. */
  anchorFor(doc: vscode.TextDocument, range: vscode.Range) {
    return makeAnchor(
      documentLines(doc),
      {
        startLine: range.start.line,
        startChar: range.start.character,
        endLine: range.end.line,
        endChar: range.end.character,
      },
      config.contextLines(),
    );
  }
}

function sameAnchor(a: { startLine: number; startChar: number; endLine: number; endChar: number; text: string; before: string; after: string }, b: typeof a): boolean {
  return (
    a.startLine === b.startLine &&
    a.startChar === b.startChar &&
    a.endLine === b.endLine &&
    a.endChar === b.endChar &&
    a.text === b.text &&
    a.before === b.before &&
    a.after === b.after
  );
}
