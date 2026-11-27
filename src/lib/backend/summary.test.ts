import { describe, expect, it } from 'vitest';
import { summarizeCapabilities } from './summary';
import type { Capabilities } from './types';

const desktop: Capabilities = {
  kind: 'desktop',
  contractVersion: 1,
  image: { formats: [], avif: false, maxPixels: 100, parallel: 1, pngOptimize: false },
  video: { available: true, engines: ['ffmpeg-sidecar'], decoders: [], encoders: [], hardwareEncoder: false, maxBytes: 100, maxDurationSec: 1 },
  pdf: { render: true, edit: true, maxPages: -1 },
  office: { wordToPdf: 'native', pdfToWord: 'native' },
  cancel: { hard: true },
  fileSystem: { directoryPicker: true, savePicker: true },
  offline: { installed: true, serviceWorker: false },
  env: { userAgentMajor: 'test', crossOriginIsolated: false },
};

describe('summarizeCapabilities', () => {
  it.each([
    { ...desktop, office: { wordToPdf: 'structured', pdfToWord: 'structured' } as const },
    { ...desktop, video: { ...desktop.video, available: false, engines: [] } },
  ])('keeps the desktop identity when optional functionality is unavailable', (caps) => {
    expect(summarizeCapabilities(caps)).toMatchObject({
      label: '桌面版',
      formDescription: '桌面版',
      offlineDescription: '完全离线',
      showBrowserGuidance: false,
    });
  });

  it('keeps desktop offline status even when the optional local processing capability is unavailable', () => {
    expect(summarizeCapabilities({ ...desktop, offline: { installed: false, serviceWorker: false } })).toMatchObject({
      label: '桌面版',
      offlineDescription: '完全离线',
    });
  });

  it('shows the same desktop badge when both native components are available', () => {
    expect(summarizeCapabilities(desktop)).toMatchObject({
      label: '桌面版',
      showBrowserGuidance: false,
    });
  });

  it.each([
    [true, '已缓存，可离线使用'],
    [false, '首次在线加载后可用（Service Worker 正在安装）'],
  ])('keeps the Web identity with installed=%s', (installed, offlineDescription) => {
    expect(summarizeCapabilities({ ...desktop, kind: 'web', offline: { installed, serviceWorker: true } })).toMatchObject({
      label: '在线版 · 轻量模式',
      offlineDescription,
      showBrowserGuidance: true,
    });
  });
});
