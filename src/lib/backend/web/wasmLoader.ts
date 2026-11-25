// wasm 加载器 —— 两段降级 + 诊断（`docs/ARCHITECTURE.md` §5.1）。
//
// ## 为什么用 compileStreaming 而不是 instantiateStreaming
//
// `instantiateStreaming` 要求**同时**给 imports，而 wasm-bindgen 生成的 imports 是胶水内部
// 私有的对象。要在我们的 loader 里拿它，只能依赖胶水的内部实现细节 —— 一升级就坏。
//
// 所以拆成两步，语义完全等价、且更稳：
//   1) `WebAssembly.compileStreaming(fetch(url))` —— 一段式下载+编译，浏览器边下边编译
//   2) 失败 → `fetch → arrayBuffer → WebAssembly.compile` —— MIME 不对时的兜底
//   3) 仍失败 → 抛 `WASM_MIME_MISMATCH` 并带**实际** content-type，便于线上排障
// 编译完成后把 `WebAssembly.Module` 交给 `glue.initSync(module)` 实例化。
//
// 这段逻辑与 `scripts/wasm-harness.mjs` 里 Node 侧的加载**一一对应**，
// 所以「Node 里跑通」与「浏览器里跑通」走的是同一条路径。

import type { ToolError } from '../types';

export interface LoadResult {
  /** 已编译的模块 */
  module: WebAssembly.Module;
  /** 实际走的路径，用于本地日志 */
  loadPath: 'streaming' | 'arraybuffer' | 'cache';
  /** 服务端返回的 content-type（排障用；缓存命中时为 null） */
  contentType: string | null;
}

/** 进程内编译缓存：同一 URL 只编译一次（页面内多 worker 共享） */
const moduleCache = new Map<string, WebAssembly.Module>();

function mimeError(url: string, contentType: string | null, cause: string): ToolError {
  return {
    code: 'WASM_MIME_MISMATCH',
    message: `核心模块加载失败（服务端返回的 MIME 是 ${contentType ?? '空'}）。本地静态服务器可能没有为 .wasm 设置 application/wasm。`,
    detail: `url=${url} content-type=${contentType ?? 'null'} cause=${cause}`,
    retryable: true,
    desktopHint: false,
  };
}

function loadError(url: string, cause: string): ToolError {
  return {
    code: 'WASM_LOAD_FAILED',
    message: '核心模块加载失败，请刷新页面重试。',
    detail: `url=${url} cause=${cause}`,
    retryable: true,
    desktopHint: true,
  };
}

/**
 * 加载并编译 wasm 模块。
 *
 * @param url 已带 BASE_URL 的绝对/相对路径
 * @throws {ToolError} `WASM_MIME_MISMATCH`（MIME 不对）或 `WASM_LOAD_FAILED`（其他）
 */
export async function loadWasmModule(url: string): Promise<LoadResult> {
  const cached = moduleCache.get(url);
  if (cached) {
    return { module: cached, loadPath: 'cache', contentType: null };
  }

  let contentType: string | null = null;
  let response: Response | null = null;
  let firstCause = '';

  // ---- 第 1 段：流式编译 ----
  try {
    response = await fetch(url);
    contentType = response.headers.get('content-type');
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    if (typeof WebAssembly.compileStreaming === 'function') {
      // clone() 是因为 compileStreaming 会消耗 body，失败后第 2 段还要用同一个 response
      const module = await WebAssembly.compileStreaming(response.clone());
      moduleCache.set(url, module);
      return { module, loadPath: 'streaming', contentType };
    }
    firstCause = 'compileStreaming 不可用';
  } catch (e) {
    firstCause = e instanceof Error ? e.message : String(e);
    // 落到第 2 段。MIME 不对是预期内的情况，这里不抛。
  }

  // ---- 第 2 段：arrayBuffer → compile ----
  try {
    let bytes: ArrayBuffer;
    if (response && response.ok && !response.bodyUsed) {
      bytes = await response.arrayBuffer();
    } else {
      const r = await fetch(url);
      contentType = r.headers.get('content-type');
      if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
      bytes = await r.arrayBuffer();
    }
    const module = await WebAssembly.compile(bytes);
    moduleCache.set(url, module);
    return { module, loadPath: 'arraybuffer', contentType };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // MIME 明显不对 → 给专用错误码，前端据此提示「换 vite preview 或配置 MIME」
    if (contentType && !contentType.includes('wasm')) {
      throw mimeError(url, contentType, `${firstCause}; ${msg}`);
    }
    throw loadError(url, `${firstCause}; ${msg}`);
  }
}

/** 清空缓存（测试用） */
export function clearWasmCache(): void {
  moduleCache.clear();
}

/** 当前环境是否支持流式编译 */
export function supportsStreaming(): boolean {
  return typeof WebAssembly.compileStreaming === 'function';
}

/** 当前环境是否跨源隔离（GitHub Pages 上恒为 false，这里保留探测以便开发者本机验证） */
export function isCrossOriginIsolated(): boolean {
  return typeof self !== 'undefined' && (self as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
}
