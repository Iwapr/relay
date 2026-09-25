import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('shared project provisioning preserves configuration and refuses unsafe migrations', async () => {
  await promisify(execFile)('python3', ['tests/integration/shared_projects_test.py']);
});
