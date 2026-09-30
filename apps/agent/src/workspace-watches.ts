import { dirname, relative } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import {
  AppError,
  terminalStates,
  type Run,
  type WorkbenchEvent,
} from '../../../packages/contracts/src/index.ts';
import type { FileService } from './files.ts';
import type { StoredWorkspace } from './manager.ts';
import type { Store } from './store.ts';
import { treeWatchBudget, WatchBudget } from './watch-budget.ts';

const viewBudget = new WatchBudget(5_000);
const previewBudget = new WatchBudget(256);
export const VIEW_WATCH_TTL = 60_000;
type Kind = 'directory' | 'file' | 'project';
interface Entry {
  kind: Kind;
  watcher: FSWatcher;
  ready: Promise<void>;
  refs: number;
  stop: () => Promise<void>;
}

/** Views have expiring leases; tasks own independent references until they finish. */
export class WorkspaceWatches {
  private entries = new Map<string, Entry>();
  private views = new Map<string, { key: string; expires: number; release: () => void }>();
  private runs = new Map<string, () => void>();
  private pending = new Set<Promise<void>>();
  private settling = new Set<ReturnType<typeof setTimeout>>();
  private closed = false;
  private sweepTimer: ReturnType<typeof setInterval>;
  constructor(
    private store: Store,
    private files: FileService,
    private record: (workspace: StoredWorkspace, paths: string[], preview: boolean) => void,
  ) {
    this.sweepTimer = setInterval(() => this.expire(), 10_000);
    this.sweepTimer.unref();
    store.events.on('event', this.onEvent);
  }

  private onEvent = (event: WorkbenchEvent) => {
    if (event.type !== 'run.state_changed') return;
    const run = event.payload.run as Run;
    if (!terminalStates.includes(run.state)) return;
    const release = this.runs.get(run.id);
    if (!release) return;
    this.runs.delete(run.id);
    // Let the final filesystem notification and awaitWriteFinish settle.
    const timer = setTimeout(() => {
      this.settling.delete(timer);
      release();
    }, 1_200);
    this.settling.add(timer);
  };

  async observeRun(workspace: StoredWorkspace, run: Run) {
    if (this.closed || this.runs.has(run.id)) return;
    const held = this.retain(workspace, 'project', '', workspace.canonicalRoot);
    this.runs.set(run.id, held.release);
    // A short task must not finish before its initial watch scan is ready.
    await held.ready;
  }

  async view(
    workspace: StoredWorkspace,
    id: string,
    kind: 'directory' | 'file',
    path: string,
    target: string,
  ) {
    if (this.closed) throw new AppError('agent_unavailable', 'Agent 正在停止', 503);
    this.expire();
    const lease = `${workspace.id}:${id}`;
    const key = JSON.stringify([workspace.id, kind, target]);
    const previous = this.views.get(lease);
    if (previous?.key === key) {
      previous.expires = Date.now() + VIEW_WATCH_TTL;
      return false;
    }
    if (!previous && this.views.size >= 64)
      throw new AppError('watch_limit', '同时查看的文件窗口过多，请关闭部分窗口', 409);
    previous?.release();
    const held = this.retain(workspace, kind, path, target);
    this.views.set(lease, { key, expires: Date.now() + VIEW_WATCH_TTL, release: held.release });
    await held.ready;
    return true;
  }

  releaseView(workspaceId: string, id: string) {
    const key = `${workspaceId}:${id}`;
    this.views.get(key)?.release();
    this.views.delete(key);
  }

  expire(now = Date.now()) {
    for (const [key, view] of this.views)
      if (view.expires <= now) {
        this.views.delete(key);
        view.release();
      }
  }

  status() {
    return {
      viewLeases: this.views.size,
      activeRuns: this.runs.size,
      projects: [...this.entries.values()].filter((entry) => entry.kind === 'project').length,
      directories: [...this.entries.values()].filter((entry) => entry.kind === 'directory').length,
      files: [...this.entries.values()].filter((entry) => entry.kind === 'file').length,
    };
  }

  private retain(workspace: StoredWorkspace, kind: Kind, path: string, target: string) {
    const key = JSON.stringify([workspace.id, kind, target]);
    let entry = this.entries.get(key);
    if (!entry) {
      const warning = (message: string) => {
        if (!this.closed) this.store.emit('provider.warning', { message }, { workspaceId: workspace.id });
      };
      const budget = (
        kind === 'project' ? treeWatchBudget : kind === 'file' ? previewBudget : viewBudget
      ).scope(kind === 'project' ? 5_000 : kind === 'directory' ? 1_000 : 2, () =>
        warning('文件过多，已限制自动监听范围；未自动更新的文件请手动刷新。'),
      );
      const watcher = watch(target, {
        ignoreInitial: true,
        depth: kind === 'project' ? 5 : 0,
        followSymlinks: false,
        ignored: (candidate) => {
          const p = relative(workspace.canonicalRoot, candidate);
          return (
            (kind === 'file' && candidate !== target && candidate !== dirname(target)) ||
            (kind !== 'file' && p !== '' && !this.files.isVisible(workspace.directoryInfo, p)) ||
            (kind === 'project' &&
              /(^|\/)(node_modules|\.cache|\.runtime|\.venv|venv|__pycache__)(\/|$)/.test(candidate)) ||
            !budget.accept(candidate)
          );
        },
        awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      });
      let stopped = false;
      const changed = new Set<string>();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const flush = () => {
        if (timer) clearTimeout(timer);
        timer = undefined;
        if (changed.size) this.record(workspace, [...changed], kind === 'file');
        changed.clear();
      };
      let ready!: () => void;
      const readyPromise = new Promise<void>((resolve) => {
        ready = resolve;
      });
      // Monitoring must never indefinitely block task execution on a slow filesystem.
      const readyTimeout = setTimeout(() => {
        warning('文件监听初始化较慢，任务将继续执行；文件列表可手动刷新。');
        ready();
      }, 3_000);
      const finishReady = () => {
        clearTimeout(readyTimeout);
        ready();
      };
      watcher.once('ready', finishReady);
      let warned = false;
      watcher.on('error', () => {
        finishReady();
        if (!warned) warning('文件监听失败，请手动刷新文件列表');
        warned = true;
      });
      watcher.on('unlink', budget.forget);
      watcher.on('unlinkDir', budget.forget);
      watcher.on('all', (_event, candidate) => {
        if (stopped || (kind === 'file' && candidate !== target)) return;
        const p = kind === 'file' ? path : relative(workspace.canonicalRoot, candidate);
        if (kind !== 'file' && p !== '' && !this.files.isVisible(workspace.directoryInfo, p)) return;
        if (changed.size < 500) changed.add(p);
        // A continuous stream of writes must not postpone updates forever.
        timer ??= setTimeout(flush, 400);
      });
      entry = {
        kind,
        watcher,
        refs: 0,
        ready: readyPromise,
        stop: async () => {
          stopped = true;
          finishReady();
          flush();
          try {
            await watcher.close();
          } finally {
            budget.close();
          }
        },
      };
      this.entries.set(key, entry);
    }
    entry.refs++;
    const held = entry;
    let released = false;
    return {
      ready: held.ready,
      release: () => {
        if (released) return;
        released = true;
        if (--held.refs > 0 || this.entries.get(key) !== held) return;
        this.entries.delete(key);
        const pending = held
          .stop()
          .catch(() => {})
          .finally(() => this.pending.delete(pending));
        this.pending.add(pending);
      },
    };
  }

  async close() {
    this.closed = true;
    this.store.events.off('event', this.onEvent);
    clearInterval(this.sweepTimer);
    for (const timer of this.settling) clearTimeout(timer);
    this.settling.clear();
    const closing = [...this.entries.values()].map((entry) => entry.stop());
    this.entries.clear();
    this.views.clear();
    this.runs.clear();
    await Promise.allSettled([...closing, ...this.pending]);
  }
}
