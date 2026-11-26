// 能力与阈值：启动时探测一次，全局共享。
//
// UI **只**读这里，不读「是否打包成桌面」。这是 D3 的落点。

import { create } from 'zustand';
import { getBackend } from '../lib/backend';
import { summarizeCapabilities, type CapabilitySummary } from '../lib/backend/summary';
import type { Capabilities, Limits, ToolError } from '../lib/backend/types';

interface CapsState {
  status: 'idle' | 'loading' | 'ready' | 'failed';
  caps: Capabilities | null;
  limits: Limits | null;
  /** 形态的展示描述（由 capabilities 派生，组件不再自行判断） */
  summary: CapabilitySummary | null;
  error: ToolError | null;
  /** 探测失败时进入受限模式：只有 PDF 结构编辑与下载可用 */
  restrictedMode: boolean;
  load: () => Promise<void>;
}

let loading: Promise<void> | undefined;
let refreshQueued = false;

export const useCapabilities = create<CapsState>((set, get) => ({
  status: 'idle',
  caps: null,
  limits: null,
  summary: null,
  error: null,
  restrictedMode: false,

  load: () => {
    if (loading) {
      refreshQueued = true;
      return loading;
    }
    loading = Promise.resolve().then(async () => {
      do {
        refreshQueued = false;
        if (get().status !== 'ready') set({ status: 'loading', error: null });
        try {
          const backend = await getBackend();
          const [caps, limits] = await Promise.all([backend.capabilities(), backend.limits()]);
          set({ status: 'ready', caps, limits, summary: summarizeCapabilities(caps), restrictedMode: false });
        } catch (e) {
          // 刷新失败时保留上一次已知能力；只有首次探测失败才进入受限模式。
          if (get().status !== 'ready') {
            set({ status: 'failed', error: e as ToolError, restrictedMode: true, caps: null, limits: null, summary: null });
          }
        }
      } while (refreshQueued);
    }).finally(() => { loading = undefined; });
    return loading;
  },
}));
