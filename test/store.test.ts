// Unit tests for sidecar storage and git exclude handling. Plain Node:
// npm run test:unit. The git tests need git on the PATH.
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NoteThread, SCHEMA_VERSION } from '../src/model';
import {
  excludePattern,
  io,
  isTrackedByGit,
  migrate,
  parseSidecar,
  relFromSidecar,
  serialise,
  setGitExclude,
  sidecarPath,
  SidecarStore,
  untrack,
  writeAtomic,
} from '../src/store';

function tempDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'margin-notes-')));
}

function thread(id: string): NoteThread {
  return {
    id,
    category: 'question',
    status: 'open',
    anchor: { startLine: 41, startChar: 0, endLine: 43, endChar: 12, text: 'x', before: '', after: '', hash: 'h' },
    orphaned: false,
    comments: [{ id: id + '-c', body: 'Why?', created: '2026-01-01T00:00:00.000Z', edited: null }],
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function gitRepo(): string {
  const dir = tempDir();
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  return dir;
}

describe('sidecar paths', () => {
  it('mirrors the source path inside the storage folder', () => {
    const root = path.join(os.tmpdir(), 'ws');
    assert.strictEqual(sidecarPath(root, '.codecomments', 'src/foo.py'), path.join(root, '.codecomments', 'src', 'foo.py.json'));
  });

  it('maps a sidecar back to its source file', () => {
    const root = path.join(os.tmpdir(), 'ws');
    assert.strictEqual(relFromSidecar(root, '.codecomments', path.join(root, '.codecomments', 'src', 'foo.py.json')), 'src/foo.py');
    assert.strictEqual(relFromSidecar(root, '.codecomments', path.join(root, 'src', 'foo.py.json')), undefined);
    assert.strictEqual(relFromSidecar(root, '.codecomments', path.join(root, '.codecomments', 'notes.txt')), undefined);
  });
});

describe('schema', () => {
  it('round-trips a sidecar', () => {
    const json = serialise('src/foo.py', [thread('a')]);
    const data = parseSidecar(json);
    assert.strictEqual(data.version, SCHEMA_VERSION);
    assert.strictEqual(data.file, 'src/foo.py');
    assert.deepStrictEqual(data.threads, [thread('a')]);
  });

  it('migrates a file without a version, filling in missing fields', () => {
    const data = migrate({
      file: 'a.ts',
      threads: [{ id: 't', resolved: true, anchor: { startLine: 3, text: 'x' }, comments: [{ id: 'c', body: 'hi' }] }],
    });
    assert.strictEqual(data.version, SCHEMA_VERSION);
    const t = data.threads[0];
    assert.strictEqual(t.status, 'resolved');
    assert.strictEqual(t.category, 'note');
    assert.strictEqual(t.orphaned, false);
    assert.strictEqual(t.anchor.endLine, 3);
    assert.strictEqual(t.comments[0].edited, null);
  });

  it('refuses a file from a newer schema version rather than losing its data', () => {
    assert.throws(() => parseSidecar(JSON.stringify({ version: SCHEMA_VERSION + 1, file: 'a', threads: [] })), /newer/);
  });

  it('refuses a file that is not a sidecar', () => {
    assert.throws(() => parseSidecar('{"hello": 1}'), /not a Margin Notes sidecar/);
    assert.throws(() => parseSidecar('not json'));
  });
});

describe('writeAtomic', () => {
  const saved = { ...io };
  afterEach(() => Object.assign(io, saved));

  it('writes through a temporary file', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'deep', 'a.json');
    await writeAtomic(file, 'one');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'one');
    assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['a.json']);
  });

  it('leaves the previous file intact when the write is interrupted', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'a.json');
    fs.writeFileSync(file, 'previous');
    io.rename = async () => {
      throw Object.assign(new Error('disk gone'), { code: 'EIO' });
    };
    await assert.rejects(writeAtomic(file, 'next'), /disk gone/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'previous');
    assert.deepStrictEqual(fs.readdirSync(dir), ['a.json'], 'the temporary file is cleaned up');
  });

  it('leaves the previous file intact when writing the temporary file fails part way', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'a.json');
    fs.writeFileSync(file, 'previous');
    io.writeFile = async (f: string, data: string) => {
      fs.writeFileSync(f, data.slice(0, 2));
      throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
    };
    await assert.rejects(writeAtomic(file, 'next value'), /no space/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'previous');
    assert.deepStrictEqual(fs.readdirSync(dir), ['a.json']);
  });

  it('retries a rename Windows refuses for a moment', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'a.json');
    let calls = 0;
    io.rename = async (from: string, to: string) => {
      if (++calls < 3) {
        throw Object.assign(new Error('busy'), { code: 'EPERM' });
      }
      return saved.rename(from, to);
    };
    await writeAtomic(file, 'ok');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'ok');
    assert.strictEqual(calls, 3);
  });
});

describe('SidecarStore', () => {
  it('debounces several changes into one write', async () => {
    const root = tempDir();
    const key = { root, rel: 'src/a.ts' };
    let threads = [thread('1')];
    let writes = 0;
    const store = new SidecarStore('.codecomments', () => threads, assert.fail, () => writes++, 30);
    store.schedule(key);
    threads = [thread('1'), thread('2')];
    store.schedule(key);
    await new Promise((r) => setTimeout(r, 80));
    await store.flush();
    assert.strictEqual(writes, 1);
    const data = parseSidecar(fs.readFileSync(sidecarPath(root, '.codecomments', 'src/a.ts'), 'utf8'));
    assert.strictEqual(data.threads.length, 2);
  });

  it('deletes the sidecar and its empty folders when the last thread goes', async () => {
    const root = tempDir();
    const key = { root, rel: 'src/deep/a.ts' };
    let threads = [thread('1')];
    const store = new SidecarStore('.codecomments', () => threads, assert.fail, undefined, 1);
    store.schedule(key);
    await store.flush();
    const file = sidecarPath(root, '.codecomments', key.rel);
    assert.ok(fs.existsSync(file));
    threads = [];
    store.schedule(key);
    await store.flush();
    assert.ok(!fs.existsSync(file));
    assert.ok(!fs.existsSync(path.join(root, '.codecomments', 'src')));
    assert.ok(fs.existsSync(path.join(root, '.codecomments')), 'the storage folder itself stays');
  });

  it('only creates sidecars for files with comments', async () => {
    const root = tempDir();
    const store = new SidecarStore('.codecomments', () => [], assert.fail, undefined, 1);
    store.schedule({ root, rel: 'a.ts' });
    await store.flush();
    assert.ok(!fs.existsSync(path.join(root, '.codecomments', 'a.ts.json')));
  });

  it('tells its own writes from changes made by others', async () => {
    const root = tempDir();
    const key = { root, rel: 'a.ts' };
    const store = new SidecarStore('.codecomments', () => [thread('1')], assert.fail, undefined, 1);
    store.schedule(key);
    await store.flush();
    const file = sidecarPath(root, '.codecomments', 'a.ts');
    assert.ok(store.isOwnWrite(file, fs.readFileSync(file, 'utf8')));
    assert.ok(!store.isOwnWrite(file, '{"changed": true}'));
    assert.ok(!store.isOwnWrite(path.join(root, 'other.json'), ''));
  });

  it('never lets a slow older write land after a newer one', async () => {
    const root = tempDir();
    const key = { root, rel: 'a.ts' };
    const file = sidecarPath(root, '.codecomments', 'a.ts');
    const saved = { ...io };
    let threads = [thread('old')];
    let renames = 0;
    // The first rename is slow (Windows retrying a refused rename); later ones are quick.
    io.rename = async (from: string, to: string) => {
      if (++renames === 1) {
        await new Promise((r) => setTimeout(r, 150));
      }
      return saved.rename(from, to);
    };
    try {
      const store = new SidecarStore('.codecomments', () => threads, assert.fail, undefined, 1);
      store.schedule(key);
      await new Promise((r) => setTimeout(r, 20));
      threads = [thread('new')];
      store.schedule(key);
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(store.isOwnWrite(file, undefined), 'events during the writes are ignored');
      await store.flush();
      assert.strictEqual(parseSidecar(fs.readFileSync(file, 'utf8')).threads[0].id, 'new');
      assert.ok(store.isOwnWrite(file, fs.readFileSync(file, 'utf8')));
    } finally {
      Object.assign(io, saved);
    }
  });

  it('writes queued changes to the folder they were queued for, after the folder changes', async () => {
    const root = tempDir();
    const key = { root, rel: 'a.ts' };
    const store = new SidecarStore('.old', () => [thread('1')], assert.fail, undefined, 50);
    store.schedule(key);
    store.setStorageFolder('.new');
    await store.flush();
    assert.ok(fs.existsSync(sidecarPath(root, '.old', 'a.ts')));
    assert.ok(!fs.existsSync(sidecarPath(root, '.new', 'a.ts')), 'nothing lands in the new folder');
    store.schedule(key);
    await store.flush();
    assert.ok(fs.existsSync(sidecarPath(root, '.new', 'a.ts')), 'later writes go to the new folder');
  });

  it('treats its own older content coming back after an external change as a change', async () => {
    const root = tempDir();
    const key = { root, rel: 'a.ts' };
    const store = new SidecarStore('.codecomments', () => [thread('1')], assert.fail, undefined, 1);
    store.schedule(key);
    await store.flush();
    const file = sidecarPath(root, '.codecomments', 'a.ts');
    const ours = fs.readFileSync(file, 'utf8');
    store.acceptExternal(file, '{"external": true}');
    assert.ok(!store.isOwnWrite(file, ours), 'a restore of our earlier content is not an echo');
  });

  it('ignores watcher events while its own write is in flight', async () => {
    const root = tempDir();
    const key = { root, rel: 'a.ts' };
    const file = sidecarPath(root, '.codecomments', 'a.ts');
    const saved = { ...io };
    let release!: () => void;
    io.rename = (from: string, to: string) =>
      new Promise<void>((resolve) => (release = resolve)).then(() => saved.rename(from, to));
    try {
      const store = new SidecarStore('.codecomments', () => [thread('1')], assert.fail, undefined, 1);
      store.schedule(key);
      const flushed = store.flush();
      await new Promise((r) => setTimeout(r, 30));
      // The disk still has no file (or old content): that must not be taken for someone else's change.
      assert.ok(store.isOwnWrite(file, undefined));
      release();
      await flushed;
      assert.ok(!store.isOwnWrite(file, undefined), 'after the write, a missing file is a real deletion');
    } finally {
      Object.assign(io, saved);
    }
  });

  it('loads every sidecar under the storage folder and reports broken ones', async () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, '.codecomments', 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, '.codecomments', 'src', 'a.ts.json'), serialise('src/a.ts', [thread('1')]));
    fs.writeFileSync(path.join(root, '.codecomments', 'b.ts.json'), serialise('b.ts', [thread('2')]));
    fs.writeFileSync(path.join(root, '.codecomments', 'broken.ts.json'), '{');
    const errors: string[] = [];
    const store = new SidecarStore('.codecomments', () => [], (m) => errors.push(m));
    const loaded = await store.loadAll(root);
    assert.deepStrictEqual(loaded.map((l) => l.key.rel).sort(), ['b.ts', 'src/a.ts']);
    assert.strictEqual(errors.length, 1);
  });
});

describe('git exclude', function () {
  this.timeout(20000);

  it('adds the storage folder to .git/info/exclude, once', async () => {
    const repo = gitRepo();
    assert.strictEqual(await setGitExclude(repo, '.codecomments', true), 'added');
    assert.strictEqual(await setGitExclude(repo, '.codecomments', true), 'unchanged');
    const exclude = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
    assert.strictEqual(exclude.split('/.codecomments/').length - 1, 1);
    fs.mkdirSync(path.join(repo, '.codecomments'));
    fs.writeFileSync(path.join(repo, '.codecomments', 'a.json'), '{}');
    assert.strictEqual(git(repo, 'status', '--porcelain'), '', 'git ignores the folder');
    assert.ok(!fs.existsSync(path.join(repo, '.gitignore')), 'the tracked .gitignore is left alone');
  });

  it('removes the line it added, keeping the rest of the file', async () => {
    const repo = gitRepo();
    const file = path.join(repo, '.git', 'info', 'exclude');
    const original = fs.readFileSync(file, 'utf8');
    await setGitExclude(repo, '.codecomments', true);
    assert.strictEqual(await setGitExclude(repo, '.codecomments', false), 'removed');
    assert.strictEqual(fs.readFileSync(file, 'utf8').trimEnd(), original.trimEnd());
    assert.strictEqual(await setGitExclude(repo, '.codecomments', false), 'unchanged');
  });

  it('anchors the pattern to the repository top when the workspace is a subfolder', async () => {
    const repo = gitRepo();
    const sub = path.join(repo, 'packages', 'app');
    fs.mkdirSync(sub, { recursive: true });
    await setGitExclude(sub, '.codecomments', true);
    const exclude = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
    assert.ok(exclude.includes('/packages/app/.codecomments/'));
    assert.strictEqual(excludePattern(repo, sub, '.codecomments'), '/packages/app/.codecomments/');
  });

  it('does nothing outside a git repository', async () => {
    const dir = tempDir();
    assert.strictEqual(await setGitExclude(dir, '.codecomments', true), 'no-git');
    assert.ok(!fs.existsSync(path.join(dir, '.git')));
  });

  it('detects an already-tracked folder, and stops tracking it on request', async () => {
    const repo = gitRepo();
    fs.mkdirSync(path.join(repo, '.codecomments'));
    fs.writeFileSync(path.join(repo, '.codecomments', 'a.json'), '{}');
    git(repo, 'add', '.codecomments');
    git(repo, 'commit', '-q', '-m', 'track');
    assert.strictEqual(await isTrackedByGit(repo, '.codecomments'), true);
    await untrack(repo, '.codecomments');
    assert.strictEqual(await isTrackedByGit(repo, '.codecomments'), false);
    assert.ok(fs.existsSync(path.join(repo, '.codecomments', 'a.json')), 'the files stay on disk');
  });

  it('reports an untracked folder as untracked', async () => {
    const repo = gitRepo();
    assert.strictEqual(await isTrackedByGit(repo, '.codecomments'), false);
  });
});
