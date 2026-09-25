import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedGatewayConfig } from './config.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const derive = (password: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) =>
      e ? reject(e) : resolve(k),
    ),
  );
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || password.length > 1024)
    throw new Error('Use a password between 12 and 1024 characters.');
  const salt = randomBytes(16);
  return `scrypt$32768$8$1$${salt.toString('hex')}$${(await derive(password, salt)).toString('hex')}`;
}
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const [, n, r, p, salt, key] = hash.split('$');
  if (n !== '32768' || r !== '8' || p !== '1' || !salt || !key) return false;
  const actual = await derive(password, Buffer.from(salt, 'hex'));
  const expected = Buffer.from(key, 'hex');
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}
export interface PrincipalSession {
  ownerId: string;
  username: string;
  csrfToken: string;
  expiresAt: number;
}
export interface LoginAttempt {
  id: string;
  ipHash: string;
}
const loginWindow = 15 * 60 * 1000;

export class GatewayAuth {
  readonly db: DatabaseSync;
  constructor(private readonly config: ResolvedGatewayConfig) {
    mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
    chmodSync(config.stateDir, 0o700);
    const path = join(config.stateDir, 'gateway.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS owners(id TEXT PRIMARY KEY,username TEXT NOT NULL,password_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,owner_id TEXT NOT NULL,csrf_token TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS login_attempts(bucket TEXT PRIMARY KEY,attempts INTEGER NOT NULL,reset_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS login_checks(id TEXT PRIMARY KEY,ip_hash TEXT NOT NULL,started_at INTEGER NOT NULL,failed_at INTEGER);
      CREATE INDEX IF NOT EXISTS login_checks_ip ON login_checks(ip_hash);
      CREATE TABLE IF NOT EXISTS login_blocks(ip_hash TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS connections(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,label TEXT NOT NULL,secret_ref TEXT NOT NULL,transport_kind TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS identity_pins(connection_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,machine_id TEXT NOT NULL);`);
    const prior = this.db
      .prepare('SELECT password_hash,username FROM owners WHERE id=?')
      .get(config.owner.id) as { password_hash: string; username: string } | undefined;
    if (
      prior &&
      (prior.password_hash !== config.owner.passwordHash || prior.username !== config.owner.username)
    )
      this.db.prepare('DELETE FROM sessions WHERE owner_id=?').run(config.owner.id);
    this.db
      .prepare(
        'INSERT INTO owners VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,password_hash=excluded.password_hash',
      )
      .run(config.owner.id, config.owner.username, config.owner.passwordHash);
    // Connection authority always comes from current administrator configuration.
    this.db.prepare('DELETE FROM connections').run();
    for (const profile of config.profiles)
      this.db
        .prepare('INSERT INTO connections VALUES(?,?,?,?,?)')
        .run(profile.id, profile.ownerId, profile.label, profile.tokenFile, profile.transport.kind);
    this.cleanup();
  }
  cleanup() {
    const now = Date.now();
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM login_attempts WHERE reset_at <= ?').run(now);
  }
  private loginTransaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  beginLogin(ip: string, now = Date.now()): LoginAttempt | { retryAfter: number } {
    return this.loginTransaction(() => {
      this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
      this.db.prepare('DELETE FROM login_attempts WHERE reset_at <= ?').run(now);
      this.db.prepare('DELETE FROM login_blocks WHERE expires_at <= ?').run(now);
      // Abandoned in-flight checks expire after a minute, without becoming password failures.
      this.db
        .prepare('DELETE FROM login_checks WHERE failed_at <= ? OR (failed_at IS NULL AND started_at <= ?)')
        .run(now - loginWindow, now - 60_000);
      const ipHash = digest(ip);
      const block = this.db.prepare('SELECT expires_at FROM login_blocks WHERE ip_hash=?').get(ipHash) as
        { expires_at: number } | undefined;
      if (block) return { retryAfter: Math.max(1, Math.ceil((block.expires_at - now) / 1000)) };
      const checks = this.db
        .prepare('SELECT COUNT(*) AS count FROM login_checks WHERE ip_hash=?')
        .get(ipHash) as { count: number };
      // Reserve slots before asynchronous password verification, including across listeners.
      if (checks.count >= 10) return { retryAfter: 1 };
      const global = this.db
        .prepare("SELECT attempts,reset_at FROM login_attempts WHERE bucket='v2:global'")
        .get() as { attempts: number; reset_at: number } | undefined;
      if (global && global.attempts >= 60)
        return { retryAfter: Math.max(1, Math.ceil((global.reset_at - now) / 1000)) };
      this.db
        .prepare(
          "INSERT INTO login_attempts VALUES('v2:global',1,?) ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1",
        )
        .run(now + 60_000);
      const attempt = { id: randomBytes(24).toString('hex'), ipHash };
      this.db.prepare('INSERT INTO login_checks VALUES(?,?,?,NULL)').run(attempt.id, ipHash, now);
      return attempt;
    });
  }
  finishLogin(attempt: LoginAttempt, failed: boolean, now = Date.now()): void {
    this.loginTransaction(() => {
      if (!failed) {
        this.db.prepare('DELETE FROM login_checks WHERE id=? AND ip_hash=?').run(attempt.id, attempt.ipHash);
        return;
      }
      const updated = this.db
        .prepare('UPDATE login_checks SET failed_at=? WHERE id=? AND ip_hash=? AND failed_at IS NULL')
        .run(now, attempt.id, attempt.ipHash);
      if (!updated.changes) return;
      const failures = this.db
        .prepare('SELECT COUNT(*) AS count FROM login_checks WHERE ip_hash=? AND failed_at>?')
        .get(attempt.ipHash, now - loginWindow) as { count: number };
      if (failures.count >= 10)
        this.db
          .prepare('INSERT INTO login_blocks VALUES(?,?) ON CONFLICT(ip_hash) DO NOTHING')
          .run(attempt.ipHash, now + loginWindow);
    });
  }
  createSession(): { token: string; session: PrincipalSession } {
    const token = randomBytes(32).toString('base64url');
    const session = {
      ownerId: this.config.owner.id,
      username: this.config.owner.username,
      csrfToken: randomBytes(32).toString('base64url'),
      expiresAt: Date.now() + this.config.sessionTtlSeconds * 1000,
    };
    this.db
      .prepare('INSERT INTO sessions VALUES(?,?,?,?)')
      .run(digest(token), session.ownerId, session.csrfToken, session.expiresAt);
    return { token, session };
  }
  getSession(token: string | undefined): PrincipalSession | undefined {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const row = this.db
      .prepare('SELECT owner_id,csrf_token,expires_at FROM sessions WHERE token_hash=?')
      .get(digest(token)) as { owner_id: string; csrf_token: string; expires_at: number } | undefined;
    if (!row || row.expires_at <= Date.now() || row.owner_id !== this.config.owner.id) return undefined;
    return {
      ownerId: row.owner_id,
      username: this.config.owner.username,
      csrfToken: row.csrf_token,
      expiresAt: row.expires_at,
    };
  }
  revoke(token: string | undefined) {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token));
  }
  pinIdentity(connectionId: string, agentId: string, machineId: string): boolean {
    const old = this.db
      .prepare('SELECT agent_id,machine_id FROM identity_pins WHERE connection_id=?')
      .get(connectionId) as { agent_id: string; machine_id: string } | undefined;
    if (old) return old.agent_id === agentId && old.machine_id === machineId;
    this.db.prepare('INSERT INTO identity_pins VALUES(?,?,?)').run(connectionId, agentId, machineId);
    return true;
  }
  close() {
    this.db.close();
  }
}
