// The shared reveal-and-flash routine used by the margin panel and the
// sidebar: bring the code into view, select it, focus the editor and flash it.
import * as vscode from 'vscode';
import { NativeComments } from './commentController';
import * as config from './config';
import { Decorations } from './decorations';
import { uriFor } from './documents';
import { CommentModel } from './model';

export interface RevealTarget {
  /** The column to show the code in: the editor group the panel is tracking. */
  viewColumn?: vscode.ViewColumn;
}

export interface RevealDeps {
  model: CommentModel;
  native: NativeComments;
  decorations: Decorations;
  /** Called with the thread revealed, so the margin outlines its box. */
  onRevealed?: (threadId: string, editor: vscode.TextEditor) => void;
  /** Starts reattaching an orphaned thread. */
  reattach: (threadId: string) => Promise<void>;
  /** The column a closed file was last shown in, to reopen it there. */
  lastColumn?: (uri: vscode.Uri) => vscode.ViewColumn | undefined;
}

export const ORPHAN_WARNING = 'Code not found — Reattach?';
export const REATTACH_ACTION = 'Reattach to Selection';

export async function revealThread(
  deps: RevealDeps,
  threadId: string,
  target: RevealTarget = {},
): Promise<vscode.TextEditor | undefined> {
  const found = deps.model.find(threadId);
  if (!found) {
    return undefined;
  }
  const { key, thread } = found;
  const doc = await vscode.workspace.openTextDocument(uriFor(key));
  const viewColumn =
    target.viewColumn ?? columnShowing(doc.uri) ?? deps.lastColumn?.(doc.uri) ?? vscode.ViewColumn.One;

  if (thread.orphaned) {
    // Don't jump to an uncertain place: open the file at the last known line and ask.
    const line = Math.min(thread.anchor.startLine, Math.max(0, doc.lineCount - 1));
    const at = new vscode.Range(line, 0, line, 0);
    const editor = await vscode.window.showTextDocument(doc, { viewColumn, selection: at, preserveFocus: false });
    editor.revealRange(at, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    void vscode.window
      .showWarningMessage(ORPHAN_WARNING, REATTACH_ACTION)
      .then((choice) => {
        if (choice === REATTACH_ACTION) {
          return deps.reattach(threadId);
        }
      });
    return editor;
  }

  const range = new vscode.Range(
    thread.anchor.startLine,
    thread.anchor.startChar,
    thread.anchor.endLine,
    thread.anchor.endChar,
  );
  const editor = await vscode.window.showTextDocument(doc, {
    viewColumn,
    selection: range,
    preserveFocus: false,
  });
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  // revealRange unfolds folded code; if the line is still hidden, unfold it.
  const line = range.start.line;
  if (!editor.visibleRanges.some((r) => r.start.line <= line && line <= r.end.line)) {
    await vscode.commands.executeCommand('editor.unfold', { selectionLines: [line], levels: 1 });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
  deps.decorations.flash(editor, thread);
  if (config.expandInlineOnReveal()) {
    deps.native.expand(threadId);
  }
  deps.onRevealed?.(threadId, editor);
  return editor;
}

/** The column of a visible editor showing a file, if any. */
function columnShowing(uri: vscode.Uri): vscode.ViewColumn | undefined {
  return vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString())?.viewColumn;
}
