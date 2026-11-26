// Markdown and standalone HTML export of comment threads.
import * as vscode from 'vscode';
import * as config from './config';
import { documentLines, keyFor, uriFor } from './documents';
import { CommentModel, FileKey, NoteThread } from './model';

export interface ExportEntry {
  /** File path shown, relative to its workspace folder. */
  file: string;
  /** Language id for the code fence. */
  language: string;
  thread: NoteThread;
  /** The anchored lines as they are now (the last known text for orphans). */
  snippet: string;
  categoryLabel: string;
  colour: string;
}

export function lineLabel(thread: NoteThread): string {
  const a = thread.anchor;
  return a.startLine === a.endLine ? `L${a.startLine + 1}` : `L${a.startLine + 1}–L${a.endLine + 1}`;
}

/** A backtick fence longer than any run of backticks in the code. */
function fence(code: string): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((r) => r.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

function stamp(iso: string): string {
  return iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

export function toMarkdown(entries: ExportEntry[], title: string): string {
  const out: string[] = [`# ${title}`, ''];
  let file = '';
  for (const e of entries) {
    if (e.file !== file) {
      file = e.file;
      out.push(`## ${file}`, '');
    }
    const t = e.thread;
    out.push(`### ${lineLabel(t)} · ${e.categoryLabel} · ${t.status}${t.orphaned ? ' · orphaned' : ''}`, '');
    const f = fence(e.snippet);
    out.push(f + e.language, e.snippet, f, '');
    for (const c of t.comments) {
      out.push(`**${stamp(c.created)}**${c.edited ? ` (edited ${stamp(c.edited)})` : ''}`, '');
      out.push(c.body, '');
    }
  }
  if (entries.length === 0) {
    out.push('No comments.', '');
  }
  return out.join('\n');
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A standalone page: inline CSS, no scripts, no external assets. */
export function toHtml(entries: ExportEntry[], title: string): string {
  const parts: string[] = [];
  let file = '';
  for (const e of entries) {
    if (e.file !== file) {
      if (file !== '') {
        parts.push('</section>');
      }
      file = e.file;
      parts.push(`<section><h2>${esc(file)}</h2>`);
    }
    const t = e.thread;
    const colour = config.parseHex(e.colour) ? e.colour : '#888888';
    parts.push(
      `<article class="thread ${t.status}${t.orphaned ? ' orphaned' : ''}">`,
      `<h3>${esc(lineLabel(t))} <span class="tag" style="background:${esc(colour)}">${esc(e.categoryLabel)}</span> <span class="status">${esc(t.status)}${t.orphaned ? ' · orphaned' : ''}</span></h3>`,
      `<pre><code class="language-${esc(e.language)}">${esc(e.snippet)}</code></pre>`,
    );
    for (const c of t.comments) {
      parts.push(
        `<div class="comment"><div class="when">${esc(stamp(c.created))}${c.edited ? ` (edited ${esc(stamp(c.edited))})` : ''}</div><div class="body">${esc(c.body)}</div></div>`,
      );
    }
    parts.push('</article>');
  }
  if (file !== '') {
    parts.push('</section>');
  }
  if (entries.length === 0) {
    parts.push('<p>No comments.</p>');
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
body { font: 15px/1.5 system-ui, sans-serif; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; color: #1f2328; background: #fff; }
h1 { font-size: 1.6rem; } h2 { font-size: 1.2rem; border-bottom: 1px solid #d0d7de; padding-bottom: .3rem; margin-top: 2rem; }
h3 { font-size: 1rem; margin: 0 0 .5rem; }
.thread { border: 1px solid #d0d7de; border-radius: 6px; padding: .75rem 1rem; margin: 1rem 0; }
.thread.resolved { opacity: .7; }
.tag { color: #fff; border-radius: 3px; padding: 0 .4rem; font-size: .8rem; }
.status { color: #59636e; font-weight: normal; font-size: .85rem; }
pre { background: #f6f8fa; padding: .6rem; border-radius: 4px; overflow-x: auto; font: 13px/1.4 ui-monospace, monospace; }
.comment { border-top: 1px solid #eaeef2; padding-top: .4rem; margin-top: .4rem; }
.when { color: #59636e; font-size: .8rem; }
.body { white-space: pre-wrap; }
@media (prefers-color-scheme: dark) {
  body { color: #e6edf3; background: #0d1117; } pre { background: #161b22; }
  .thread, h2 { border-color: #30363d; } .comment { border-color: #21262d; } .status, .when { color: #9198a1; }
}
</style>
</head>
<body>
<h1>${esc(title)}</h1>
${parts.join('\n')}
</body>
</html>
`;
}

export interface ExportOptions {
  keys: FileKey[];
  includeResolved: boolean;
  /** Category ids to include; null for all. */
  categories: string[] | null;
}

/** Collects the entries to export, reading each file's current text. */
export async function collectEntries(model: CommentModel, options: ExportOptions): Promise<ExportEntry[]> {
  const entries: ExportEntry[] = [];
  const folders = vscode.workspace.workspaceFolders ?? [];
  const keys = [...options.keys].sort((a, b) => (a.root + a.rel).localeCompare(b.root + b.rel));
  for (const key of keys) {
    const threads = model
      .threads(key)
      .filter((t) => options.includeResolved || t.status === 'open')
      .filter((t) => options.categories === null || options.categories.includes(t.category))
      .sort((a, b) => a.anchor.startLine - b.anchor.startLine);
    if (threads.length === 0) {
      continue;
    }
    let lines: string[] = [];
    let language = '';
    try {
      const doc = await vscode.workspace.openTextDocument(uriFor(key));
      lines = documentLines(doc);
      language = doc.languageId === 'plaintext' ? '' : doc.languageId;
    } catch {
      // The file is gone: its threads export with their last known text.
    }
    const folder = folders.length > 1 ? folders.find((f) => f.uri.fsPath === key.root) : undefined;
    const file = folder ? `${folder.name}/${key.rel}` : key.rel;
    for (const thread of threads) {
      const cat = config.category(thread.category);
      const a = thread.anchor;
      const snippet =
        thread.orphaned || lines.length === 0 ? a.text : lines.slice(a.startLine, a.endLine + 1).join('\n');
      entries.push({ file, language, thread, snippet, categoryLabel: cat.label, colour: cat.colour });
    }
  }
  return entries;
}

/** Margin Notes: Export Comments. */
export async function runExport(model: CommentModel): Promise<vscode.Uri | undefined> {
  const activeKey = vscode.window.activeTextEditor ? keyFor(vscode.window.activeTextEditor.document.uri) : undefined;
  type ScopePick = vscode.QuickPickItem & { scope: 'file' | 'workspace' };
  const scopes: ScopePick[] = [{ label: 'Whole workspace', scope: 'workspace' }];
  if (activeKey) {
    scopes.unshift({ label: 'Current file', description: activeKey.rel, scope: 'file' });
  }
  const scope = await vscode.window.showQuickPick(scopes, { title: 'Export Comments (1/4): scope' });
  if (!scope) {
    return undefined;
  }
  const format = await vscode.window.showQuickPick(
    [
      { label: 'Markdown', ext: 'md' },
      { label: 'HTML', description: 'standalone page, no external assets', ext: 'html' },
    ],
    { title: 'Export Comments (2/4): format' },
  );
  if (!format) {
    return undefined;
  }
  const resolved = await vscode.window.showQuickPick(
    [
      { label: 'Include resolved threads', include: true },
      { label: 'Open threads only', include: false },
    ],
    { title: 'Export Comments (3/4): resolved threads' },
  );
  if (!resolved) {
    return undefined;
  }
  const cats = config.categories();
  const chosen = await vscode.window.showQuickPick(
    cats.map((c) => ({ label: c.label, description: c.id, picked: true, id: c.id })),
    { title: 'Export Comments (4/4): categories', canPickMany: true },
  );
  if (!chosen || chosen.length === 0) {
    return undefined;
  }
  const keys = scope.scope === 'file' && activeKey ? [activeKey] : model.keys();
  const entries = await collectEntries(model, {
    keys,
    includeResolved: resolved.include,
    categories: chosen.length === cats.length ? null : chosen.map((c) => c.id),
  });
  const title = scope.scope === 'file' && activeKey ? `Comments: ${activeKey.rel}` : 'Comments';
  const content = format.ext === 'md' ? toMarkdown(entries, title) : toHtml(entries, title);
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const target = await vscode.window.showSaveDialog({
    defaultUri: folder ? vscode.Uri.joinPath(folder, `margin-notes.${format.ext}`) : undefined,
    filters: format.ext === 'md' ? { Markdown: ['md'] } : { HTML: ['html'] },
    saveLabel: 'Export',
  });
  if (!target) {
    return undefined;
  }
  await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
  void vscode.window.showInformationMessage(`Exported ${entries.length} comment thread${entries.length === 1 ? '' : 's'}.`, 'Open').then((c) => {
    if (c === 'Open') {
      void vscode.commands.executeCommand('vscode.open', target);
    }
  });
  return target;
}
