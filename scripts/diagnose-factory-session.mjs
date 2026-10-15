// Offline by default; --probe loads a temporary copy in Droid using a dummy key.
// Never reads account credentials, sends a prompt, or modifies the original session.
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const [release, sessionFile, expectedCwd] = process.argv.slice(2);
if (!release || !sessionFile?.endsWith('.jsonl') || !expectedCwd) {
  console.error('Usage: node diagnose-factory-session.mjs RELEASE SESSION.jsonl EXPECTED_CWD');
  process.exit(1);
}
const require = createRequire(join(resolve(release), 'package.json'));
const sdk = require('@factory/droid-sdk/node');
const { FactoryDroidMessageSchema } = sdk;
const report = { expectedCwd, messages: 0, invalidMessages: 0, issues: [], parseErrors: [] };
// Paths and schema codes only; never print message text, tool arguments, or error values.
function issues(errors, prefix = []) {
  return errors.flatMap((issue) => {
    const path = [...prefix, ...issue.path];
    if (issue.unionErrors) return issue.unionErrors.flatMap((e) => issues(e.issues, path));
    return [{ code: issue.code, path: path.map((p) => typeof p === 'number' ? p : String(p).replace(/[^a-zA-Z0-9_]/g, '?').slice(0, 64)) }];
  });
}
try {
  const lines = (await readFile(sessionFile, 'utf8')).split('\n');
  const records = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); }
    catch { report.parseErrors.push(index + 1); continue; }
    records.push(row);
    if (row.type === 'session_start') {
      report.sessionCwd = row.cwd;
      report.cwdMatches = typeof row.cwd === 'string' && resolve(row.cwd) === resolve(expectedCwd);
    }
    if (row.type !== 'message') continue;
    report.messages++;
    // JSONL stores the message id and timestamp on its envelope.
    const timestamp = Date.parse(row.timestamp);
    const parsed = FactoryDroidMessageSchema.safeParse({
      id: row.id,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...row.message,
      content: row.message?.content?.map((block) => block.type === 'tool_result' ? {
        ...block,
        toolUseId: block.toolUseId ?? block.tool_use_id,
        isError: block.isError ?? block.is_error,
      } : block),
    });
    if (!parsed.success) {
      report.invalidMessages++;
      if (report.issues.length < 20)
        report.issues.push({ line: index + 1, issues: issues(parsed.error.issues).slice(0, 30) });
    }
  }
  const settings = JSON.parse(await readFile(sessionFile.replace(/\.jsonl$/, '.settings.json'), 'utf8'));
  report.settings = Object.fromEntries(
    ['model', 'reasoningEffort', 'interactionMode', 'autonomyLevel'].map((key) => [key, settings[key]]),
  );
  report.note = 'Offline format approximation; only the optional probe tests the actual SDK load response.';
  if (process.argv.includes('--probe')) {
    const header = records.find((row) => row.type === 'session_start');
    if (!header || !/^[a-f0-9-]{36}$/i.test(header.id)) throw new Error('Invalid session header');
    const root = await mkdtemp(join(tmpdir(), 'relay-factory-load-'));
    const cwd = join(root, 'project'), home = join(root, 'home');
    const folder = join(home, '.factory', 'sessions', cwd.replaceAll('/', '-'));
    let transport, session;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 45000);
    try {
      await mkdir(cwd, { recursive: true });
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await writeFile(join(folder, header.id + '.jsonl'), records.map((row) => JSON.stringify(
        row.type === 'session_start' ? { ...row, cwd } : row,
      )).join('\n') + '\n', { mode: 0o600 });
      await writeFile(join(folder, header.id + '.settings.json'), JSON.stringify(settings), { mode: 0o600 });
      // Isolate configuration and use a dummy key. Never send a user message or run inference.
      for (const key of Object.keys(process.env))
        if (/^(FACTORY_|DROID_|ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_|GEMINI_|GOOGLE_|DEEPSEEK_|DSH_)/.test(key)) delete process.env[key];
      Object.assign(process.env, {
        HOME: home, FACTORY_HOME_OVERRIDE: home,
        XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
        XDG_DATA_HOME: join(home, '.local/share'),
      });
      process.chdir(cwd);
      transport = new sdk.ProcessTransport({
        droidExecPath: join(resolve(release), 'node_modules/.bin/droid'),
        cwd, env: { FACTORY_API_KEY: 'fk-local-format-probe-no-inference' },
      });
      await transport.connect();
      const onMessage = transport.onMessage.bind(transport);
      report.probe = {};
      transport.onMessage = (handler) => onMessage((raw) => {
        try {
          const response = JSON.parse(raw);
          if (response.type === 'response' && response.result?.session) {
            const parsed = sdk.LoadSessionResponseSchema.safeParse(response);
            report.probe.responseValid = parsed.success;
            report.probe.cwdMatches = response.result.cwd === cwd;
            if (!parsed.success) report.probe.issues = issues(parsed.error.issues).slice(0, 40);
          }
          if (response.type === 'response' && response.error) {
            report.probe.rpcErrorCode = response.error.code;
            try {
              const details = JSON.parse(response.error.message);
              if (Array.isArray(details)) report.probe.rpcIssues = issues(details).slice(0, 40);
            } catch { /* Do not print arbitrary error messages or history. */ }
          }
        } catch { /* SDK handles malformed transport messages. */ }
        handler(raw);
      });
      try {
        session = await sdk.resumeSession(header.id, { transport, abortSignal: abort.signal });
        report.probe.resumed = true;
        report.probe.sdkCwdMatches = session.cwd === cwd;
      } catch (error) {
        report.probe.resumed = false;
        report.probe.errorType = error.name;
        if (Array.isArray(error.issues)) report.probe.issues = issues(error.issues).slice(0, 40);
      }
    } finally {
      clearTimeout(timer);
      await session?.close().catch(() => {});
      await transport?.close().catch(() => {});
      process.chdir(tmpdir());
      await rm(root, { recursive: true, force: true });
    }
  }
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: error.code ?? error.name }));
  process.exitCode = 1;
}
