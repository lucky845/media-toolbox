// 用户设置（Zustand）。仅内存 + localStorage 持久化，不含文件内容。

import { create } from 'zustand';
import type { EncodeOptions, Filter, ImageFormat } from '../lib/backend/types';

const SETTINGS_KEY = 'media-toolbox-settings';
const SETTINGS_VERSION = 1;

interface Preferences {
  format: ImageFormat;
  quality: number;
  filter: Filter;
  keepMetadata: boolean;
  showLogs: boolean;
  recordHistory: boolean;
  /** 输出命名模板：{stem} = 原名，{digest} = 参数摘要，{ext} = 扩展名 */
  nameTemplate: string;
}

interface SettingsState extends Preferences {
  setFormat: (f: ImageFormat) => void;
  setQuality: (q: number) => void;
  setFilter: (f: Filter) => void;
  setKeepMetadata: (v: boolean) => void;
  setShowLogs: (v: boolean) => void;
  setRecordHistory: (v: boolean) => void;
  setNameTemplate: (v: string) => void;
  encodeOptions: () => EncodeOptions;
}

const defaults: Preferences = {
  format: 'jpeg', quality: 82, filter: 'lanczos3', keepMetadata: false,
  showLogs: false, recordHistory: true, nameTemplate: '{stem}-{digest}',
};
const formats: readonly ImageFormat[] = ['jpeg', 'png', 'webp', 'avif', 'gif', 'bmp', 'tiff', 'qoi', 'ico'];
const filters: readonly Filter[] = ['nearest', 'triangle', 'catmull_rom', 'gaussian', 'lanczos3'];
const clampQuality = (quality: number) => Math.min(100, Math.max(1, quality));

function readPreferences(): Preferences | undefined {
  let serialized: string | null;
  try {
    serialized = localStorage.getItem(SETTINGS_KEY);
  } catch {
    return undefined;
  }
  if (serialized === null) return defaults;
  const privateDefaults = { ...defaults, recordHistory: false };
  try {
    const saved = JSON.parse(serialized) as { version?: unknown; state?: Partial<Preferences> } | null;
    const prefs = saved?.state;
    if (saved?.version !== SETTINGS_VERSION || !prefs || typeof prefs !== 'object' || Array.isArray(prefs)) return privateDefaults;
    return {
      format: prefs.format && formats.includes(prefs.format) ? prefs.format : defaults.format,
      quality: typeof prefs.quality === 'number' && Number.isFinite(prefs.quality) ? clampQuality(prefs.quality) : defaults.quality,
      filter: prefs.filter && filters.includes(prefs.filter) ? prefs.filter : defaults.filter,
      keepMetadata: prefs.keepMetadata === true,
      showLogs: prefs.showLogs === true,
      // Version 1 settings saved before this preference was introduced default to enabled.
      recordHistory: prefs.recordHistory === undefined || prefs.recordHistory === true,
      nameTemplate: typeof prefs.nameTemplate === 'string' ? prefs.nameTemplate : defaults.nameTemplate,
    };
  } catch {
    return privateDefaults;
  }
}

export const useSettings = create<SettingsState>((set, get) => {
  function update(changes: Partial<Preferences>) {
    // Do not overwrite another tab's newer preferences with this tab's stale snapshot.
    const state = { ...(readPreferences() ?? get()), ...changes };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ state, version: SETTINGS_VERSION }));
    } catch {
      // The local preference still applies when storage is unavailable.
    }
    set(state);
  }

  return {
    ...(readPreferences() ?? { ...defaults, recordHistory: false }),
    setFormat: (format) => update({ format }),
    setQuality: (quality) => { if (Number.isFinite(quality)) update({ quality: clampQuality(quality) }); },
    setFilter: (filter) => update({ filter }),
    setKeepMetadata: (keepMetadata) => update({ keepMetadata }),
    setShowLogs: (showLogs) => update({ showLogs }),
    setRecordHistory: (recordHistory) => update({ recordHistory }),
    setNameTemplate: (nameTemplate) => update({ nameTemplate }),
    encodeOptions: () => {
      const { format, quality, keepMetadata } = get();
      return { format, quality, lossless: false, keepMetadata, pngOptimize: false };
    },
  };
});

/** Check persisted privacy as well as local consent before writing identifying metadata. */
export function canRecordHistory(): boolean {
  return useSettings.getState().recordHistory && readPreferences()?.recordHistory === true;
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.storageArea !== window.localStorage || (event.key !== SETTINGS_KEY && event.key !== null)) return;
    // An already queued event may contain a superseded value. Re-read rather than applying newValue.
    const prefs = readPreferences();
    if (prefs) useSettings.setState(prefs);
  });
}
