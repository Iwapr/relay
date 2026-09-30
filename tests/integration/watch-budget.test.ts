import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watch } from 'chokidar';
import { WatchBudget } from '../../apps/agent/src/watch-budget.ts';

test('watch limits span account scopes, keep existing paths, and release capacity on removal/close', () => {
  const budget = new WatchBudget(3);
  let warnings = 0;
  const a = budget.scope(2, () => warnings++);
  const b = budget.scope(3, () => warnings++);
  assert.ok(a.accept('/project'));
  assert.ok(a.accept('/project/a'));
  assert.ok(a.accept('/project/a'));
  assert.equal(a.accept('/project/b'), false);
  assert.equal(a.accept('/project/c'), false);
  assert.equal(warnings, 1);
  assert.ok(b.accept('/other'));
  assert.equal(b.accept('/other/a'), false);
  assert.equal(warnings, 2);
  a.forget('/project');
  assert.ok(b.accept('/other/a'));
  assert.ok(b.accept('/other/b'));
  b.close();
  b.close();
  assert.equal(b.accept('/closed'), false);
  assert.ok(a.accept('/new'));
  assert.ok(a.accept('/new/a'));
  const c = budget.scope(3, () => {});
  assert.ok(c.accept('/third'));
  assert.equal(c.accept('/third/a'), false);
  a.close();
  c.close();
});

test('a wide directory reaches watcher ready within its budget and still observes admitted files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-watch-budget-'));
  const budget = new WatchBudget(40);
  let warnings = 0;
  const scope = budget.scope(25, () => warnings++);
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    for (let i = 0; i < 10; i++) {
      const directory = join(root, String(i));
      await mkdir(directory);
      await writeFile(join(directory, 'file.txt'), 'before');
      for (let j = 0; j < 10; j++) await writeFile(join(directory, `extra-${j}.txt`), 'before');
    }
    watcher = watch(root, { ignoreInitial: true, ignored: (path) => !scope.accept(path) });
    await once(watcher, 'ready');
    assert.equal(warnings, 1);
    const watched = Object.entries(watcher.getWatched());
    assert.ok(watched.reduce((count, [, entries]) => count + entries.length, 0) <= 25);
    const [directory, entries] = watched.find(([, entries]) =>
      entries.some((name) => name.endsWith('.txt')),
    )!;
    const file = entries.find((name) => name.endsWith('.txt'))!;
    const changed = once(watcher, 'change', { signal: AbortSignal.timeout(5000) });
    await writeFile(join(directory, file), 'after');
    assert.equal((await changed)[0], join(directory, file));
  } finally {
    await watcher?.close();
    scope.close();
    await rm(root, { recursive: true, force: true });
  }
});
