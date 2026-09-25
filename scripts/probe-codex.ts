/** Safe metadata probe by default. --write adds one bounded task in .runtime/probe. */
import { mkdir, readFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { CodexAdapter } from '../packages/provider-codex/src/index.ts';
import type { ProviderEvent, ProviderRunRef } from '../packages/provider-core/src/index.ts';
import { codexExecutable } from './codex-executable.ts';

const write = process.argv.includes('--write');
const approval = process.argv.includes('--approval');
const cancel = process.argv.includes('--cancel');
const cwd = write || approval || cancel ? resolve('.runtime/probe') : process.cwd();
if (write || approval || cancel) await mkdir(cwd, { recursive: true, mode: 0o700 });
const executable = await codexExecutable({ configured: true });
const adapter = new CodexAdapter({ cwd, executable });
const report: Record<string, unknown> = {
  timestamp: new Date().toISOString(),
  mode: cancel ? 'cancel' : approval ? 'approval' : write ? 'write' : 'metadata',
  cwd,
};
try {
  report.protocol = await adapter.diagnostics();
  const account = await adapter.getAccount();
  report.account = {
    ...account,
    identifier: account.identifier ? '[verified; omitted from probe report]' : null,
  };
  const models = await adapter.listModels();
  report.models = models;
  report.quota = await adapter.getQuota();
  if (write || approval || cancel) {
    if (!account.authenticated || account.authMode !== 'chatgpt')
      throw new Error(
        'Write probe requires existing ChatGPT authentication; no login or config changes were made.',
      );
    const model = models.find((model) => model.isDefault)?.id ?? models[0]?.id;
    if (!model) throw new Error('No account model available');
    const file = approval ? 'approval-result.txt' : 'probe-result.txt';
    const target = join(cwd, file);
    if (!cancel)
      try {
        await access(target);
        throw new Error(`Probe file already exists: ${target}. Move it before running this probe again.`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    const permissionMode = approval || cancel ? 'read-only' : 'workspace-write';
    const session = await adapter.createSession({ cwd, model, permissionMode });
    report.session = session;
    let run: ProviderRunRef | undefined;
    let finish: (event: ProviderEvent) => void = () => {};
    const finished = new Promise<ProviderEvent>((resolve) => {
      finish = resolve;
    });
    const events: Array<Record<string, unknown>> = [];
    const unsubscribe = adapter.subscribeEvents((event) => {
      if (event.sessionId !== session.id) return;
      events.push({
        type: event.type,
        turnId: event.turnId,
        ...(event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.settings'
          ? { payload: event.payload }
          : {}),
      });
      if (event.type === 'interaction.required') {
        const item = event.payload.item as { type?: string; changes?: Array<{ path: string }> } | undefined;
        // This harness can approve only the exact one-file patch explicitly requested above.
        const exactPatch =
          approval &&
          event.payload.method === 'item/fileChange/requestApproval' &&
          !event.payload.grantRoot &&
          item?.type === 'fileChange' &&
          item.changes?.length === 1 &&
          resolve(cwd, item.changes[0]!.path) === target;
        void adapter
          .answerInteraction({
            requestId: event.payload.requestId as string | number,
            generation: event.generation,
            decision: exactPatch ? 'accept' : 'decline',
          })
          .then(() => {
            report.approval = exactPatch
              ? 'approved exact requested file patch once'
              : 'declined unsupported or broader approval';
          })
          .catch((error) => {
            report.approvalError = (error as Error).message;
          });
      }
      if (event.type === 'run.completed' || event.type === 'run.failed') finish(event);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      run = await adapter.startRun({
        sessionId: session.id,
        cwd,
        model,
        permissionMode,
        text: cancel
          ? 'Explain a careful plan for reviewing a small TypeScript program. Do not use tools, read files, or change files.'
          : `Create exactly one file named ${file} in the current directory. Its exact contents must be remote-workbench-ok followed by a newline. Use apply_patch only, do not run shell commands, do not read or change other files, and do not access the network. Then reply with one short confirmation. This is a bounded integration test.`,
      });
      report.run = run;
      if (cancel) await adapter.interruptRun(run);
      const completed = await Promise.race([
        finished,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Write probe timed out after 120 seconds')), 120000);
        }),
      ]);
      report.completion = completed.payload;
      if (!cancel) report.fileVerified = (await readFile(target, 'utf8')) === 'remote-workbench-ok\n';
      report.nativeHistoryAvailable = Boolean(await adapter.readSession(session.id));
      if (
        cancel
          ? completed.payload.state !== 'cancelled'
          : !report.fileVerified || completed.payload.state !== 'completed'
      )
        throw new Error('Real task probe did not complete as expected');
      await adapter.close();
      const restarted = new CodexAdapter({ cwd, executable });
      try {
        await restarted.resumeSession(session, { cwd, model, permissionMode: 'read-only' });
        report.coldResumeVerified = true;
      } finally {
        await restarted.close();
      }
    } catch (error) {
      if (run) await adapter.interruptRun(run).catch(() => {});
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      unsubscribe();
      report.events = events;
    }
  }
} catch (error) {
  report.error = (error as Error).message;
  process.exitCode = 1;
} finally {
  await adapter.close();
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
