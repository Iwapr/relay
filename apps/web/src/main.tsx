import { createRoot } from 'react-dom/client';
import App from './App';
import { RenderBoundary } from './RenderBoundary';
import './styles.css';
import './workspace-layout.css';
import './chat-layout.css';
createRoot(document.getElementById('root')!).render(
  <RenderBoundary>
    <App />
  </RenderBoundary>,
);
