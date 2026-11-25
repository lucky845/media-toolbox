import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/global.css';
import './styles/components.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root 不存在');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Service Worker：只在 PROD 注册。
// 开发期 Vite HMR 与 SW 缓存会打架（改了代码刷新还是旧内容）—— 这是真实踩过的坑。
// 注册成功后 capabilities().offline.installed 才会变 true，UI 文案同步更新。
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    const url = `${import.meta.env.BASE_URL}sw.js`;
    navigator.serviceWorker.register(url).catch(() => {
      // 注册失败不阻塞应用：离线只是增强功能
    });
  });
}
