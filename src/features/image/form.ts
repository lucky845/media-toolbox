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
  canvasEnabled: boolean;
  canvasWidth: string;
  canvasHeight: string;
  canvasColor: string;
  canvasTransparent: boolean;
}

export type ImageSection = 'transform' | 'compress' | 'fill' | 'color' | 'all';
export type CompressionPreset = 'custom' | 'compact' | 'balanced' | 'quality';
export type ColorPreset = 'original' | 'grayscale' | 'soft' | 'vivid';

export const compressionPresetQuality = { compact: 68, balanced: 82, quality: 94 } as const;

export function colorPresetAdjust(preset: ColorPreset): Adjust | null {
  switch (preset) {
    case 'grayscale': return { brightness: 1, contrast: 1, saturation: 0 };
    case 'soft': return { brightness: 1.04, contrast: 0.92, saturation: 0.82 };
    case 'vivid': return { brightness: 1, contrast: 1.12, saturation: 1.35 };
    default: return null;
  }
}

export function normalizeImageSection(section?: string): ImageSection {
  switch (section) {
    case 'transform':
    case 'compress':
    case 'fill':
    case 'color':
      return section;
    default:
      return 'all';
  }
}

export function canvasError(form: ImageFormState, maxPixels?: number): string | null {
  if (!form.canvasEnabled) return null;
  const width = Number(form.canvasWidth);
  const height = Number(form.canvasHeight);
  if ([width, height].some((n) => !Number.isInteger(n) || n < 1 || n > 0xffffffff)) {
    return '请输入大于 0 的整数宽度和高度。';
  }
  if (maxPixels !== undefined && maxPixels > 0 && width * height > maxPixels) {
    return `画布超过 ${(maxPixels / 1e6).toFixed(0)} MP 像素上限。`;
  }
  return null;
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
    canvasEnabled: false,
    canvasWidth: '',
    canvasHeight: '',
    canvasColor: '#ffffff',
    canvasTransparent: false,
  };
}

/** 表单 → Rust core 认识的参数结构 */
export function buildParams(
  form: ImageFormState,
  meta: ImageMeta | null,
  section: ImageSection = 'all',
): ImageParams {
  const transform = section === 'all' || section === 'transform';
  const color = section === 'all' || section === 'color';
  const fill = section === 'all' || section === 'fill';
  const orientedSwap = !!meta && meta.exifOrientation >= 5 && meta.exifOrientation <= 8;
  const sourceWidth = meta ? (orientedSwap ? meta.height : meta.width) : 0;
  const sourceHeight = meta ? (orientedSwap ? meta.width : meta.height) : 0;
  let crop: Crop | null = null;
  if (transform && form.cropEnabled && meta) {
    const { x, y, w, h } = form.cropPct;
    crop = {
      x: Math.min(sourceWidth - 1, Math.round((sourceWidth * x) / 100)),
      y: Math.min(sourceHeight - 1, Math.round((sourceHeight * y) / 100)),
      width: Math.max(1, Math.round((sourceWidth * w) / 100)),
      height: Math.max(1, Math.round((sourceHeight * h) / 100)),
    };
  }
  const rotatedSwap = form.rotate === 'cw90' || form.rotate === 'cw270';
  const croppedWidth = crop ? Math.min(crop.width, sourceWidth - crop.x) : sourceWidth;
  const croppedHeight = crop ? Math.min(crop.height, sourceHeight - crop.y) : sourceHeight;
  const resize =
    transform && meta && form.scalePercent !== 100
      ? {
          width: Math.max(1, Math.round(((rotatedSwap ? croppedHeight : croppedWidth) * form.scalePercent) / 100)),
          height: null,
          mode: form.resizeMode,
          filter: form.filter,
          allowUpscale: false,
        }
      : null;

  const hex = form.canvasColor;
  const canvas = fill && form.canvasEnabled && !canvasError(form)
    ? {
        width: Number(form.canvasWidth),
        height: Number(form.canvasHeight),
        background: form.canvasTransparent
          ? { r: 0, g: 0, b: 0, a: 0 }
          : { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), a: 255 },
      }
    : null;

  const hasAdjust =
    form.adjust.brightness !== 1 ||
    form.adjust.contrast !== 1 ||
    form.adjust.saturation !== 1;

  return {
    resize,
    crop,
    rotate: transform ? form.rotate : 'none',
    flip: transform ? form.flip : 'none',
    adjust: color && hasAdjust ? form.adjust : null,
    canvas,
    applyExifOrientation: true,
    background: { ...form.background, a: 255 },
  };
}

// Mirrors the dimension-changing steps of the Rust pipeline for the form's
// single-width resize. The encoder still validates the actual raster.
export function icoSizeError(meta: ImageMeta | null, params: ImageParams, format: EncodeOptions['format']): string | null {
  if (format !== 'ico') return null;
  let width: number;
  let height: number;
  if (params.canvas) {
    ({ width, height } = params.canvas);
  } else {
    if (!meta) return null;
    ({ width, height } = meta);
    if (params.applyExifOrientation && meta.exifOrientation >= 5 && meta.exifOrientation <= 8) {
      [width, height] = [height, width];
    }
    if (params.crop) {
      width = Math.min(params.crop.width, width - params.crop.x);
      height = Math.min(params.crop.height, height - params.crop.y);
    }
    if (params.rotate === 'cw90' || params.rotate === 'cw270') [width, height] = [height, width];
    if (params.resize?.width != null && params.resize.height == null) {
      const target = params.resize.allowUpscale ? params.resize.width : Math.min(width, params.resize.width);
      height = Math.max(1, Math.round(height * (target / width)));
      width = target;
    }
  }
  return width > 256 || height > 256
    ? `预计输出 ${width} × ${height} 像素。ICO 宽和高均须不超过 256 像素，请缩小输出或选择其他格式。`
    : null;
}

/** 参数的人类可读摘要（用于最近任务与输出命名提示） */
export function describeParams(params: ImageParams): string {
  const parts: string[] = [];
  if (params.crop) parts.push('裁剪');
  if (params.rotate !== 'none') parts.push('旋转');
  if (params.flip !== 'none') parts.push('翻转');
  if (params.resize) parts.push('缩放');
  if (params.adjust) parts.push('色彩调整');
  if (params.canvas) parts.push(`画布 ${params.canvas.width} × ${params.canvas.height}`);
  return parts.length > 0 ? parts.join(' → ') : '仅重新编码';
}

/** 透明→JPEG 时是否提醒背景填充：meta.hasAlpha && 目标格式不支持 alpha */
export function needsBackgroundNotice(
  meta: ImageMeta | null,
  encode: EncodeOptions,
  canvas?: ImageParams['canvas'],
): boolean {
  const hasAlpha = canvas ? canvas.background.a < 255 : meta?.hasAlpha;
  return !!hasAlpha && (encode.format === 'jpeg' || encode.format === 'bmp');
}
