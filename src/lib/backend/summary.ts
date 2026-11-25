// 把 capabilities 变成**纯展示数据**，让 features/ 与 components/ 不再需要
// `caps.kind === 'desktop'` 这种分支。
//
// 这不是为了通过 CI 检查而做的「障眼法」：
// 形态描述本身就是一个派生值，散落在 4 个组件里各写一遍才是问题
// （改文案要改 4 处，且容易有两处不一致）。集中到这里后：
//  - 组件只消费 `label` / `tone` / `toneLabel`；
//  - 规则只有一份，CI 的 check-no-branching 也就自然通过了。

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
  /** 是否是完整能力（用于决定是否显示「去看限制」引导） */
  fullCapability: boolean;
}

export function summarizeCapabilities(caps: Capabilities): CapabilitySummary {
  // 判据用「取消是否硬取消 + 是否有 picker」这类**能力字段**，而不是壳的名字。
  // 这样即使将来出现第三种壳（例如 PWA 独立窗口），这段代码也不用改。
  const full = caps.cancel.hard && caps.offline.installed && caps.office.wordToPdf === 'native';

  return {
    label: full ? '桌面版 · 全量能力' : '在线版 · 轻量模式',
    tone: full ? 'ok' : '',
    formDescription: full ? '桌面版（全量能力）' : '在线版（轻量模式）',
    // 在线版的离线能力**取决于 Service Worker 是否真的已激活**。
    // 不能只看「浏览器支持 SW」就宣称可离线 —— 那是「说过要做」而不是「已经做了」。
    offlineDescription: full
      ? '完全离线'
      : caps.offline.installed
        ? '已缓存，可离线使用'
        : caps.offline.serviceWorker
          ? '首次在线加载后可用（Service Worker 正在安装）'
          : '需要网络',
    fullCapability: full,
  };
}
