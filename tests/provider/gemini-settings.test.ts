import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readGeminiSettings,
  writeGeminiSettings,
  settingsPath,
} from '../../packages/provider-gemini/src/settings.ts';
import { classifyGeminiError } from '../../packages/provider-gemini/src/index.ts';
test('Gemini permission editing preserves advanced rules, detects conflicting edits, and rejects shell syntax', async () => {
  const home = await mkdtemp(join(tmpdir(), 'relay-gemini-settings-'));
  try {
    await readGeminiSettings(home);
    const p = settingsPath(home);
    await writeFile(
      p,
      JSON.stringify({
        colorScheme: 'terminal',
        permissions: {
          allow: ['command(ls)', 'read_file(/docs)'],
          ask: ['command(sudo)'],
          deny: ['write_file(.git/)'],
        },
      }),
    );
    const settings = await readGeminiSettings(home);
    assert.equal(settings.additionalRules, 3);
    const input = {
      revision: settings.revision,
      allowedCommands: ['python -m pytest'],
      deniedCommands: ['git push'],
    };
    const updated = await writeGeminiSettings(home, input);
    assert.deepEqual(updated.allowedCommands, ['python -m pytest']);
    const saved = JSON.parse(await readFile(p, 'utf8'));
    assert.equal(saved.colorScheme, 'terminal');
    assert.deepEqual(saved.permissions.ask, ['command(sudo)']);
    assert.ok(saved.permissions.deny.includes('write_file(.git/)'));
    await assert.rejects(writeGeminiSettings(home, input), /变化/);
    for (const bad of ['*', 'ls; rm -rf /', 'ls\ncat', 'regex:.*', 'echo $(id)', 'ls)'])
      await assert.rejects(
        writeGeminiSettings(home, { ...input, revision: updated.revision, allowedCommands: [bad] }),
      );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test('Gemini errors identify recovery action without returning raw credentials', () => {
  for (const [text, expected] of [
    ['429 resource exhausted token=secret', '额度'],
    ['invalid_grant token=secret', '登录'],
    ['connection refused secret', '网络'],
    ['deadline exceeded secret', '超时'],
    ['invalid model secret', '模型'],
    ['sandbox namespace secret', '沙箱'],
  ]) {
    const result = classifyGeminiError(text);
    assert.match(result, new RegExp(expected));
    assert.doesNotMatch(result, /secret/);
  }
});
