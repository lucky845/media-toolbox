// 图片参数的构建与校验。UI 只负责收集用户输入，参数语义集中在这里。
// 两端共用同一份 ImageParams（Backend 接口里的类型），桌面端也走这里。

import type {
  Adjust,
  Crop,
  EncodeOptions,
  Filter,
  Flip,
  ImageMeta,
  ImageParams,
  ResizeMode,
  Rotation,
} from '../../lib/backend/types';

export interface ImageFormState {
  scalePercent: number; // 100 = 不缩放
  filter: Filter;
  resizeMode: ResizeMode;
  rotate: Rotation;
  flip: Flip;
  cropEnabled: boolean;
  cropPct: { x: number; y: number; w: number; h: number }; // 百分比 0..100
  adjust: Adjust;
  background: { r: number; g: number; b: number };
}

export function defaultForm(filter: Filter): ImageFormState {
  return {
    scalePercent: 100,
    filter,
    resizeMode: 'fit',
    rotate: 'none',
    flip: 'none',
    cropEnabled: false,
    cropPct: { x: 0, y: 0, w: 100, h: 100 },
    adjust: { brightness: 1, contrast: 1, saturation: 1 },
    background: { r: 255, g: 255, b: 255 },
  };
}

/** 表单 → Rust core 认识的参数结构 */
export function buildParams(form: ImageFormState, meta: ImageMeta | null): ImageParams {
  const resize =
    meta && form.scalePercent !== 100
      ? {
          width: Math.max(1, Math.round((meta.width * form.scalePercent) / 100)),
          height: null,
          mode: form.resizeMode,
          filter: form.filter,
          allowUpscale: false,
        }
      : null;

  let crop: Crop | null = null;
  if (form.cropEnabled && meta) {
    const { x, y, w, h } = form.cropPct;
    crop = {
      x: Math.round((meta.width * x) / 100),
      y: Math.round((meta.height * y) / 100),
      width: Math.max(1, Math.round((meta.width * w) / 100)),
      height: Math.max(1, Math.round((meta.height * h) / 100)),
    };
  }

  const hasAdjust =
    form.adjust.brightness !== 1 ||
    form.adjust.contrast !== 1 ||
    form.adjust.saturation !== 1;

  return {
    resize,
    crop,
    rotate: form.rotate,
    flip: form.flip,
    adjust: hasAdjust ? form.adjust : null,
    applyExifOrientation: true,
    background: { ...form.background, a: 255 },
  };
}

/** 参数的人类可读摘要（用于最近任务与输出命名提示） */
export function describeParams(form: ImageFormState): string {
  const parts: string[] = [];
  if (form.scalePercent !== 100) parts.push(`${form.scalePercent}% (${form.filter})`);
  if (form.cropEnabled) parts.push('裁剪');
  if (form.rotate !== 'none') parts.push(`旋转 ${form.rotate}`);
  if (form.flip !== 'none') parts.push(`翻转 ${form.flip}`);
  if (form.adjust.brightness !== 1) parts.push(`亮度 ${form.adjust.brightness.toFixed(2)}`);
  if (form.adjust.contrast !== 1) parts.push(`对比度 ${form.adjust.contrast.toFixed(2)}`);
  if (form.adjust.saturation !== 1) parts.push(`饱和度 ${form.adjust.saturation.toFixed(2)}`);
  return parts.length > 0 ? parts.join(' · ') : '仅重编码';
}

/** 透明→JPEG 时是否提醒背景填充：meta.hasAlpha && 目标格式不支持 alpha */
export function needsBackgroundNotice(
  meta: ImageMeta | null,
  encode: EncodeOptions,
): boolean {
  if (!meta || !meta.hasAlpha) return false;
  return encode.format === 'jpeg' || encode.format === 'bmp';
}
