import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/global.css';
import './styles/components.css';
import { installPdfJsMapCompat } from './lib/pdfMapCompat';

installPdfJsMapCompat();
const root = document.getElementById('root');
if (!root) throw new Error('#root 不存在');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Service Worker：在线版 PROD 注册。Tauri 不注册，也清掉历史缓存，避免桌面包复用旧 WebView 资源。
// 开发期 Vite HMR 与 SW 缓存会打架（改了代码刷新还是旧内容）—— 这是真实踩过的坑。
// 注册成功后 capabilities().offline.installed 才会变 true，UI 文案同步更新。
const isTauriRuntime = Object.prototype.hasOwnProperty.call(globalThis, '__TAURI_INTERNALS__') ||
  Object.prototype.hasOwnProperty.call(globalThis, '__TAURI__');

if (isTauriRuntime && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.getRegistrations()
    .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
    .then(async () => {
      if (!('caches' in globalThis)) return;
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    })
    .catch(() => undefined);
} else if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    const url = `${import.meta.env.BASE_URL}sw.js`;
    navigator.serviceWorker.register(url).catch(() => {
      // 注册失败不阻塞应用：离线只是增强功能
    });
  });
}
