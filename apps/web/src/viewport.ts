/** Keep keyboard sizing temporary; CSS owns the normal browser height. */
export function observeWorkbenchViewport() {
  const root = document.documentElement;
  const viewport = window.visualViewport;
  let poll: ReturnType<typeof setInterval> | undefined;
  let frame = 0;
  let settling: ReturnType<typeof setTimeout>[] = [];
  const editing = () => {
    const element = document.activeElement;
    return (
      element instanceof HTMLElement &&
      (element.isContentEditable ||
        element.matches(
          'textarea, input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]):not([type=range])',
        ))
    );
  };
  const update = () => {
    const focused = editing();
    if (focused && !poll) poll = setInterval(update, 250);
    if (!focused && poll) {
      clearInterval(poll);
      poll = undefined;
    }
    // Do not retain a keyboard-sized pixel height after blur or during pinch zoom.
    if (!focused || !viewport || Math.abs(viewport.scale - 1) > 0.01) {
      root.style.removeProperty('--workbench-height');
      return;
    }
    // visualViewport is authoritative: innerHeight may lag keyboard animations.
    if (viewport.height > 0) root.style.setProperty('--workbench-height', `${viewport.height}px`);
  };
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(update);
    settling.forEach(clearTimeout);
    settling = [100, 350, 800].map((delay) => setTimeout(update, delay));
  };
  const events = ['resize', 'orientationchange', 'pageshow', 'focus'] as const;
  events.forEach((event) => window.addEventListener(event, schedule));
  viewport?.addEventListener('resize', schedule);
  viewport?.addEventListener('scroll', schedule);
  document.addEventListener('focusin', schedule);
  document.addEventListener('focusout', schedule);
  document.addEventListener('visibilitychange', schedule);
  update();
  return () => {
    cancelAnimationFrame(frame);
    settling.forEach(clearTimeout);
    clearInterval(poll);
    events.forEach((event) => window.removeEventListener(event, schedule));
    viewport?.removeEventListener('resize', schedule);
    viewport?.removeEventListener('scroll', schedule);
    document.removeEventListener('focusin', schedule);
    document.removeEventListener('focusout', schedule);
    document.removeEventListener('visibilitychange', schedule);
    root.style.removeProperty('--workbench-height');
  };
}
