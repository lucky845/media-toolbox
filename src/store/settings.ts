// 用户设置（Zustand）。仅内存 + localStorage 持久化，不含文件内容。

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { EncodeOptions, Filter, ImageFormat } from '../lib/backend/types';

interface SettingsState {
  /** 默认输出格式 */
  format: ImageFormat;
  /** 默认质量 1..100 */
  quality: number;
  /** 默认缩放滤波 */
  filter: Filter;
  /** 是否保留元数据（默认 false = 剥离） */
  keepMetadata: boolean;
  /** 是否显示开发者日志 */
  showLogs: boolean;
  /** 输出命名模板：{stem} = 原名，{digest} = 参数摘要，{ext} = 扩展名 */
  nameTemplate: string;

  setFormat: (f: ImageFormat) => void;
  setQuality: (q: number) => void;
  setFilter: (f: Filter) => void;
  setKeepMetadata: (v: boolean) => void;
  setShowLogs: (v: boolean) => void;
  setNameTemplate: (v: string) => void;
  encodeOptions: () => EncodeOptions;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set, get) => ({
      format: 'jpeg',
      quality: 82,
      filter: 'lanczos3',
      keepMetadata: false,
      showLogs: false,
      nameTemplate: '{stem}-{digest}',

      setFormat: (format) => set({ format }),
      setQuality: (quality) => set({ quality: Math.min(100, Math.max(1, quality)) }),
      setFilter: (filter) => set({ filter }),
      setKeepMetadata: (keepMetadata) => set({ keepMetadata }),
      setShowLogs: (showLogs) => set({ showLogs }),
      setNameTemplate: (nameTemplate) => set({ nameTemplate }),

      encodeOptions: () => {
        const s = get();
        return {
          format: s.format,
          quality: s.quality,
          lossless: false,
          keepMetadata: s.keepMetadata,
          pngOptimize: false,
        };
      },
    }),
    {
      name: 'media-toolbox-settings',
      version: 1,
      // 只持久化用户偏好，不持久化任何文件相关信息
      partialize: (s) => ({
        format: s.format,
        quality: s.quality,
        filter: s.filter,
        keepMetadata: s.keepMetadata,
        showLogs: s.showLogs,
        nameTemplate: s.nameTemplate,
      }),
    },
  ),
);
