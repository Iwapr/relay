import test from 'node:test';
import assert from 'node:assert/strict';
import { save, saved } from '../../apps/web/src/api.ts';

test('preferences survive tab loss, migrate old values, and never persist drafts or pending requests', () => {
  const priorSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const priorLocal = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const session = new Map<string, string>();
  const local = new Map<string, string>();
  const storage = (map: Map<string, string>) => ({
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => map.set(key, value),
  });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage(session) });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage(local) });
  try {
    session.set('relay:server:project:mode', JSON.stringify('workspace-write'));
    assert.equal(saved('server:project:mode', 'read-only'), 'workspace-write');
    assert.equal(local.get('relay:server:project:mode'), JSON.stringify('workspace-write'));
    save('server:project:draft', 'private task text');
    save('server:project:pending', { id: 'private-request' });
    assert.equal(local.has('relay:server:project:draft'), false);
    assert.equal(local.has('relay:server:project:pending'), false);
    save('server:project:conversation', 'recent-session');
    session.clear();
    assert.equal(saved('server:project:conversation', ''), 'recent-session');
    assert.equal(saved('server:project:mode', 'read-only'), 'workspace-write');
    assert.equal(saved('server:other-project:mode', 'read-only'), 'read-only');
    assert.equal(saved('other-server:project:mode', 'read-only'), 'read-only');
    save('server:project:mode', 'read-only');
    session.clear();
    assert.equal(saved('server:project:mode', 'workspace-write'), 'read-only');
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get: () => {
        throw new Error('storage unavailable');
      },
    });
    save('server:project:mode', 'workspace-write');
    assert.equal(saved('server:project:mode', 'read-only'), 'workspace-write');
  } finally {
    if (priorSession) Object.defineProperty(globalThis, 'sessionStorage', priorSession);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
    if (priorLocal) Object.defineProperty(globalThis, 'localStorage', priorLocal);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
