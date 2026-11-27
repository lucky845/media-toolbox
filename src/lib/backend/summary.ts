import type { Capabilities } from './types';

export interface CapabilitySummary {
  /** 顶栏徽标文字 */
  label: string;
  /** 徽标语气 */
  tone: 'ok' | 'warn' | 'err' | '';
  /** 「能力与限制」页的形态描述 */
  formDescription: string;
  /** 离线能力描述 */
  offlineDescription: string;
  /** 是否展示浏览器说明及桌面版下载引导 */
  showBrowserGuidance: boolean;
}

export function summarizeCapabilities(caps: Capabilities): CapabilitySummary {
  const desktop = caps.kind === 'desktop';

  return {
    label: desktop ? '桌面版' : '在线版 · 轻量模式',
    tone: desktop ? 'ok' : '',
    formDescription: desktop ? '桌面版' : '在线版（轻量模式）',
    // 在线版的离线能力**取决于 Service Worker 是否真的已激活**。
    // 不能只看「浏览器支持 SW」就宣称可离线 —— 那是「说过要做」而不是「已经做了」。
    offlineDescription: desktop
      ? '完全离线'
      : caps.offline.installed
        ? '已缓存，可离线使用'
        : caps.offline.serviceWorker
          ? '首次在线加载后可用（Service Worker 正在安装）'
          : '需要网络',
    showBrowserGuidance: !desktop,
  };
}
