import { Component, type ErrorInfo, type ReactNode } from 'react';

export class RenderBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[Relay] 页面渲染失败', error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;
    return (
      <main role="alert" style={{ padding: 24 }}>
        <h1>页面显示遇到问题</h1>
        <p>请重新加载页面以恢复显示。</p>
        <button type="button" onClick={() => window.location.reload()}>
          重新加载页面
        </button>
      </main>
    );
  }
}
