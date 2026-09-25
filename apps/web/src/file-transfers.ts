import { useEffect, useRef, useState } from 'react';
import { api, base } from './api';

const chunkSize = 192 * 1024;
function encode(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export function useFileTransfers(connection: string, workspace: string | undefined, onUploaded: () => void) {
  const [status, setStatus] = useState('');
  const [failures, setFailures] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState<{ url: string; name: string } | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const endpoint = base(connection) + `/workspaces/${workspace}`;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
    };
  }, []);
  const upload = async (files: File[], directory: string) => {
    if (!workspace || active.current || !files.length) return;
    if (files.length > 10000) {
      setFailures(['每批最多上传 10000 个文件']);
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setFailures([]);
    setProgress(0);
    const total = files.reduce((sum, f) => sum + f.size, 0);
    let sent = 0,
      completed = 0,
      failed = 0;
    try {
      for (const file of files) {
        if (controller.signal.aborted) break;
        const relative = file.webkitRelativePath || file.name;
        const path = [directory, relative].filter(Boolean).join('/');
        let id: string | undefined;
        try {
          if (file.size > 100 * 1024 * 1024) throw new Error('单文件不能超过 100 MiB');
          setStatus(`正在上传 ${completed + failed + 1}/${files.length}：${relative}`);
          const start = await api<{ id: string }>(
            endpoint + '/uploads',
            { action: 'start', path, size: file.size },
            controller.signal,
          );
          id = start.id;
          for (let offset = 0; offset < file.size; offset += chunkSize) {
            const bytes = await file.slice(offset, offset + chunkSize).arrayBuffer();
            await api(
              endpoint + '/uploads',
              { action: 'chunk', id, offset, data: encode(bytes) },
              controller.signal,
            );
            sent += bytes.byteLength;
            if (mounted.current) setProgress(total ? Math.min(99, Math.round((sent / total) * 100)) : 0);
          }
          await api(endpoint + '/uploads', { action: 'finish', id }, controller.signal);
          id = undefined;
          completed++;
        } catch (error) {
          if (!controller.signal.aborted) {
            failed++;
            if (mounted.current)
              setFailures((old) => [...old.slice(-19), `${relative}：${(error as Error).message}`]);
          }
        } finally {
          if (id) await api(endpoint + '/uploads', { action: 'cancel', id }).catch(() => {});
        }
      }
    } finally {
      active.current = null;
      if (mounted.current) {
        setBusy(false);
        setProgress(null);
        setStatus(
          `${controller.signal.aborted ? '已取消后续上传，' : ''}已上传 ${completed} 个文件${failed ? `，${failed} 个失败` : ''}`,
        );
        onUploaded();
      }
    }
  };
  const download = async (paths: string[], archive: boolean) => {
    if (!workspace || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setFailures([]);
    setProgress(null);
    setStatus(archive ? '正在打包下载…' : '正在准备下载…');
    setReady(null);
    try {
      const result = await api<{ id: string; name: string; skipped: number }>(
        endpoint + '/downloads',
        { paths, archive },
        controller.signal,
      );
      if (!mounted.current) return;
      const anchor = document.createElement('a');
      anchor.href = '/api' + endpoint + '/downloads/' + result.id;
      anchor.download = result.name;
      setReady({ url: anchor.href, name: result.name });
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setStatus(
        `已交给浏览器下载：${result.name}${result.skipped ? `；已跳过 ${result.skipped} 项受保护、不可读取的文件或链接` : ''}`,
      );
    } catch (error) {
      if (mounted.current) {
        setStatus(controller.signal.aborted ? '已取消等待下载' : '下载准备失败');
        if (!controller.signal.aborted) setFailures([(error as Error).message]);
      }
    } finally {
      active.current = null;
      if (mounted.current) setBusy(false);
    }
  };
  return { upload, download, busy, ready, status, failures, progress, cancel: () => active.current?.abort() };
}
