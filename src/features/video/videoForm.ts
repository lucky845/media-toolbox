// 视频转码表单状态与参数构造（features 层只依赖 Backend 类型，不依赖任何 Web 实现）。

import type { VideoTranscodeParams } from '../../lib/backend/types';

export interface VideoFormState {
  container: 'mp4' | 'webm';
  bitrateMbps: number;
  scalePercent: number;
  fps: number; // 0 = 源帧率
  keepAudio: boolean;
}

export function defaultForm(): VideoFormState {
  return {
    container: 'mp4',
    bitrateMbps: 2,
    scalePercent: 100,
    fps: 0,
    keepAudio: true,
  };
}

export function buildParams(form: VideoFormState): VideoTranscodeParams {
  return {
    container: form.container,
    bitrateMbps: form.bitrateMbps,
    scalePercent: form.scalePercent,
    fps: form.fps,
    keepAudio: form.keepAudio,
  };
}

export function describeParams(form: VideoFormState): string {
  const codec = form.container === 'mp4' ? 'H.264' : 'VP9';
  const fps = form.fps === 0 ? '源帧率' : `${form.fps} fps`;
  const scale = form.scalePercent === 100 ? '原始尺寸' : `${form.scalePercent}%`;
  return `${form.container.toUpperCase()}/${codec} · ${form.bitrateMbps} Mbps · ${scale} · ${fps} · ${form.keepAudio ? '尝试保留音轨' : '无音轨'}`;
}

export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}分${String(s).padStart(2, '0')}秒` : `${s} 秒`;
}
