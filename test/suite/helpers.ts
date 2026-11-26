// Shared set-up for the integration suites, which run inside a downloaded VS Code.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { MarginNotesApi } from '../../src/extension';

/** A 200-line Python file, so there is room to scroll and fold. */
export const SAMPLE = [
  'import os',
  '',
  'def load(path):',
  '    with open(path) as f:',
  '        data = f.read()',
  '    return data',
  '',
  ...Array.from({ length: 190 }, (_, i) => `value_${i} = ${i}`),
  '',
  'def save(path, data):',
  '    pass',
].join('\n') + '\n';

export function workspaceRoot(): string {
  return vscode.workspace.workspaceFolders![0].uri.fsPath;
}

export function samplePath(): string {
  return path.join(workspaceRoot(), 'sample.py');
}

export async function api(): Promise<MarginNotesApi> {
  const ext = vscode.extensions.getExtension<MarginNotesApi>('thomaswcode.margin-notes');
  assert(ext, 'extension not found');
  const a = await ext.activate();
  await a.ready;
  return a;
}

function assert(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

/** Removes every comment, restores sample.py and opens it in the first column. */
export async function reset(a: MarginNotesApi): Promise<vscode.TextEditor> {
  for (const { thread } of a.model.all()) {
    a.model.removeThread(thread.id);
  }
  await a.store.flush();
  if (a.panel.isOpen) {
    a.panel.toggle();
  }
  // A test can leave unsaved edits: VS Code won't reload a dirty document
  // from disk, so revert those first.
  for (const d of vscode.workspace.textDocuments.filter((t) => t.isDirty && t.uri.scheme === 'file')) {
    await vscode.window.showTextDocument(d);
    await vscode.commands.executeCommand('workbench.action.files.revert');
  }
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  fs.writeFileSync(samplePath(), SAMPLE);
  const doc = await vscode.workspace.openTextDocument(samplePath());
  // VS Code may not have noticed the rewrite yet.
  await waitFor(() => !doc.isDirty && doc.getText() === SAMPLE, 'sample.py reloaded');
  const editor = await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.One,
    selection: new vscode.Range(0, 0, 0, 0),
  });
  // VS Code restores the last scroll position of a reopened file: start each test at the top.
  editor.revealRange(new vscode.Range(0, 0, 0, 0), vscode.TextEditorRevealType.AtTop);
  await waitFor(() => editor.visibleRanges[0]?.start.line === 0, 'scroll to the top');
  return editor;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor(check: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(50);
  }
}

export function sidecar(): string {
  return path.join(workspaceRoot(), '.codecomments', 'sample.py.json');
}

export function key() {
  return { root: workspaceRoot(), rel: 'sample.py' };
}
