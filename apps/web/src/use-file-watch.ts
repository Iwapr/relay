import { useEffect, useRef, type RefObject } from 'react';
import { api, base, requestId } from './api';

/** CSS-hidden panels and background browser tabs do not retain filesystem watches. */
export function useFileWatch(
  element: RefObject<HTMLElement | null>,
  connection: string,
  workspace: string | undefined,
  kind: 'directory' | 'file',
  path: string,
  refresh: () => void,
) {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!element.current || !connection || !workspace || (kind === 'file' && !path)) return;
    const url = base(connection) + `/workspaces/${workspace}/watch`;
    let visible = false;
    let stopped = false;
    let id: string | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let pending = Promise.resolve();
    const enqueue = (action: () => Promise<void>) => {
      pending = pending.then(action).catch(() => {});
    };
    const release = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      const previous = id;
      id = undefined;
      if (previous)
        enqueue(async () => {
          await api(url, { action: 'release', id: previous }, AbortSignal.timeout(10_000));
        });
    };
    const update = () => {
      if (stopped || !visible || document.visibilityState !== 'visible') return release();
      if (id) return;
      const current = (id = requestId());
      let first = true;
      const renew = () =>
        enqueue(async () => {
          if (id !== current || stopped) return;
          const result = await api<{ created: boolean }>(
            url,
            { action: 'renew', id: current, kind, path },
            AbortSignal.timeout(10_000),
          );
          if ((first || result.created) && id === current && !stopped) {
            first = false;
            refreshRef.current();
          }
        });
      renew();
      timer = setInterval(renew, 20_000);
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      update();
    });
    observer.observe(element.current);
    document.addEventListener('visibilitychange', update);
    window.addEventListener('pagehide', release);
    window.addEventListener('pageshow', update);
    return () => {
      stopped = true;
      observer.disconnect();
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('pagehide', release);
      window.removeEventListener('pageshow', update);
      release();
    };
  }, [element, connection, workspace, kind, path]);
}
