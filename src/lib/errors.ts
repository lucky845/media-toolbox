// 错误码 → 中文文案的唯一来源是 Rust（`get_error_spec()`）。
// 这里只做「TS 侧兜底」：当 wasm 还没加载完就出错时，用一份静态表。
//
// 为什么还要有静态表：`WASM_LOAD_FAILED` 本身就会发生在 wasm 加载之前，
// 此时不可能从 wasm 里取文案。

import type { ErrorCode, ToolError } from './backend/types';

const FALLBACK: Record<ErrorCode, string> = {
  INPUT_TOO_LARGE: '文件超过在线版上限，请使用桌面版处理',
  DIMENSION_LIMIT: '图片像素数超过在线版上限',
  PAGE_LIMIT: 'PDF 页数超过在线版上限',
  DURATION_LIMIT: '视频时长超过在线版上限',
  MEMORY_LIMIT: '预计内存占用超过安全值',
  UNSUPPORTED_FORMAT: '不支持的文件格式',
  DECODE_FAILED: '文件解码失败，可能已损坏',
  ENCODE_FAILED: '编码失败',
  CODEC_UNSUPPORTED: '当前浏览器不支持该编码格式',
  CANCELLED: '已取消',
  TIMEOUT: '处理超时',
  OUT_OF_MEMORY: '内存不足，请减小尺寸或改用桌面版',
  IO: '读写失败',
  PERMISSION_DENIED: '没有文件访问权限',
  INVALID_PARAMS: '参数不合法',
  INTERNAL: '内部错误',
  WASM_LOAD_FAILED: '核心模块加载失败，请刷新页面重试',
  WASM_MIME_MISMATCH: '核心模块 MIME 不正确（本地服务器可能未识别 .wasm）',
  BINARY_MISSING: '桌面组件缺失，请重新安装',
  BINARY_VERSION: '桌面组件版本不匹配',
  LIBREOFFICE_MISSING: '未找到 LibreOffice，Word↔PDF 只能做结构化转换',
};

export function messageOf(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'message' in e) {
    const m = (e as ToolError).message;
    if (typeof m === 'string' && m.length > 0) return m;
  }
  return '发生未知错误';
}

export function codeOf(e: unknown): ErrorCode {
  if (typeof e === 'object' && e !== null && 'code' in e) {
    const c = (e as ToolError).code;
    if (typeof c === 'string' && c in FALLBACK) return c as ErrorCode;
  }
  return 'INTERNAL';
}

export function fallbackMessage(code: ErrorCode): string {
  return FALLBACK[code] ?? '发生未知错误';
}

export function isToolError(e: unknown): e is ToolError {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    'message' in e &&
    'retryable' in e &&
    'desktopHint' in e
  );
}

/** 桌面版 Release 链接（超限引导用） */
export const DESKTOP_RELEASE_URL = 'https://github.com/lucky845/media-toolbox/releases/latest';

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export function formatPercent(r: number): string {
  if (!Number.isFinite(r)) return '—';
  return `${(r * 100).toFixed(0)}%`;
}
