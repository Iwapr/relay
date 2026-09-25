import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { AppError, type WorkbenchEvent } from '../../../packages/contracts/src/index.ts';

export class Store {
  readonly db: DatabaseSync;
  readonly events = new EventEmitter();
  private pending: WorkbenchEvent[] | null = null;
  constructor(
    directory: string,
    public agentId: string,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const path = join(directory, 'agent.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS objects(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
   CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,hash TEXT NOT NULL,result TEXT NOT NULL);
   PRAGMA user_version=1;`);
    this.events.setMaxListeners(100);
  }
  get<T>(kind: string, id: string): T | undefined {
    const r = this.db.prepare('SELECT data FROM objects WHERE kind=? AND id=?').get(kind, id) as
      { data: string } | undefined;
    return r ? JSON.parse(r.data) : undefined;
  }
  require<T>(kind: string, id: string): T {
    const x = this.get<T>(kind, id);
    if (!x) throw new AppError('not_found', '找不到请求的资源', 404);
    return x;
  }
  list<T>(kind: string): T[] {
    return (
      this.db.prepare('SELECT data FROM objects WHERE kind=? ORDER BY rowid').all(kind) as { data: string }[]
    ).map((x) => JSON.parse(x.data));
  }
  conversationObjects<T>(kind: string, conversationId: string): T[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM objects WHERE kind=? AND json_extract(data,'$.conversationId')=? ORDER BY rowid",
        )
        .all(kind, conversationId) as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  put(kind: string, id: string, value: unknown) {
    this.db
      .prepare('INSERT INTO objects VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data')
      .run(kind, id, JSON.stringify(value));
  }
  remove(kind: string, id: string) {
    this.db.prepare('DELETE FROM objects WHERE kind=? AND id=?').run(kind, id);
  }
  transaction<T>(fn: () => T): T {
    if (this.pending) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.pending = [];
    let result: T, events: WorkbenchEvent[];
    try {
      result = fn();
      this.db.exec('COMMIT');
      events = this.pending;
      this.pending = null;
    } catch (e) {
      this.db.exec('ROLLBACK');
      this.pending = null;
      throw e;
    }
    for (const event of events) this.events.emit('event', event);
    return result;
  }
  emit(
    type: string,
    payload: Record<string, unknown>,
    ids: { workspaceId?: string; conversationId?: string; runId?: string } = {},
  ): WorkbenchEvent {
    if (!this.pending) return this.transaction(() => this.emit(type, payload, ids));
    const draft = {
      agentId: this.agentId,
      version: 1 as const,
      type,
      ...ids,
      payload,
      createdAt: new Date().toISOString(),
    };
    const row = this.db.prepare('INSERT INTO events(data) VALUES(?)').run(JSON.stringify(draft));
    const event = { ...draft, seq: Number(row.lastInsertRowid) };
    this.pending.push(event);
    return event;
  }
  sequence() {
    return Number(
      (this.db.prepare('SELECT coalesce(max(seq),0) AS seq FROM events').get() as { seq: number }).seq,
    );
  }
  replayFloor() {
    return Math.max(
      0,
      Number(
        (this.db.prepare('SELECT coalesce(min(seq),1)-1 AS seq FROM events').get() as { seq: number }).seq,
      ),
    );
  }
  /** Deduplication receipts are deliberately never aged out automatically. */
  prune(limits: { events?: number; messages?: number; changes?: number } = {}) {
    const events = Math.max(1, limits.events ?? 10000),
      messages = Math.max(1, limits.messages ?? 2000),
      changes = Math.max(1, limits.changes ?? 2000);
    this.transaction(() => {
      this.db
        .prepare(
          'DELETE FROM events WHERE seq < coalesce((SELECT seq FROM events ORDER BY seq DESC LIMIT 1 OFFSET ?),0)',
        )
        .run(events - 1);
      for (const [kind, limit] of [
        ['message', messages],
        ['fileChange', changes],
      ] as const)
        this.db
          .prepare(
            'DELETE FROM objects WHERE kind=? AND rowid NOT IN (SELECT rowid FROM objects WHERE kind=? ORDER BY rowid DESC LIMIT ?)',
          )
          .run(kind, kind, limit);
    });
  }
  replay(after: number, limit = 1000): WorkbenchEvent[] {
    return (
      this.db.prepare('SELECT seq,data FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(after, limit) as {
        seq: number;
        data: string;
      }[]
    ).map((x) => ({ ...JSON.parse(x.data), seq: x.seq }));
  }
  history(conversationId: string, after = 0, limit = 500): WorkbenchEvent[] {
    return (
      this.db
        .prepare(
          "SELECT seq,data FROM events WHERE seq>? AND json_extract(data,'$.conversationId')=? ORDER BY seq LIMIT ?",
        )
        .all(after, conversationId, limit) as { seq: number; data: string }[]
    ).map((x) => ({ ...JSON.parse(x.data), seq: x.seq }));
  }
  receipt<T>(id: string, payload: unknown, fn: () => T): T {
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    return this.transaction(() => {
      const old = this.db.prepare('SELECT hash,result FROM receipts WHERE id=?').get(id) as
        { hash: string; result: string } | undefined;
      if (old) {
        if (old.hash !== hash) throw new AppError('run_conflict', '相同请求 ID 的内容不同', 409);
        return JSON.parse(old.result);
      }
      const value = fn();
      this.db.prepare('INSERT INTO receipts VALUES(?,?,?)').run(id, hash, JSON.stringify(value));
      return value;
    });
  }
  close() {
    this.db.close();
  }
}
