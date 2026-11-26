// Activation and command registration. Every action, from the native threads,
// the margin panel or the sidebar, goes through the same functions here: they
// change the single in-memory model, which saves it and refreshes every layer.
import { randomUUID } from 'crypto';
import { promises as fsp } from 'fs';
import * as vscode from 'vscode';
import { bodyText, NativeComments, NoteCommentItem } from './commentController';
import * as config from './config';
import { Decorations } from './decorations';
import { DocumentTracker, keyFor, openDocument } from './documents';
import { runExport } from './export';
import { MarginPanel, PanelActions } from './marginPanel';
import { CommentModel, FileKey, mergeLoaded, NoteThread, ThreadStatus } from './model';
import { revealThread, RevealDeps } from './reveal';
import { isTrackedByGit, parseSidecar, relFromSidecar, serialise, setGitExclude, SidecarStore, untrack } from './store';
import { OverviewTree } from './treeView';

export interface MarginNotesApi {
  model: CommentModel;
  store: SidecarStore;
  native: NativeComments;
  decorations: Decorations;
  panel: MarginPanel;
  tree: OverviewTree;
  tracker: DocumentTracker;
  actions: Actions;
  /** Resolves once every sidecar file has been loaded. */
  ready: Promise<void>;
}

export interface Actions extends PanelActions {
  createThread(
    key: FileKey,
    doc: vscode.TextDocument,
    range: vscode.Range,
    body: string,
    category: string,
    id?: string,
  ): NoteThread;
  deleteThread(threadId: string, confirm?: boolean): Promise<void>;
}

let api: MarginNotesApi | undefined;

export function activate(context: vscode.ExtensionContext): MarginNotesApi {
  const model = new CommentModel();
  const gitChecked = new Set<string>();
  const store = new SidecarStore(
    config.storageFolder(),
    (key) => model.threads(key),
    (message) => void vscode.window.showErrorMessage(message),
    (key) => {
      if (!gitChecked.has(key.root)) {
        gitChecked.add(key.root);
        void applyGitSetting(key.root, true);
      }
    },
  );
  const tracker = new DocumentTracker(model);
  const native = new NativeComments(model);
  const decorations = new Decorations(model);
  const tree = new OverviewTree(model, context.workspaceState);
  const lastColumns = new Map<string, vscode.ViewColumn>();

  const now = () => new Date().toISOString();

  const actions: Actions = {
    createThread(key, doc, range, body, category, id = randomUUID()) {
      const thread: NoteThread = {
        id,
        category,
        status: 'open',
        anchor: tracker.anchorFor(doc, range),
        orphaned: false,
        comments: [{ id: randomUUID(), body, created: now(), edited: null }],
      };
      model.addThread(key, thread);
      return thread;
    },
    async reveal(threadId, viewColumn) {
      await revealThread(revealDeps, threadId, { viewColumn });
    },
    reply(threadId, body) {
      const found = model.find(threadId);
      if (found && body.trim() !== '') {
        found.thread.comments.push({ id: randomUUID(), body, created: now(), edited: null });
        model.changed([found.key], 'user');
      }
    },
    editComment(commentId, body) {
      const found = model.findComment(commentId);
      if (found && body.trim() !== '' && body !== found.comment.body) {
        found.comment.body = body;
        found.comment.edited = now();
        model.changed([found.key], 'user');
      }
    },
    deleteComment(commentId) {
      model.removeComment(commentId);
    },
    async deleteThread(threadId, confirm = true) {
      const found = model.find(threadId);
      if (!found) {
        return;
      }
      if (confirm) {
        const n = found.thread.comments.length;
        const choice = await vscode.window.showWarningMessage(
          `Delete this comment thread${n > 1 ? ` and its ${n} comments` : ''}?`,
          { modal: true },
          'Delete',
        );
        if (choice !== 'Delete') {
          return;
        }
      }
      model.removeThread(threadId);
    },
    setStatus(threadId, status: ThreadStatus) {
      const found = model.find(threadId);
      if (found && found.thread.status !== status) {
        found.thread.status = status;
        model.changed([found.key], 'user');
      }
    },
    setCategory(threadId, category) {
      const found = model.find(threadId);
      if (found && found.thread.category !== category) {
        found.thread.category = category;
        model.changed([found.key], 'user');
      }
    },
    async reattach(threadId) {
      const found = model.find(threadId);
      if (!found) {
        return;
      }
      // Focus may be in the margin panel: fall back to the editor it tracks.
      const editor =
        vscode.window.activeTextEditor ??
        vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === panel.trackedUri?.toString());
      const editorKey = editor ? keyFor(editor.document.uri) : undefined;
      if (!editor || !editorKey || editorKey.root !== found.key.root || editorKey.rel !== found.key.rel) {
        await revealThread(revealDeps, threadId);
        void vscode.window.showInformationMessage(
          `Select the code in ${found.key.rel} this comment belongs to, then run Reattach Orphaned Comment again.`,
        );
        return;
      }
      const sel = editor.selection;
      const range = sel.isEmpty ? editor.document.lineAt(sel.active.line).range : sel;
      found.thread.anchor = tracker.anchorFor(editor.document, range);
      found.thread.orphaned = false;
      model.changed([found.key], 'user');
    },
  };

  const panel = new MarginPanel(context.extensionUri, model, actions);

  const revealDeps: RevealDeps = {
    model,
    native,
    decorations,
    reattach: (id) => actions.reattach(id),
    onRevealed: (id) => panel.setActive(id),
    lastColumn: (uri) => lastColumns.get(uri.toString()),
  };

  async function applyGitSetting(root: string, warnIfTracked: boolean): Promise<void> {
    const folder = config.storageFolder();
    try {
      if (config.commitComments()) {
        await setGitExclude(root, folder, false);
        return;
      }
      const result = await setGitExclude(root, folder, true);
      if (result !== 'no-git' && warnIfTracked && (await isTrackedByGit(root, folder))) {
        const choice = await vscode.window.showWarningMessage(
          `Git already tracks ${folder}, so excluding it has no effect: your comments will be committed. ` +
            `Stop tracking it? This runs "git rm -r --cached ${folder}"; the files stay on disk.`,
          'Stop Tracking',
          'Keep Tracking',
        );
        if (choice === 'Stop Tracking') {
          await untrack(root, folder);
          void vscode.window.showInformationMessage(`${folder} is no longer tracked by git. Commit the removal to apply it.`);
        }
      }
    } catch (e) {
      void vscode.window.showWarningMessage(`Margin Notes could not update .git/info/exclude: ${(e as Error).message}`);
    }
  }

  // ---- Model -> display layers --------------------------------------

  let treeTimer: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    model.onDidChange((change) => {
      if (change.persist) {
        for (const key of change.keys) {
          store.schedule(key);
        }
      }
      native.sync(change.keys);
      decorations.refreshAll();
      panel.render();
      // Edits move line numbers on every keystroke: refresh the tree a little later.
      if (treeTimer) {
        clearTimeout(treeTimer);
      }
      treeTimer = setTimeout(() => tree.refresh(), change.origin === 'edit' ? 300 : 0);
    }),
  );

  // ---- Loading and the file watcher ---------------------------------

  const watchers: vscode.Disposable[] = [];

  async function loadFolder(folder: vscode.WorkspaceFolder): Promise<void> {
    if (folder.uri.scheme !== 'file') {
      return;
    }
    for (const { key, data } of await store.loadAll(folder.uri.fsPath)) {
      // Comments can be added while loading runs (it isn't awaited before the
      // commands work): merge rather than replace, and save the result.
      const existing = model.threads(key);
      if (existing.length === 0) {
        model.setThreads(key, data.threads, 'load', false);
      } else {
        model.setThreads(key, mergeLoaded(existing, data.threads), 'load', true);
      }
      const doc = openDocument(key);
      if (doc) {
        tracker.reanchorDocument(doc);
      }
    }
    const pattern = new vscode.RelativePattern(folder, `${store.storageFolder}/**/*.json`);
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    // Events can arrive late, after the file has changed again (a "deleted"
    // event for a sidecar that has since been re-created): act on what is on
    // disk now, never on the event's kind.
    const reload = async (uri: vscode.Uri) => {
      const rel = relFromSidecar(folder.uri.fsPath, store.storageFolder, uri.fsPath);
      if (!rel) {
        return;
      }
      let content: string | undefined;
      try {
        content = await fsp.readFile(uri.fsPath, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          return;
        }
        content = undefined;
      }
      const key: FileKey = { root: folder.uri.fsPath, rel };
      if (store.isOwnWrite(uri.fsPath, content)) {
        return;
      }
      // Someone else's version: remember it, so our own older content coming
      // back later (a restore) counts as a change too.
      store.acceptExternal(uri.fsPath, content);
      // Nothing to reload when the disk already holds what the model would write.
      const threadsNow = model.threads(key);
      if (content === undefined ? threadsNow.length === 0 : content === serialise(rel, threadsNow)) {
        return;
      }
      try {
        const threads = content === undefined ? [] : parseSidecar(content).threads;
        model.setThreads(key, threads, 'load', false);
        const doc = openDocument(key);
        if (doc) {
          tracker.reanchorDocument(doc);
        }
      } catch (e) {
        void vscode.window.showErrorMessage(`Margin Notes could not read ${uri.fsPath}: ${(e as Error).message}`);
      }
    };
    watcher.onDidCreate(reload);
    watcher.onDidChange(reload);
    watcher.onDidDelete(reload);
    watchers.push(watcher);
  }

  async function loadAll(): Promise<void> {
    for (const w of watchers.splice(0)) {
      w.dispose();
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      await loadFolder(folder);
    }
    native.sync();
    decorations.refreshAll();
    tree.refresh();
    panel.render();
  }

  const ready = loadAll()
    .then(() => panel.checkAutoOpen())
    .catch((e) => {
      void vscode.window.showErrorMessage(`Margin Notes could not load comments: ${(e as Error).message}`);
    });

  // ---- Workspace and editor events ----------------------------------

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async (e) => {
      // Finish queued writes first: a write that ran after its folder's
      // threads were dropped would find none and delete the sidecar.
      await store.flush();
      for (const f of e.removed) {
        model.removeRoot(f.uri.fsPath);
      }
      await loadAll();
    }),
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const e of editors) {
        if (e.viewColumn !== undefined) {
          lastColumns.set(e.document.uri.toString(), e.viewColumn);
        }
      }
      decorations.refreshAll();
    }),
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration('marginNotes.storageFolder')) {
        // Queued writes finish in the old folder before the new one is read.
        await store.flush();
        store.setStorageFolder(config.storageFolder());
        for (const key of model.keys()) {
          model.setThreads(key, [], 'load', false);
        }
        gitChecked.clear();
        await loadAll();
      }
      if (e.affectsConfiguration('marginNotes.categories')) {
        decorations.rebuild();
        native.sync();
        tree.refresh();
      }
      if (e.affectsConfiguration('marginNotes.showResolved')) {
        native.sync();
        decorations.refreshAll();
      }
      if (e.affectsConfiguration('marginNotes.commitComments')) {
        const roots = new Set(model.keys().map((k) => k.root));
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
          if (config.commitComments() || roots.has(folder.uri.fsPath)) {
            await applyGitSetting(folder.uri.fsPath, !config.commitComments());
          }
        }
      }
    }),
  );

  // ---- Commands -----------------------------------------------------

  /** The thread a command was invoked on: a native thread, a comment, a tree item, an id, or the one at the cursor. */
  function threadIdFrom(arg: unknown): string | undefined {
    if (typeof arg === 'string') {
      return arg;
    }
    if (arg && typeof arg === 'object') {
      const a = arg as Record<string, unknown>;
      if (a.kind === 'thread' && a.thread && typeof a.thread === 'object') {
        return (a.thread as NoteThread).id;
      }
      if (typeof a.threadId === 'string') {
        return a.threadId;
      }
      if ('uri' in a && 'range' in a) {
        return native.threadIdOf(arg as vscode.CommentThread);
      }
    }
    const editor = vscode.window.activeTextEditor;
    const key = editor ? keyFor(editor.document.uri) : undefined;
    if (editor && key) {
      const line = editor.selection.active.line;
      return model
        .threads(key)
        .find((t) => !t.orphaned && line >= t.anchor.startLine && line <= t.anchor.endLine)?.id;
    }
    return undefined;
  }

  async function pickCategory(current?: string): Promise<string | undefined> {
    const cats = config.categories();
    const first = current ?? config.defaultCategoryId();
    const ordered = [...cats.filter((c) => c.id === first), ...cats.filter((c) => c.id !== first)];
    const choice = await vscode.window.showQuickPick(
      ordered.map((c) => ({ label: c.label, description: c.id === current ? 'current' : c.id, id: c.id })),
      { title: 'Comment category', placeHolder: current ? 'Change category' : 'Category (Escape for the default)' },
    );
    return choice?.id;
  }

  const register = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  register('marginNotes.addComment', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !keyFor(editor.document.uri)) {
      void vscode.window.showWarningMessage('Margin Notes: open a file in the workspace to add a comment.');
      return;
    }
    const sel = editor.selection;
    const range = sel.isEmpty ? editor.document.lineAt(sel.active.line).range : new vscode.Range(sel.start, sel.end);
    native.openDraft(editor.document.uri, range);
  });

  register('marginNotes.createThread', async (reply: vscode.CommentReply) => {
    const key = keyFor(reply.thread.uri);
    if (!key || reply.text.trim() === '') {
      return;
    }
    const doc = await vscode.workspace.openTextDocument(reply.thread.uri);
    // From the gutter "+", the comment covers whole lines; from Add Comment, the exact selection.
    const draft = native.draftRange(reply.thread);
    const r = reply.thread.range;
    const range =
      draft ?? new vscode.Range(r.start.line, 0, r.end.line, doc.lineAt(Math.min(r.end.line, doc.lineCount - 1)).text.length);
    const category = (await pickCategory()) ?? config.defaultCategoryId();
    // Adopt the widget the user typed into before the model changes, so the
    // sync that follows updates it rather than drawing a second one.
    const id = randomUUID();
    native.adopt(reply.thread, id);
    actions.createThread(key, doc, range, reply.text, category, id);
  });

  register('marginNotes.reply', (reply: vscode.CommentReply) => {
    const id = native.threadIdOf(reply.thread);
    if (id) {
      actions.reply(id, reply.text);
    }
  });

  register('marginNotes.editComment', (comment: NoteCommentItem) => native.startEdit(comment.id));
  register('marginNotes.cancelEdit', (comment: NoteCommentItem) => native.endEdit(comment.id));
  register('marginNotes.saveEdit', (comment: NoteCommentItem) => {
    const text = bodyText(comment.body);
    native.endEdit(comment.id);
    actions.editComment(comment.id, text);
  });
  register('marginNotes.deleteComment', (comment: NoteCommentItem | string) =>
    actions.deleteComment(typeof comment === 'string' ? comment : comment.id),
  );

  register('marginNotes.deleteThread', async (arg?: unknown) => {
    const id = threadIdFrom(arg);
    if (id) {
      await actions.deleteThread(id);
    }
  });
  register('marginNotes.resolveThread', (arg?: unknown) => {
    const id = threadIdFrom(arg);
    if (id) {
      actions.setStatus(id, 'resolved');
    }
  });
  register('marginNotes.reopenThread', (arg?: unknown) => {
    const id = threadIdFrom(arg);
    if (id) {
      actions.setStatus(id, 'open');
    }
  });

  register('marginNotes.changeCategory', async (arg?: unknown) => {
    const id = threadIdFrom(arg);
    const found = id ? model.find(id) : undefined;
    if (!found) {
      void vscode.window.showInformationMessage('Margin Notes: put the cursor in a commented range to change its category.');
      return;
    }
    const category = await pickCategory(found.thread.category);
    if (category) {
      actions.setCategory(found.thread.id, category);
    }
  });

  register('marginNotes.reattachOrphan', async (arg?: unknown) => {
    let id = typeof arg === 'string' || (arg && typeof arg === 'object') ? threadIdFrom(arg) : undefined;
    if (!id || !model.find(id)?.thread.orphaned) {
      const orphans = model.all().filter(({ thread }) => thread.orphaned);
      if (orphans.length === 0) {
        void vscode.window.showInformationMessage('Margin Notes: there are no orphaned comments.');
        return;
      }
      const activeKey = vscode.window.activeTextEditor ? keyFor(vscode.window.activeTextEditor.document.uri) : undefined;
      const sorted = [...orphans].sort((a, b) => {
        const aHere = activeKey && a.key.rel === activeKey.rel && a.key.root === activeKey.root ? 0 : 1;
        const bHere = activeKey && b.key.rel === activeKey.rel && b.key.root === activeKey.root ? 0 : 1;
        return aHere - bHere;
      });
      const choice = await vscode.window.showQuickPick(
        sorted.map(({ key, thread }) => ({
          label: thread.comments[0]?.body.split(/\r?\n/)[0] ?? '(empty)',
          description: `${key.rel}, last at L${thread.anchor.startLine + 1}`,
          detail: thread.anchor.text.split(/\r?\n/)[0],
          id: thread.id,
        })),
        { title: 'Reattach which orphaned comment to the selection?' },
      );
      id = choice?.id;
    }
    if (id) {
      await actions.reattach(id);
    }
  });

  register('marginNotes.toggleMargin', () => panel.toggle());
  register('marginNotes.showAllComments', () => vscode.commands.executeCommand('marginNotes.overview.focus'));
  register('marginNotes.exportComments', () => runExport(model));
  register('marginNotes.filterTree', () => tree.pickFilter());
  register('marginNotes.toggleShowResolved', () => config.setShowResolved(!config.showResolved()));
  register('marginNotes.revealThread', (arg: unknown) => {
    const id = threadIdFrom(arg);
    if (id) {
      return revealThread(revealDeps, id, { viewColumn: panel.trackedColumn });
    }
  });
  register('marginNotes.deleteAllResolved', async () => {
    const resolved = model.all().filter(({ thread }) => thread.status === 'resolved');
    if (resolved.length === 0) {
      void vscode.window.showInformationMessage('Margin Notes: there are no resolved threads.');
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `Delete ${resolved.length} resolved comment thread${resolved.length === 1 ? '' : 's'}? This can't be undone.`,
      { modal: true },
      'Delete',
    );
    if (choice === 'Delete') {
      for (const { thread } of resolved) {
        model.removeThread(thread.id);
      }
    }
  });

  context.subscriptions.push(tracker, native, decorations, tree, panel, { dispose: () => watchers.forEach((w) => w.dispose()) });

  api = { model, store, native, decorations, panel, tree, tracker, actions, ready };
  return api;
}

export async function deactivate(): Promise<void> {
  await api?.store.flush();
}
