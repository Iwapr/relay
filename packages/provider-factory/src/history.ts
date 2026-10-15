import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  NativeSessionHistory,
  NativeSessionSummary,
  NativeSessionTurn,
} from '../../provider-core/src/index.ts';

export const factorySessionId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function sessionFile(home: string, id: string) {
  if (!factorySessionId.test(id)) throw new Error('Droid 会话标识无效');
  return join(home, 'relay-sessions', id + '.json');
}
export function saveTurn(home: string, id: string, turn: NativeSessionTurn) {
  sessionFile(home, id);
  if (!factorySessionId.test(turn.id)) throw new Error('Droid 轮次标识无效');
  const dir = join(home, 'relay-history', id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, turn.id + '.json');
  const temp = target + '.' + randomUUID();
  writeFileSync(temp, JSON.stringify(turn), { mode: 0o600 });
  renameSync(temp, target);
}
export async function sessionSummary(home: string, id: string): Promise<NativeSessionSummary> {
  const file = sessionFile(home, id);
  const record = JSON.parse(await readFile(file, 'utf8'));
  if (typeof record.cwd !== 'string' || !record.cwd.startsWith('/')) throw new Error('Droid 会话目录无效');
  let metadata: { title?: string; updatedAt?: string } = {};
  try {
    metadata = JSON.parse(await readFile(join(home, 'relay-history', id, 'metadata.json'), 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const info = await stat(file);
  return {
    id,
    cwd: record.cwd,
    title: metadata.title || record.title || 'Droid 会话',
    updatedAt: record.updatedAt || metadata.updatedAt || info.mtime.toISOString(),
    source: 'relay',
  };
}
export async function sessionHistory(home: string, id: string, limit = 100): Promise<NativeSessionHistory> {
  const summary = await sessionSummary(home, id);
  const dir = join(home, 'relay-history', id);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    files = [];
  }
  const turns: NativeSessionTurn[] = [];
  for (const file of files.filter(
    (f) => factorySessionId.test(f.replace(/\.json$/, '')) && f.endsWith('.json'),
  )) {
    const turn = JSON.parse(await readFile(join(dir, file), 'utf8')) as NativeSessionTurn;
    // An interrupted host cannot establish whether the old process is still executing.
    if (turn.state === 'running') turn.state = 'unknown';
    turns.push(turn);
  }
  turns.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id));
  const size = Math.max(1, Math.min(100, limit));
  return {
    ...summary,
    turns: turns.slice(-size),
    hasOlderTurns: turns.length > size,
    truncated: turns.length > size,
  };
}
export async function listSessions(home: string, cwd: string, cursor?: string, scope = 'workspace') {
  let files: string[];
  try {
    files = await readdir(join(home, 'relay-sessions'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    files = [];
  }
  const sessions: NativeSessionSummary[] = [];
  for (const file of files.filter((f) => f.endsWith('.json') && factorySessionId.test(f.slice(0, -5)))) {
    const summary = await sessionSummary(home, file.slice(0, -5));
    if (scope === 'all' || summary.cwd === cwd) sessions.push(summary);
  }
  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const offset = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0;
  return {
    sessions: sessions.slice(offset, offset + 50),
    nextCursor: offset + 50 < sessions.length ? String(offset + 50) : null,
  };
}
