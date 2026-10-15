import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageRuntime } from '../packages/provider-core/src/runtime.ts';
import { CodexAdapter } from '../packages/provider-codex/src/index.ts';

const exec = promisify(execFile);
for (const [name, command] of [
  ['@openai/codex', 'codex'],
  ['@anthropic-ai/claude-code', 'claude'],
  ['@moonshot-ai/kimi-code', 'kimi'],
  ['droid', 'droid'],
  ['@deepseek-ai/dsh', 'dsh'],
]) {
  const runtime = packageRuntime(name!, command!);
  await exec(runtime.executable, ['--version'], { timeout: 30_000 });
  console.log(`${command}: ${runtime.version}`);
}
// Validate a real app-server handshake and model response without touching user auth.
const home = await mkdtemp(join(tmpdir(), 'relay-codex-compat-'));
const adapter = new CodexAdapter({
  cwd: home,
  codexHome: home,
  credentialStore: 'file',
  executable: packageRuntime('@openai/codex', 'codex').executable,
});
try {
  await adapter.diagnostics();
  await adapter.listModels();
} finally {
  await adapter.close();
  await rm(home, { recursive: true, force: true });
}
