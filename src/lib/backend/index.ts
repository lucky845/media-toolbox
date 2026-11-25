// Backend 工厂：**运行时探测**选实现（规格 §12）。
//
// 这里唯一的判断是「有没有 Tauri 注入的全局对象」——它是「哪个运行时」的探测，
// 而不是「哪个功能可用」的分支。功能可用性一律走 capabilities()。
//
// 为什么用 `window.__TAURI_INTERNALS__` 而不是 `import.meta.env`：
// 同样的 dist 会被两种壳加载，构建期环境变量在这里不可靠。

import type { Backend } from './types';
import { WebBackend } from './web/webBackend';

let instance: Backend | null = null;

function isTauriRuntime(): boolean {
  // Tauri 2 注入 __TAURI_INTERNALS__；旧版是 __TAURI__。
  // 用 hasOwnProperty 而不是 `in`，避免被页面上的同名属性骗到。
  const w = globalThis as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(w, '__TAURI_INTERNALS__') ||
    Object.prototype.hasOwnProperty.call(w, '__TAURI__');
}

export async function getBackend(): Promise<Backend> {
  if (instance) return instance;

  if (isTauriRuntime()) {
    // 动态 import：Web 构建里不会把桌面实现打进首屏包
    const { DesktopBackend } = await import('./desktop/desktopBackend');
    instance = new DesktopBackend();
  } else {
    instance = new WebBackend();
  }
  return instance;
}

/** 同步拿到当前形态（仅用于日志/文案，不得用于功能分支） */
export function backendKind(): 'web' | 'desktop' {
  return isTauriRuntime() ? 'desktop' : 'web';
}

/** 测试用：替换实例 */
export function __setBackendForTest(b: Backend | null): void {
  instance = b;
}
