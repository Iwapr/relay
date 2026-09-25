import { useEffect, useRef, useState } from 'react';

const preference = 'relay:preview-split';
const initialRatio = () => {
  try {
    const value = Number(localStorage.getItem(preference));
    if (value >= 0.1 && value <= 0.9) return value;
  } catch {}
  return 0.9 / 1.9;
};

export function PreviewDivider() {
  const divider = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(initialRatio);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const grid = divider.current?.parentElement;
    grid?.style.setProperty('--chat-share', `${ratio}fr`);
    grid?.style.setProperty('--preview-share', `${1 - ratio}fr`);
    try {
      localStorage.setItem(preference, String(ratio));
    } catch {}
  }, [ratio]);
  useEffect(() => {
    const stop = () => setDragging(false);
    window.addEventListener('blur', stop);
    return () => window.removeEventListener('blur', stop);
  }, []);
  const resize = (value: number) => {
    const element = divider.current;
    const grid = element?.parentElement;
    if (!element || !grid) return;
    const available =
      grid.getBoundingClientRect().width -
      grid.children[0].getBoundingClientRect().width -
      element.offsetWidth;
    if (available <= 0) return;
    const narrow = window.matchMedia('(max-width: 1100px)').matches;
    const min = (narrow ? 310 : 340) / available;
    const max = 1 - (narrow ? 220 : 280) / available;
    if (min <= max) setRatio(Math.max(min, Math.min(max, value)));
  };
  return (
    <>
      <div
        ref={divider}
        className={'preview-divider' + (dragging ? ' dragging' : '')}
        role="separator"
        aria-label="调整对话与预览宽度"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
        tabIndex={0}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (!dragging) return;
          const grid = event.currentTarget.parentElement!;
          const start = grid.children[0].getBoundingClientRect().right;
          const available = grid.getBoundingClientRect().right - start - event.currentTarget.offsetWidth;
          resize((event.clientX - start - event.currentTarget.offsetWidth / 2) / available);
        }}
        onPointerUp={(event) => {
          setDragging(false);
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => setDragging(false)}
        onLostPointerCapture={() => setDragging(false)}
        onDoubleClick={() => resize(0.9 / 1.9)}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          resize(
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? 1
                : ratio + (event.key === 'ArrowLeft' ? -0.03 : 0.03),
          );
        }}
      />
      {dragging && <div className="preview-resize-overlay" />}
    </>
  );
}
