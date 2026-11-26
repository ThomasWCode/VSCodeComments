// Types and the in-memory thread registry: the single source of truth that
// both display layers, the sidebar and the sidecar files are built from.
// No vscode imports, so it can be unit-tested without VS Code.

export const SCHEMA_VERSION = 1;

export type ThreadStatus = 'open' | 'resolved';

export interface Anchor {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
  /** Exact anchored text. */
  text: string;
  /** Up to contextLines lines above the anchor, joined with '\n'. */
  before: string;
  /** Up to contextLines lines below the anchor, joined with '\n'. */
  after: string;
  /** sha1 of text. */
  hash: string;
}

export interface NoteComment {
  id: string;
  /** Markdown. */
  body: string;
  /** ISO-8601. */
  created: string;
  /** ISO-8601, or null if never edited. */
  edited: string | null;
}

export interface NoteThread {
  id: string;
  category: string;
  status: ThreadStatus;
  anchor: Anchor;
  orphaned: boolean;
  comments: NoteComment[];
}

export interface SidecarFile {
  version: number;
  /** Source file path relative to its workspace folder, with forward slashes. */
  file: string;
  threads: NoteThread[];
}

/** Where a set of threads lives: one source file in one workspace folder. */
export interface FileKey {
  /** Absolute path of the workspace folder. */
  root: string;
  /** Source file path relative to root, with forward slashes. */
  rel: string;
}

export function keyString(key: FileKey): string {
  return key.root + '|' + key.rel;
}

/** Why the model changed, so listeners can skip work they caused themselves. */
export type ChangeOrigin = 'user' | 'edit' | 'load' | 'reanchor';

export interface ModelChange {
  keys: FileKey[];
  origin: ChangeOrigin;
  /** Whether the change must be written to disk. */
  persist: boolean;
}

/**
 * Combines a file's threads read from disk with threads already in the model
 * (added while loading was still running): the model's versions win, and
 * threads only on disk are added. The model's thread objects are kept, as
 * the display layers hold on to them.
 */
export function mergeLoaded(existing: NoteThread[], loaded: NoteThread[]): NoteThread[] {
  const ids = new Set(existing.map((t) => t.id));
  return [...loaded.filter((t) => !ids.has(t.id)), ...existing];
}

export class CommentModel {
  private readonly files = new Map<string, { key: FileKey; threads: NoteThread[] }>();
  private readonly listeners: ((change: ModelChange) => void)[] = [];

  onDidChange(listener: (change: ModelChange) => void): { dispose(): void } {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const i = this.listeners.indexOf(listener);
        if (i >= 0) {
          this.listeners.splice(i, 1);
        }
      },
    };
  }

  /** Tells listeners that threads of these files changed in place. */
  changed(keys: FileKey[], origin: ChangeOrigin, persist = true): void {
    const change: ModelChange = { keys, origin, persist };
    for (const listener of [...this.listeners]) {
      listener(change);
    }
  }

  threads(key: FileKey): NoteThread[] {
    return this.files.get(keyString(key))?.threads ?? [];
  }

  keys(): FileKey[] {
    return [...this.files.values()].map((f) => f.key);
  }

  all(): { key: FileKey; thread: NoteThread }[] {
    const result: { key: FileKey; thread: NoteThread }[] = [];
    for (const f of this.files.values()) {
      for (const thread of f.threads) {
        result.push({ key: f.key, thread });
      }
    }
    return result;
  }

  find(threadId: string): { key: FileKey; thread: NoteThread } | undefined {
    for (const f of this.files.values()) {
      const thread = f.threads.find((t) => t.id === threadId);
      if (thread) {
        return { key: f.key, thread };
      }
    }
    return undefined;
  }

  findComment(commentId: string): { key: FileKey; thread: NoteThread; comment: NoteComment } | undefined {
    for (const f of this.files.values()) {
      for (const thread of f.threads) {
        const comment = thread.comments.find((c) => c.id === commentId);
        if (comment) {
          return { key: f.key, thread, comment };
        }
      }
    }
    return undefined;
  }

  /** Replaces every thread of a file, for example after reading its sidecar. */
  setThreads(key: FileKey, threads: NoteThread[], origin: ChangeOrigin, persist: boolean): void {
    if (threads.length === 0) {
      this.files.delete(keyString(key));
    } else {
      this.files.set(keyString(key), { key, threads });
    }
    this.changed([key], origin, persist);
  }

  addThread(key: FileKey, thread: NoteThread): void {
    const k = keyString(key);
    const entry = this.files.get(k);
    if (entry) {
      entry.threads.push(thread);
    } else {
      this.files.set(k, { key, threads: [thread] });
    }
    this.changed([key], 'user');
  }

  removeThread(threadId: string): boolean {
    const found = this.find(threadId);
    if (!found) {
      return false;
    }
    const k = keyString(found.key);
    const entry = this.files.get(k)!;
    entry.threads = entry.threads.filter((t) => t.id !== threadId);
    if (entry.threads.length === 0) {
      this.files.delete(k);
    }
    this.changed([found.key], 'user');
    return true;
  }

  /** Removes a comment; the thread goes with its last comment. */
  removeComment(commentId: string): boolean {
    const found = this.findComment(commentId);
    if (!found) {
      return false;
    }
    found.thread.comments = found.thread.comments.filter((c) => c.id !== commentId);
    if (found.thread.comments.length === 0) {
      return this.removeThread(found.thread.id);
    }
    this.changed([found.key], 'user');
    return true;
  }

  /** Drops every file of a workspace folder, for example when it is removed. */
  removeRoot(root: string): void {
    const removed: FileKey[] = [];
    for (const [k, f] of this.files) {
      if (f.key.root === root) {
        this.files.delete(k);
        removed.push(f.key);
      }
    }
    if (removed.length > 0) {
      this.changed(removed, 'load', false);
    }
  }
}
