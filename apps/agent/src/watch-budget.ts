/** Shared by all account Agents in this process, including overlapping projects. */
export class WatchBudget {
  private used = 0;
  constructor(private readonly limit: number) {}

  scope(limit: number, onLimit: () => void) {
    const paths = new Set<string>();
    let closed = false;
    let warned = false;
    return {
      accept: (path: string) => {
        if (closed) return false;
        if (paths.has(path)) return true;
        if (paths.size >= limit || this.used >= this.limit) {
          if (!warned) {
            warned = true;
            onLimit();
          }
          return false;
        }
        paths.add(path);
        this.used++;
        return true;
      },
      forget: (path: string) => {
        for (const entry of paths)
          if (entry === path || entry.startsWith(path + '/')) {
            paths.delete(entry);
            this.used--;
          }
      },
      close: () => {
        closed = true;
        this.used -= paths.size;
        paths.clear();
      },
    };
  }
}

export const treeWatchBudget = new WatchBudget(20_000);
