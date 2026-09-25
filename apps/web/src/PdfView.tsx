import { useEffect, useRef, useState } from 'react';
import { ZoomIn, ZoomOut, Maximize, Minimize, ChevronUp, ChevronDown } from 'lucide-react';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import { EventBus, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import './pdf-view.css';
import { save, saved } from './api';
GlobalWorkerOptions.workerSrc = workerUrl;
export default function PdfView({
  url,
  stateKey,
  onPage,
}: {
  url: string;
  stateKey: string;
  onPage: (page: number) => void;
}) {
  const [pdf, setPdf] = useState<{ numPages: number } | null>(null);
  const [error, setError] = useState('');
  const [page, setPage] = useState(() => saved(stateKey + ':page', 1));
  const [scale, setScale] = useState(() => saved(stateKey + ':zoom', 1));
  const [fullscreen, setFullscreen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const viewer = useRef<PDFViewer | null>(null);
  const onPageRef = useRef(onPage);
  onPageRef.current = onPage;
  const zoom = useRef(scale);
  zoom.current = scale;
  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement === container.current);
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement === container.current) await document.exitFullscreen();
      else await container.current?.requestFullscreen();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function fit() {
    const v = viewer.current;
    if (!v?.pagesCount || !scroll.current?.clientWidth || !scroll.current?.clientHeight) return;
    const current = v.currentPageNumber;
    v.currentScaleValue = 'page-width';
    v.currentScale *= zoom.current;
    v.currentPageNumber = current;
  }
  function goTo(value: number) {
    if (viewer.current?.pagesCount) viewer.current.currentPageNumber = value;
  }
  useEffect(() => {
    const initialPage = saved(stateKey + ':page', 1);
    const eventBus = new EventBus();
    const v = new PDFViewer({
      container: scroll.current!,
      viewer: pages.current!,
      eventBus,
      annotationMode: 0,
      textLayerMode: 1,
    });
    viewer.current = v;
    v.scrollMode = 0;
    let disposed = false;
    let ready = false;
    eventBus.on('pagesinit', () => {
      if (disposed) return;
      fit();
      v.currentPageNumber = Math.min(v.pagesCount, Math.max(1, initialPage));
      ready = true;
    });
    eventBus.on('pagechanging', ({ pageNumber }: { pageNumber: number }) => {
      if (disposed) return;
      setPage(pageNumber);
      onPageRef.current(pageNumber);
      if (ready) save(stateKey + ':page', pageNumber);
    });
    eventBus.on('pagerendered', ({ error }: { error?: Error }) => {
      if (!disposed && error) setError(error.message);
    });
    const observer = new ResizeObserver(() => {
      if (ready) fit();
    });
    observer.observe(scroll.current!);
    const task = getDocument({
      url,
      wasmUrl: `${import.meta.env.BASE_URL}pdfjs/wasm/`,
      cMapUrl: `${import.meta.env.BASE_URL}pdfjs/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${import.meta.env.BASE_URL}pdfjs/standard_fonts/`,
      withCredentials: true,
      disableAutoFetch: true,
      disableStream: true,
    });
    void task.promise
      .then((doc) => {
        if (disposed) return;
        setPdf({ numPages: doc.numPages });
        v.setDocument(doc);
      })
      .catch((e) => {
        if (!disposed) setError(e.message);
      });
    return () => {
      disposed = true;
      observer.disconnect();
      v.setDocument(null as never);
      viewer.current = null;
      void task.destroy();
    };
  }, [url, stateKey]);
  useEffect(() => {
    save(stateKey + ':zoom', scale);
    fit();
  }, [scale, stateKey]);
  return (
    <div className="pdf-view" ref={container}>
      <div className="pdf-toolbar">
        <button aria-label="上一页" disabled={page <= 1} onClick={() => goTo(page - 1)}>
          <ChevronUp size={16} />
        </button>
        <input
          aria-label="页码"
          type="number"
          min="1"
          max={pdf?.numPages ?? 1}
          value={page}
          onChange={(e) => goTo(Math.max(1, Math.min(pdf?.numPages ?? 1, Number(e.target.value) || 1)))}
        />
        <span>/ {pdf?.numPages ?? '—'}</span>
        <button aria-label="下一页" disabled={!pdf || page >= pdf.numPages} onClick={() => goTo(page + 1)}>
          <ChevronDown size={16} />
        </button>
        <span className="toolbar-separator" />
        <button aria-label="缩小" onClick={() => setScale((s) => Math.max(0.5, s - 0.2))}>
          <ZoomOut size={16} />
        </button>
        <button onClick={() => setScale(1)}>适应屏宽</button>
        <button aria-label="放大" onClick={() => setScale((s) => Math.min(3, s + 0.2))}>
          <ZoomIn size={16} />
        </button>
        <button aria-label={fullscreen ? '退出全屏' : '全屏'} onClick={() => void toggleFullscreen()}>
          {fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="pdf-scroll-area">
        <div className="pdf-scroll" ref={scroll} aria-label="PDF 连续滚动阅读区">
          <div className="pdfViewer" ref={pages} />
        </div>
      </div>
    </div>
  );
}
