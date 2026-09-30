import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '../../contracts/src/index.ts';
import type { NativeSessionSummary } from '../../provider-core/src/index.ts';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export interface GeminiNativeSummary extends NativeSessionSummary {
  nativeId: string;
  busy: boolean;
}
/** Read-only discovery of the schema-checked 1.2.13 index; opaque message blobs are never decoded or modified. */
export function geminiHistory(home: string): GeminiNativeSummary[] {
  const filename = join(home, '.gemini', 'antigravity-cli', 'conversation_summaries.db');
  if (!existsSync(filename)) return [];
  if (!lstatSync(filename).isFile() || lstatSync(filename).isSymbolicLink())
    throw new AppError('permission_denied', 'Gemini 会话索引路径无效', 403);
  const aliases = new Map<string, string>();
  const maps = join(home, 'relay-sessions');
  if (existsSync(maps))
    for (const name of readdirSync(maps).slice(0, 10000)) {
      if (!uuid.test(name.replace(/\.json$/, '')) || !name.endsWith('.json')) continue;
      const path = join(maps, name);
      try {
        if (!lstatSync(path).isFile() || lstatSync(path).size > 2048) continue;
        const { nativeId } = JSON.parse(readFileSync(path, 'utf8'));
        if (uuid.test(nativeId)) aliases.set(nativeId, name.slice(0, -5));
      } catch {}
    }
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const rows = db
      .prepare(
        'SELECT conversation_id,title,workspace_uris,last_modified_time,status,not_fully_idle,parent_conversation_id,nesting_depth FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT 2000',
      )
      .all();
    return rows.flatMap((row) => {
      if (
        typeof row.conversation_id !== 'string' ||
        !uuid.test(row.conversation_id) ||
        row.parent_conversation_id ||
        Number(row.nesting_depth) > 0
      )
        return [];
      try {
        const roots = JSON.parse(String(row.workspace_uris));
        if (
          !Array.isArray(roots) ||
          roots.length !== 1 ||
          typeof roots[0] !== 'string' ||
          !roots[0].startsWith('file:///')
        )
          return [];
        const cwd = fileURLToPath(roots[0]);
        const date = new Date(String(row.last_modified_time));
        if (!Number.isFinite(date.getTime())) return [];
        const busy =
          !!row.not_fully_idle ||
          !/IDLE|COMPLETED|CANCELED|CANCELLED|ERROR|INTERRUPTED/.test(String(row.status));
        return [
          {
            id: aliases.get(row.conversation_id) ?? row.conversation_id,
            nativeId: row.conversation_id,
            title: String(row.title ?? 'Gemini 会话').slice(0, 200),
            cwd,
            updatedAt: date.toISOString(),
            source: 'Antigravity · 仅接续',
            status: busy ? 'running' : 'idle',
            busy,
          },
        ];
      } catch {
        return [];
      }
    });
  } catch {
    throw new AppError(
      'unsupported_feature',
      '当前 Antigravity 会话索引格式无法识别，Relay 自建会话仍可使用',
      409,
    );
  } finally {
    db.close();
  }
}
