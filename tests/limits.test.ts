import { describe, expect, it } from 'vitest';
import { fallbackMessage, formatBytes, codeOf, isToolError, messageOf } from '../src/lib/errors';
import type { ErrorCode, ToolError } from '../src/lib/backend/types';

describe('错误处理', () => {
  it('每个错误码都有中文兜底文案', () => {
    const codes: ErrorCode[] = [
      'INPUT_TOO_LARGE', 'DIMENSION_LIMIT', 'PAGE_LIMIT', 'DURATION_LIMIT', 'MEMORY_LIMIT',
      'UNSUPPORTED_FORMAT', 'DECODE_FAILED', 'ENCODE_FAILED', 'CODEC_UNSUPPORTED',
      'CANCELLED', 'TIMEOUT', 'OUT_OF_MEMORY', 'IO', 'PERMISSION_DENIED',
      'INVALID_PARAMS', 'INTERNAL', 'WASM_LOAD_FAILED', 'WASM_MIME_MISMATCH',
      'BINARY_MISSING', 'BINARY_VERSION', 'LIBREOFFICE_MISSING',
    ];
    for (const c of codes) {
      const m = fallbackMessage(c);
      expect(m.length).toBeGreaterThan(0);
      expect(m).not.toContain('未知错误');
    }
  });

  it('isToolError 只认完整结构', () => {
    expect(isToolError({ code: 'IO', message: 'x', retryable: true, desktopHint: false })).toBe(true);
    expect(isToolError({ code: 'IO', message: 'x' })).toBe(false);
    expect(isToolError(null)).toBe(false);
  });

  it('messageOf 优先用错误的 message', () => {
    const e: ToolError = {
      code: 'DIMENSION_LIMIT',
      message: '图片太大',
      retryable: false,
      desktopHint: true,
    };
    expect(messageOf(e)).toBe('图片太大');
    // 非 ToolError：保留原始 message（我们自己的代码抛的都是中文），
    // 完全无信息时才兜底为「发生未知错误」
    expect(messageOf(new Error('Worker 异常退出'))).toBe('Worker 异常退出');
    expect(messageOf({})).toBe('发生未知错误');
    expect(messageOf('a string')).toBe('发生未知错误');
  });

  it('codeOf 对未知码返回 INTERNAL', () => {
    expect(codeOf({ code: 'NOPE' })).toBe('INTERNAL');
    expect(codeOf({ code: 'IO' })).toBe('IO');
  });

  it('formatBytes 的边界', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(-1)).toBe('—');
  });
});
