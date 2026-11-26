// Sidecar files: reading, debounced atomic writes, self-write detection for
// the file watcher, and keeping the storage folder out of git. No vscode
// imports, so it can be unit-tested in plain Node; the FileSystemWatcher
// itself is created in extension.ts and calls back into SidecarStore.
import { execFile } from 'child_process';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { FileKey, keyString, NoteThread, SCHEMA_VERSION, SidecarFile } from './model';

export const WRITE_DELAY_MS = 300;
const EXCLUDE_MARKER = '# Margin Notes: comment sidecar files (local only)';

/** File operations used by writeAtomic; replaced in tests to simulate failures. */
export const io = {
  writeFile: (file: string, data: string) => fsp.writeFile(file, data, 'utf8'),
  rename: (from: string, to: string) => fsp.rename(from, to),
  unlink: (file: string) => fsp.unlink(file),
};

export function sidecarPath(root: string, storageFolder: string, rel: string): string {
  return path.join(root, storageFolder, ...rel.split('/')) + '.json';
}

/** The source file a sidecar belongs to, relative to root; undefined if it isn't a sidecar. */
export function relFromSidecar(root: string, storageFolder: string, sidecar: string): string | undefined {
  const base = path.join(root, storageFolder);
  const relative = path.relative(base, sidecar);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative) || !relative.endsWith('.json')) {
    return undefined;
  }
  return relative.slice(0, -'.json'.length).split(path.sep).join('/');
}

export function serialise(rel: string, threads: NoteThread[]): string {
  const data: SidecarFile = { version: SCHEMA_VERSION, file: rel, threads };
  return JSON.stringify(data, null, 2) + '\n';
}

/**
 * Parses a sidecar and migrates it to the current schema. Throws on files
 * that aren't sidecars, or that come from a newer version of the extension.
 */
export function parseSidecar(json: string): SidecarFile {
  const data = JSON.parse(json);
  if (typeof data !== 'object' || data === null || !Array.isArray(data.threads)) {
    throw new Error('not a Margin Notes sidecar file');
  }
  return migrate(data);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function migrate(data: any): SidecarFile {
  const version = typeof data.version === 'number' ? data.version : 0;
  if (version > SCHEMA_VERSION) {
    throw new Error(`sidecar schema version ${version} is newer than this extension supports (${SCHEMA_VERSION})`);
  }
  // Every field is read defensively, so a file with no version field (written
  // by hand, or damaged) still loads: missing fields get defaults, and a
  // boolean `resolved` is accepted for `status`. Future schema versions add
  // their conversions here.
  const threads: NoteThread[] = data.threads.map((t: any) => ({
    id: String(t.id),
    category: typeof t.category === 'string' ? t.category : 'note',
    status: t.status === 'resolved' || t.resolved === true ? 'resolved' : 'open',
    anchor: {
      startLine: Number(t.anchor?.startLine ?? 0),
      startChar: Number(t.anchor?.startChar ?? 0),
      endLine: Number(t.anchor?.endLine ?? t.anchor?.startLine ?? 0),
      endChar: Number(t.anchor?.endChar ?? 0),
      text: String(t.anchor?.text ?? ''),
      before: String(t.anchor?.before ?? ''),
      after: String(t.anchor?.after ?? ''),
      hash: String(t.anchor?.hash ?? ''),
    },
    orphaned: t.orphaned === true,
    comments: (Array.isArray(t.comments) ? t.comments : []).map((c: any) => ({
      id: String(c.id),
      body: String(c.body ?? ''),
      created: String(c.created ?? new Date(0).toISOString()),
      edited: typeof c.edited === 'string' ? c.edited : null,
    })),
  }));
  return { version: SCHEMA_VERSION, file: String(data.file ?? ''), threads };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Writes a file through a temporary file and a rename, so a write that fails
 * part way leaves the previous file intact.
 */
export async function writeAtomic(file: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await io.writeFile(tmp, content);
    // Windows refuses a rename over a file another process has open for a
    // moment (a virus scanner, the file watcher): try a few times.
    for (let attempt = 0; ; attempt++) {
      try {
        await io.rename(tmp, file);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
          throw e;
        }
        await delay(50 * (attempt + 1));
      }
    }
  } catch (e) {
    await io.unlink(tmp).catch(() => undefined);
    throw e;
  }
}

/** Removes empty folders from dir up to, but not including, stop. */
async function pruneEmptyDirs(dir: string, stop: string): Promise<void> {
  while (dir.length > stop.length && dir.startsWith(stop)) {
    try {
      await fsp.rmdir(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

export class SidecarStore {
  /** Queued writes, each with the storage folder current when it was queued. */
  private readonly timers = new Map<string, { key: FileKey; folder: string; timer: NodeJS.Timeout }>();
  private readonly pending = new Set<Promise<void>>();
  /** What this store last wrote to each sidecar ('' for a delete), to tell its own writes from others'. */
  private readonly lastWritten = new Map<string, string>();
  /** Writes queued or running per sidecar: until the last rename lands, the disk holds older content. */
  private readonly inFlight = new Map<string, number>();
  /** The last write queued per sidecar, so writes of one file run one after another, in order. */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private folder: string,
    private readonly getThreads: (key: FileKey) => NoteThread[],
    private readonly onError: (message: string) => void,
    private readonly onWrite: (key: FileKey) => void = () => undefined,
    private readonly delayMs = WRITE_DELAY_MS,
  ) {}

  get storageFolder(): string {
    return this.folder;
  }

  /**
   * Switches where new writes go and where sidecars are read from. Writes
   * already queued still go to the folder they were queued for: flush first
   * to finish them before reading the new folder.
   */
  setStorageFolder(folder: string): void {
    this.folder = folder;
  }

  /** Queues a write of a file's threads; several changes within the delay make one write. */
  schedule(key: FileKey): void {
    const k = keyString(key);
    const existing = this.timers.get(k);
    if (existing) {
      clearTimeout(existing.timer);
    }
    const folder = this.folder;
    const timer = setTimeout(() => {
      this.timers.delete(k);
      this.enqueue(key, folder);
    }, this.delayMs);
    this.timers.set(k, { key, folder, timer });
  }

  /**
   * Starts a write once the previous write of the same file has finished. A
   * slow write (Windows retrying a refused rename) could otherwise land after
   * a newer one and leave stale content on disk. Each write reads the threads
   * when it runs, so the last one written is always the newest.
   */
  private enqueue(key: FileKey, folder: string): void {
    const file = sidecarPath(key.root, folder, key.rel);
    this.inFlight.set(file, (this.inFlight.get(file) ?? 0) + 1);
    const next = (this.chains.get(file) ?? Promise.resolve()).then(() => this.write(key, folder, file));
    this.chains.set(file, next);
    this.track(
      next.finally(() => {
        const n = (this.inFlight.get(file) ?? 1) - 1;
        if (n <= 0) {
          this.inFlight.delete(file);
        } else {
          this.inFlight.set(file, n);
        }
        if (this.chains.get(file) === next) {
          this.chains.delete(file);
        }
      }),
    );
  }

  /** Writes every queued change now. */
  async flush(): Promise<void> {
    for (const { key, folder, timer } of this.timers.values()) {
      clearTimeout(timer);
      this.enqueue(key, folder);
    }
    this.timers.clear();
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  private track(p: Promise<void>): void {
    this.pending.add(p);
    p.finally(() => this.pending.delete(p));
  }

  private async write(key: FileKey, folder: string, file: string): Promise<void> {
    const threads = this.getThreads(key);
    try {
      if (threads.length === 0) {
        this.lastWritten.set(file, '');
        await fsp.unlink(file).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== 'ENOENT') {
            throw e;
          }
        });
        await pruneEmptyDirs(path.dirname(file), path.join(key.root, folder));
      } else {
        const content = serialise(key.rel, threads);
        this.lastWritten.set(file, content);
        await writeAtomic(file, content);
        this.onWrite(key);
      }
    } catch (e) {
      this.onError(`Margin Notes could not save comments for ${key.rel}: ${(e as Error).message}`);
    }
  }

  /**
   * Whether a watcher event can be ignored: the sidecar's current content
   * (undefined when missing) is what this store last wrote, or a write of it
   * is in progress (its own event follows).
   */
  isOwnWrite(file: string, content: string | undefined): boolean {
    if (this.inFlight.has(file)) {
      return true;
    }
    const last = this.lastWritten.get(file);
    return last !== undefined && last === (content ?? '');
  }

  /**
   * Records a sidecar's content (undefined when deleted) accepted from
   * someone else, so that an older version of this store's own write coming
   * back later (a restore) is seen as a change, not an echo.
   */
  acceptExternal(file: string, content: string | undefined): void {
    this.lastWritten.set(file, content ?? '');
  }

  /** Reads one sidecar; undefined when it is missing. Throws on a broken file. */
  async read(file: string): Promise<SidecarFile | undefined> {
    let json: string;
    try {
      json = await fsp.readFile(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw e;
    }
    return parseSidecar(json);
  }

  /** Every sidecar under a workspace folder's storage folder. */
  async loadAll(root: string): Promise<{ key: FileKey; data: SidecarFile }[]> {
    const base = path.join(root, this.folder);
    const result: { key: FileKey; data: SidecarFile }[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: import('fs').Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.name.endsWith('.json')) {
          const rel = relFromSidecar(root, this.folder, full);
          if (!rel) {
            continue;
          }
          try {
            const data = await this.read(full);
            if (data) {
              result.push({ key: { root, rel }, data });
            }
          } catch (e) {
            this.onError(`Margin Notes could not read ${full}: ${(e as Error).message}`);
          }
        }
      }
    };
    await walk(base);
    return result;
  }
}

// ---- Git ---------------------------------------------------------------

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true }, (err, stdout) => {
      if (err) {
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

/** The repository's top level and its common git folder; undefined outside a repository. */
export async function gitInfo(root: string): Promise<{ top: string; commonDir: string } | undefined> {
  try {
    const out = await git(root, ['rev-parse', '--show-toplevel', '--git-common-dir']);
    const [top, common] = out.split(/\r?\n/);
    if (!top || !common) {
      return undefined;
    }
    return { top: path.resolve(top), commonDir: path.resolve(root, common) };
  } catch {
    return undefined;
  }
}

/** The .git/info/exclude pattern for a storage folder, relative to the repository's top level. */
export function excludePattern(top: string, root: string, storageFolder: string): string {
  const rel = path.relative(top, path.join(root, storageFolder)).split(path.sep).join('/');
  return '/' + rel.replace(/\/+$/, '') + '/';
}

/**
 * Adds the storage folder to .git/info/exclude (exclude true) or removes the
 * line this extension added (exclude false). That file is local and never
 * committed, so the tracked .gitignore is left alone.
 */
export async function setGitExclude(
  root: string,
  storageFolder: string,
  exclude: boolean,
): Promise<'added' | 'removed' | 'unchanged' | 'no-git'> {
  const info = await gitInfo(root);
  if (!info) {
    return 'no-git';
  }
  const file = path.join(info.commonDir, 'info', 'exclude');
  const pattern = excludePattern(info.top, root, storageFolder);
  // Workspace folders in the same repository share this file: run each
  // read-modify-write after the previous one, or the last write drops the
  // other folders' lines.
  const lockKey = process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
  const run = (excludeLocks.get(lockKey) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => updateExclude(file, pattern, exclude));
  excludeLocks.set(lockKey, run);
  try {
    return await run;
  } finally {
    if (excludeLocks.get(lockKey) === run) {
      excludeLocks.delete(lockKey);
    }
  }
}

const excludeLocks = new Map<string, Promise<unknown>>();

async function updateExclude(file: string, pattern: string, exclude: boolean): Promise<'added' | 'removed' | 'unchanged'> {
  let content = '';
  try {
    content = await fsp.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw e;
    }
  }
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content === '' ? [] : content.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const has = lines.some((l) => l.trim() === pattern);
  if (exclude) {
    if (has) {
      return 'unchanged';
    }
    lines.push(EXCLUDE_MARKER, pattern);
  } else {
    if (!has) {
      return 'unchanged';
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim() === pattern) {
        const markerAbove = i > 0 && lines[i - 1] === EXCLUDE_MARKER;
        lines.splice(markerAbove ? i - 1 : i, markerAbove ? 2 : 1);
        i--;
      }
    }
  }
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, lines.length > 0 ? lines.join(eol) + eol : '', 'utf8');
  return exclude ? 'added' : 'removed';
}

/** Whether git already tracks files in the storage folder (excluding it then does nothing). */
export async function isTrackedByGit(root: string, storageFolder: string): Promise<boolean> {
  try {
    const out = await git(root, ['ls-files', '--', storageFolder]);
    return out.trim() !== '';
  } catch {
    return false;
  }
}

/** Stops git tracking the storage folder, keeping the files: git rm -r --cached. */
export async function untrack(root: string, storageFolder: string): Promise<void> {
  await git(root, ['rm', '-r', '--cached', '--quiet', '--', storageFolder]);
}
