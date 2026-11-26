// Display layer A: native inline comment threads, built from the model.
import * as vscode from 'vscode';
import { AnchorRange, shiftAnchor } from './anchor';
import * as config from './config';
import { keyFor, uriFor } from './documents';
import { CommentModel, FileKey, keyString, NoteComment, NoteThread } from './model';

/** The fixed author shown on every comment: the extension is single-user. */
const AUTHOR: vscode.CommentAuthorInformation = { name: 'Note' };

export class NoteCommentItem implements vscode.Comment {
  body: string | vscode.MarkdownString;
  mode = vscode.CommentMode.Preview;
  readonly author = AUTHOR;
  timestamp: Date;
  label: string | undefined;
  contextValue = 'note';

  constructor(
    readonly id: string,
    readonly threadId: string,
    public savedBody: string,
    created: string,
    edited: string | null,
  ) {
    this.body = markdown(savedBody);
    this.timestamp = new Date(edited ?? created);
    this.label = edited ? '(edited)' : undefined;
  }
}

function markdown(text: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(text);
  md.isTrusted = false;
  return md;
}

export function bodyText(body: string | vscode.MarkdownString): string {
  return typeof body === 'string' ? body : body.value;
}

export class NativeComments implements vscode.Disposable {
  readonly controller: vscode.CommentController;
  private readonly threads = new Map<string, vscode.CommentThread>();
  /** Comments open for editing, so a refresh keeps them in edit mode. */
  private readonly editing = new Set<string>();
  /** Empty threads opened by Add Comment, with the exact selection they were opened for. */
  private readonly drafts = new Map<vscode.CommentThread, vscode.Range>();
  /** What each native thread's comments were last built from. */
  private readonly signatures = new Map<string, string>();

  private readonly listener: vscode.Disposable;

  constructor(private readonly model: CommentModel) {
    // A draft waits for the user to type: keep its selection on the same code
    // if the document is edited meanwhile.
    this.listener = vscode.workspace.onDidChangeTextDocument((e) => this.shiftDrafts(e));
    this.controller = vscode.comments.createCommentController('marginNotes', 'Margin Notes');
    this.controller.options = { prompt: 'Add a comment', placeHolder: 'Write a comment (Markdown)' };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (doc: vscode.TextDocument) => {
        if (!keyFor(doc.uri) || doc.lineCount === 0) {
          return [];
        }
        return [new vscode.Range(0, 0, doc.lineCount - 1, 0)];
      },
    };
  }

  private shiftDrafts(e: vscode.TextDocumentChangeEvent): void {
    for (const [draft, range] of this.drafts) {
      if (draft.uri.toString() !== e.document.uri.toString()) {
        continue;
      }
      let r: AnchorRange = {
        startLine: range.start.line,
        startChar: range.start.character,
        endLine: range.end.line,
        endChar: range.end.character,
      };
      for (const c of e.contentChanges) {
        const result = shiftAnchor(r, {
          startLine: c.range.start.line,
          startChar: c.range.start.character,
          endLine: c.range.end.line,
          endChar: c.range.end.character,
          text: c.text,
        });
        if (result.kind === 'deleted') {
          // The selected code is gone: keep the draft where it was cut.
          r = { startLine: c.range.start.line, startChar: c.range.start.character, endLine: c.range.start.line, endChar: c.range.start.character };
        } else if (result.kind !== 'unchanged') {
          r = result.range;
        }
      }
      this.drafts.set(draft, new vscode.Range(r.startLine, r.startChar, r.endLine, r.endChar));
    }
  }

  dispose(): void {
    this.listener.dispose();
    for (const t of this.threads.values()) {
      t.dispose();
    }
    this.threads.clear();
    for (const t of this.drafts.keys()) {
      t.dispose();
    }
    this.drafts.clear();
    this.controller.dispose();
  }

  /** Brings the native threads of these files (all files when omitted) in line with the model. */
  sync(keys?: FileKey[]): void {
    const wanted = keys ?? this.model.keys();
    const showResolved = config.showResolved();
    const keyed = new Set(wanted.map(keyString));
    const live = new Set<string>();
    for (const key of wanted) {
      for (const thread of this.model.threads(key)) {
        if (thread.orphaned || (!showResolved && thread.status === 'resolved')) {
          continue;
        }
        live.add(thread.id);
        this.update(key, thread);
      }
    }
    // Native threads of these files whose model thread is gone, orphaned or hidden.
    for (const [id, native] of this.threads) {
      const nk = keyFor(native.uri);
      const inScope = keys === undefined || (nk !== undefined && keyed.has(keyString(nk)));
      if (inScope && !live.has(id)) {
        native.dispose();
        this.threads.delete(id);
        this.signatures.delete(id);
      }
    }
  }

  private update(key: FileKey, thread: NoteThread): void {
    const range = new vscode.Range(
      thread.anchor.startLine,
      thread.anchor.startChar,
      thread.anchor.endLine,
      thread.anchor.endChar,
    );
    let native = this.threads.get(thread.id);
    if (!native) {
      native = this.controller.createCommentThread(uriFor(key), range, []);
      native.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      this.threads.set(thread.id, native);
    } else if (!native.range.isEqual(range)) {
      native.range = range;
    }
    // Each assignment re-renders the widget, and this runs on every keystroke
    // in the document (anchors move): assign only what changed.
    const label = config.category(thread.category).label;
    if (native.label !== label) {
      native.label = label;
    }
    const contextValue = `thread ${thread.status} cat-${thread.category}`;
    if (native.contextValue !== contextValue) {
      native.contextValue = contextValue;
    }
    const state =
      thread.status === 'resolved' ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
    if (native.state !== state) {
      native.state = state;
    }
    if (!native.canReply) {
      native.canReply = true;
    }
    const signature = JSON.stringify([thread.comments, thread.comments.map((c) => this.editing.has(c.id))]);
    if (this.signatures.get(thread.id) !== signature) {
      this.signatures.set(thread.id, signature);
      native.comments = thread.comments.map((c) => this.item(thread.id, c, native!));
    }
  }

  private item(threadId: string, c: NoteComment, native: vscode.CommentThread): NoteCommentItem {
    const existing = native.comments.find((x) => (x as NoteCommentItem).id === c.id) as NoteCommentItem | undefined;
    const item = new NoteCommentItem(c.id, threadId, c.body, c.created, c.edited);
    if (this.editing.has(c.id)) {
      item.mode = vscode.CommentMode.Editing;
      // Keep what the user has typed so far.
      if (existing) {
        item.body = existing.body;
      }
    }
    return item;
  }

  native(threadId: string): vscode.CommentThread | undefined {
    return this.threads.get(threadId);
  }

  threadIdOf(native: vscode.CommentThread): string | undefined {
    for (const [id, t] of this.threads) {
      if (t === native) {
        return id;
      }
    }
    return undefined;
  }

  /** Opens an empty thread on a selection for the user to type the first comment into. */
  openDraft(uri: vscode.Uri, selection: vscode.Range): vscode.CommentThread {
    for (const d of this.drafts.keys()) {
      d.dispose();
    }
    this.drafts.clear();
    const draft = this.controller.createCommentThread(uri, selection, []);
    draft.canReply = true;
    draft.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.drafts.set(draft, selection);
    return draft;
  }

  /** The exact range a draft was opened for; undefined for threads started from the gutter. */
  draftRange(native: vscode.CommentThread): vscode.Range | undefined {
    return this.drafts.get(native);
  }

  /** Takes over a native thread VS Code (gutter +) or Add Comment created, as a model thread's. */
  adopt(native: vscode.CommentThread, threadId: string): void {
    this.drafts.delete(native);
    this.threads.set(threadId, native);
    this.signatures.delete(threadId);
  }

  startEdit(commentId: string): void {
    this.editing.add(commentId);
    const found = this.model.findComment(commentId);
    if (found) {
      this.sync([found.key]);
    }
  }

  endEdit(commentId: string): void {
    this.editing.delete(commentId);
    const found = this.model.findComment(commentId);
    if (found) {
      this.sync([found.key]);
    }
  }

  expand(threadId: string): void {
    const native = this.threads.get(threadId);
    if (native) {
      native.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    }
  }
}
