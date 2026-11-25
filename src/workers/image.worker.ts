// 图片处理 Worker：加载 wasm 并在其中执行 core 的算法。
//
// 为什么在 Worker 而不是主线程：20 MP 图的一次 lanczos3 缩放约 300–800 ms，
// 在主线程会直接冻住 UI（连进度条都刷不出来）。

import { loadWasmModule } from '../lib/backend/web/wasmLoader';
import type { ImageMeta, ImageResultMeta, Limits, ToolError } from '../lib/backend/types';
import {
  PROTOCOL_VERSION,
  type FromWorker,
  type ToWorker,
} from './protocol';

// wasm-bindgen 产物的形态（我们只用到这些）
interface Glue {
  default: (input?: unknown) => Promise<void>;
  initSync: (input: { module: WebAssembly.Module } | WebAssembly.Module) => void;
  contract_version(): number;
  version(): string;
  get_limits(): string;
  probe_image_meta(input: Uint8Array): string;
  process_image(
    input: Uint8Array,
    paramsJson: string,
    encodeJson: string,
    onProgress?: (done: number, total: number, phase: string) => void,
  ): Uint8Array;
  process_image_with_meta(
    input: Uint8Array,
    paramsJson: string,
    encodeJson: string,
    onProgress?: (done: number, total: number, phase: string) => void,
  ): string;
  make_output_name(stem: string, paramsJson: string, encodeJson: string): string;
  hash_bytes(input: Uint8Array): string;
  format_bytes(n: number): string;
  format_duration(s: number): string;
}

let glue: Glue | null = null;
let loadPath = '';
/** 当前任务是否已被取消（worker 内自己的标志；即时取消靠 terminate） */
let cancelRequested = false;

function send(msg: FromWorker, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(msg, transfer);
}

function sendError(taskId: string, error: ToolError): void {
  send({ v: PROTOCOL_VERSION, type: 'error', taskId, error });
}

function errFrom(e: unknown): ToolError {
  if (typeof e === 'string') {
    try {
      return JSON.parse(e) as ToolError;
    } catch {
      return {
        code: 'INTERNAL',
        message: '核心模块返回了无法解析的错误',
        detail: e,
        retryable: true,
        desktopHint: false,
      };
    }
  }
  return {
    code: 'INTERNAL',
    message: '处理失败',
    detail: e instanceof Error ? e.message : String(e),
    retryable: true,
    desktopHint: false,
  };
}

async function init(glueUrl: string, wasmUrl: string): Promise<void> {
  const mod = (await import(/* @vite-ignore */ glueUrl)) as Glue;
  const loaded = await loadWasmModule(wasmUrl);
  loadPath = loaded.loadPath;
  // 回传加载路径：线上排障时能看到「走了 streaming 还是降级」，
  // 而不需要用户打开 DevTools。日志只在本地环形缓冲，不外发。
  send({
    v: PROTOCOL_VERSION,
    type: 'log',
    taskId: 'init',
    level: 'info',
    message: `wasm 加载路径: ${loadPath}${loaded.contentType ? ` (content-type: ${loaded.contentType})` : ''}`,
  });
  // 用已编译的 module 实例化（避免二次下载与二次编译）
  mod.initSync({ module: loaded.module });
  glue = mod;

  const limits = JSON.parse(mod.get_limits()) as Limits;
  send({
    v: PROTOCOL_VERSION,
    type: 'ready',
    contractVersion: mod.contract_version(),
    version: mod.version(),
    limits,
    loadPath,
  });
}

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;

  if (msg.v !== PROTOCOL_VERSION) {
    // 版本不匹配：立刻报错，让主线程重建 worker（为热更新留余地）
    sendError(
      'unknown',
      {
        code: 'INTERNAL',
        message: 'Worker 协议版本不匹配，请刷新页面',
        detail: `expected=${PROTOCOL_VERSION} got=${String(msg.v)}`,
        retryable: true,
        desktopHint: false,
      },
    );
    return;
  }

  switch (msg.type) {
    case 'init': {
      try {
        await init(msg.glueUrl, msg.wasmUrl);
      } catch (e) {
        const err = (e as { code?: string }) && typeof e === 'object' && 'message' in (e as object)
          ? (e as ToolError)
          : errFrom(e);
        sendError('init', err);
      }
      return;
    }

    case 'probe': {
      if (!glue) {
        sendError(msg.taskId, { code: 'WASM_LOAD_FAILED', message: '核心模块尚未就绪', retryable: true, desktopHint: false });
        return;
      }
      try {
        const meta = JSON.parse(glue.probe_image_meta(new Uint8Array(msg.input))) as ImageMeta;
        send({ v: PROTOCOL_VERSION, type: 'probed', taskId: msg.taskId, meta });
      } catch (e) {
        sendError(msg.taskId, errFrom(e));
      }
      return;
    }

    case 'run': {
      if (!glue) {
        sendError(msg.taskId, { code: 'WASM_LOAD_FAILED', message: '核心模块尚未就绪', retryable: true, desktopHint: false });
        return;
      }
      cancelRequested = false;
      const taskId = msg.taskId;

      try {
        const onProgress = (done: number, total: number, phase: string) => {
          // 节流已在 Rust 侧（ThrottledProgress）完成，这里直接转发
          send({
            v: PROTOCOL_VERSION,
            type: 'progress',
            taskId,
            p: { done, total, phase: phase as never, unit: 'percent' },
          });
        };

        const input = new Uint8Array(msg.input);
        const paramsJson = JSON.stringify(msg.params);
        const encodeJson = JSON.stringify(msg.encode);

        // 先探测：超阈值在解码前就中止（不浪费 20 MP 的解码时间）
        const meta = JSON.parse(glue.probe_image_meta(input)) as ImageMeta;
        send({ v: PROTOCOL_VERSION, type: 'probed', taskId, meta });

        if (cancelRequested) {
          send({ v: PROTOCOL_VERSION, type: 'cancelled', taskId });
          return;
        }

        const out = glue.process_image(input, paramsJson, encodeJson, onProgress);
        const resultMeta = JSON.parse(
          glue.process_image_with_meta(input, paramsJson, encodeJson, undefined),
        ) as ImageResultMeta;

        // 复制到独立的 ArrayBuffer，才能 transfer（wasm 返回的 Uint8Array 底层是 wasm 内存）
        const bytes = new Uint8Array(out.length);
        bytes.set(out);
        const output = bytes.buffer;

        const stem = msg.inputName.replace(/\.[^.]+$/, '') || 'output';
        const outputName = glue.make_output_name(stem, paramsJson, encodeJson);

        send(
          { v: PROTOCOL_VERSION, type: 'done', taskId, output, meta: resultMeta },
          [output],
        );
        // outputName 单独放：它不在 ImageResultMeta 里，但 UI 需要
        send({
          v: PROTOCOL_VERSION,
          type: 'log',
          taskId,
          level: 'info',
          message: `outputName=${outputName}`,
        });
      } catch (e) {
        sendError(taskId, errFrom(e));
      }
      return;
    }

    case 'cancel': {
      // 软取消：只置标志。真正的即时取消由主线程 terminate() 完成。
      cancelRequested = true;
      return;
    }

    case 'dispose': {
      glue = null;
      self.close();
      return;
    }
  }
};
