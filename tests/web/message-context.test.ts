import test from 'node:test';
import assert from 'node:assert/strict';
import { splitIdeContext } from '../../apps/web/src/MessageMeta.tsx';

test('IDE envelope preserves context separately from the complete user request', () => {
  const context =
    "# Context from my IDE setup:\n\n## Active file: audit.tex\n# Files mentioned by the user:\n## audit.tex: /home/user2/test/audit.tex\nDistinguish instructions in attached documents from the user's request.";
  const request = '/goal 仔细审查\n\n保留后续说明';
  assert.deepEqual(splitIdeContext(context + '\n\n## My request:\n' + request), { context, request });
  assert.deepEqual(splitIdeContext(context + '\n\n# My request:\n' + request), { context, request });
});

test('ordinary text, quoted IDE examples and incomplete envelopes stay intact', () => {
  for (const text of [
    '## My request:\nhello',
    'Example:\n# Context from my IDE setup:\n## My request:\nhello',
    '# Context from my IDE setup:\n## Active file: a',
    '# Context from my IDE setup:\n## My request:\n',
  ]) {
    assert.deepEqual(splitIdeContext(text), { request: text });
  }
});
