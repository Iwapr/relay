import { constants } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Conversation, Run } from '../../contracts/src/index.ts';
type Message = { id: string; runId: string; kind: string; text: string; payload: Record<string, unknown> };
import { factorySessionId, saveTurn } from './history.ts';

/** Runs before any Droid child starts. Copies only history, never credentials/configuration.
 * Originals remain intact; completed migrations never overwrite subsequently updated sessions. */
export async function migrateFactoryHistory(source: string, target: string, database?: string) {
  if (source === target) return;
  const marker = join(target, 'relay-migrations', createHash('sha256').update(source).digest('hex'));
  try {
    await lstat(marker);
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  async function copyTree(from: string, to: string) {
    let entries;
    try {
      if (!(await lstat(from)).isDirectory()) throw new Error('Droid 历史目录不能是符号链接');
      entries = await readdir(from, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    await mkdir(to, { recursive: true, mode: 0o700 });
    for (const entry of entries) {
      const old = join(from, entry.name),
        next = join(to, entry.name);
      if (entry.isDirectory()) {
        await copyTree(old, next);
        continue;
      }
      if (!entry.isFile()) throw new Error('Droid 历史包含非普通文件');
      if (!/\.(json|jsonl)$/.test(entry.name)) continue;
      try {
        await copyFile(old, next, constants.COPYFILE_EXCL);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        if (!(await lstat(next)).isFile() || !(await readFile(old)).equals(await readFile(next)))
          throw new Error('Droid 历史 ID 冲突，已保留原记录并停止迁移');
      }
    }
  }
  await copyTree(join(source, '.factory', 'sessions'), join(target, '.factory', 'sessions'));
  await copyTree(join(source, 'relay-sessions'), join(target, 'relay-sessions'));
  if (database) {
    let exists = false;
    try {
      exists = (await lstat(database)).isFile();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (exists) {
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        const rows = <T>(kind: string) =>
          (db.prepare('SELECT data FROM objects WHERE kind=?').all(kind) as { data: string }[]).map(
            (r) => JSON.parse(r.data) as T,
          );
        const conversations = rows<Conversation>('conversation'),
          runs = rows<Run>('run'),
          messages = rows<Message>('message');
        for (const c of conversations.filter(
          (c) =>
            c.providerId === 'factory' && c.providerSessionId && factorySessionId.test(c.providerSessionId),
        )) {
          const metadataDir = join(target, 'relay-history', c.providerSessionId!);
          await mkdir(metadataDir, { recursive: true, mode: 0o700 });
          const latest = runs
            .filter((r) => r.conversationId === c.id)
            .map((r) => r.createdAt)
            .sort()
            .at(-1);
          await writeFile(
            join(metadataDir, 'metadata.json'),
            JSON.stringify({
              title: c.title,
              ...(latest ? { updatedAt: latest } : {}),
            }),
            { mode: 0o600 },
          );
          for (const r of runs.filter(
            (r) => r.conversationId === c.id && r.providerTurnId && factorySessionId.test(r.providerTurnId),
          )) {
            saveTurn(target, c.providerSessionId!, {
              id: r.providerTurnId!,
              userText: r.text,
              createdAt: r.createdAt,
              state: ['completed', 'failed', 'cancelled', 'interrupted'].includes(r.state)
                ? (r.state as 'completed')
                : 'unknown',
              messages: messages
                .filter((m) => m.runId === r.id && (m.kind === 'assistant' || m.kind === 'tool'))
                .map((m) => ({
                  id: String(m.payload.itemId ?? m.id),
                  kind: m.kind as 'assistant' | 'tool',
                  text: m.text,
                })),
            });
          }
        }
      } finally {
        db.close();
      }
    }
  }
  await mkdir(join(target, 'relay-migrations'), { recursive: true, mode: 0o700 });
  await writeFile(marker, '1', { mode: 0o600 });
}
