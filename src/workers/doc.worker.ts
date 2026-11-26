// 文档/视频 Worker：加载 core_doc 分包并调用 wasm 导出。
// 与 image.worker.ts 同一套协议（src/workers/protocol.ts），只是加载不同的 wasm 包。

import { loadWasmModule } from '../lib/backend/web/wasmLoader';
import { PROTOCOL_VERSION, type FromWorker, type ToWorker } from './protocol';

// core_doc.js 的导出形态（与 crates/wasm/src/doc.rs 一一对应）
interface DocGlue {
  default: (input?: unknown) => Promise<void>;
  initSync: (input: { module: WebAssembly.Module } | WebAssembly.Module) => void;
  pdf_probe(input: Uint8Array): string;
  pdf_merge(inputs: Uint8Array[]): Uint8Array;
  pdf_split(input: Uint8Array, rangesJson: string, selectorJson: string): string;
  pdf_rotate(input: Uint8Array, selectorJson: string, degrees: number): Uint8Array;
  pdf_extract(input: Uint8Array, selectorJson: string, what: string): string;
  video_build_args(paramsJson: string, input: string, output: string): string;
  video_parse_progress(totalSec: number, line: string): string;
  office_structure_text(raw: string): string;
  office_fidelity_note(direction: string): string;
}

let glue: DocGlue | null = null;

function send(msg: FromWorker, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(msg, transfer);
}

function errObj(e: unknown): { code: string; message: string; retryable: boolean; desktopHint: boolean } {
  if (typeof e === 'string') {
    try {
      return JSON.parse(e);
    } catch {
      // ignore
    }
  }
  return {
    code: 'INTERNAL',
    message: e instanceof Error ? e.message : '文档处理失败',
    retryable: true,
    desktopHint: false,
  };
}

function toBytes(b64: string): Uint8Array {
  const T = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = b64.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = T.indexOf(clean[i]!);
    const b = T.indexOf(clean[i + 1]!);
    const c = i + 2 < clean.length ? T.indexOf(clean[i + 2]!) : 0;
    const d = i + 3 < clean.length ? T.indexOf(clean[i + 3]!) : 0;
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (p < out.length) out[p++] = (n >> 16) & 255;
    if (p < out.length) out[p++] = (n >> 8) & 255;
    if (p < out.length) out[p++] = n & 255;
  }
  return out.subarray(0, p);
}

async function init(glueUrl: string, wasmUrl: string): Promise<void> {
  const mod = (await import(/* @vite-ignore */ glueUrl)) as DocGlue;
  const loaded = await loadWasmModule(wasmUrl);
  mod.initSync({ module: loaded.module });
  glue = mod;
  send({
    v: PROTOCOL_VERSION,
    type: 'ready',
    contractVersion: 1,
    version: 'doc-v1',
    limits: {
      maxPixels: -1, maxBytes: -1, maxBatch: -1, maxDurationSec: -1,
      maxPages: 100, maxMemoryBytes: 0, maxConcurrent: 1, isRestricted: true,
    },
    loadPath: loaded.loadPath,
  });
}

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  if (msg.v !== PROTOCOL_VERSION) return;

  switch (msg.type) {
    case 'init':
      try {
        await init(msg.glueUrl, msg.wasmUrl);
      } catch (e) {
        send({
          v: PROTOCOL_VERSION,
          type: 'error',
          taskId: 'init',
          error: errObj(e) as never,
        });
      }
      return;

    case 'probe': {
      if (!glue) {
        send({ v: PROTOCOL_VERSION, type: 'error', taskId: msg.taskId, error: errObj('模块未就绪') as never });
        return;
      }
      try {
        const meta = JSON.parse(glue.pdf_probe(new Uint8Array(msg.input.slice(0))));
        send({ v: PROTOCOL_VERSION, type: 'probed', taskId: msg.taskId, meta });
      } catch (e) {
        send({ v: PROTOCOL_VERSION, type: 'error', taskId: msg.taskId, error: errObj(e) as never });
      }
      return;
    }

    case 'runDoc': {
      if (!glue) {
        send({ v: PROTOCOL_VERSION, type: 'error', taskId: msg.taskId, error: errObj('模块未就绪') as never });
        return;
      }
      const taskId = msg.taskId;
      try {
        const { payload } = msg;
        let bytes: Uint8Array = new Uint8Array(0);
        let outputs: Array<{ name: string; bytes: Uint8Array }> | undefined;
        let text: string | undefined;
        let outputName = 'output.pdf';

        const inputs = msg.inputs.map((buffer) => new Uint8Array(buffer));

        switch (payload.kind) {
          case 'pdf.merge': {
            bytes = glue.pdf_merge(inputs);
            outputName = 'merged.pdf';
            break;
          }
          case 'pdf.split': {
            const parsed = JSON.parse(glue.pdf_split(
              inputs[0]!,
              JSON.stringify(payload.ranges.map((x) => ({ from: x.from, toInclusive: x.toInclusive }))),
              JSON.stringify({ ranges: [], oddOnly: false, evenOnly: false }),
            )) as Array<{ name: string; bytes: string }>;
            outputs = parsed.map((p) => ({ name: `${p.name}.pdf`, bytes: toBytes(p.bytes) }));
            outputName = outputs[0]?.name ?? 'part-1.pdf';
            bytes = outputs[0]?.bytes ?? new Uint8Array(0);
            break;
          }
          case 'pdf.rotate': {
            bytes = glue.pdf_rotate(
              inputs[0]!,
              JSON.stringify({ ranges: payload.pages.ranges, oddOnly: payload.pages.oddOnly, evenOnly: payload.pages.evenOnly }),
              payload.degrees,
            );
            outputName = 'rotated.pdf';
            break;
          }
          case 'pdf.extract': {
            const r = glue.pdf_extract(
              inputs[0]!,
              JSON.stringify({ ranges: payload.pages.ranges, oddOnly: payload.pages.oddOnly, evenOnly: payload.pages.evenOnly }),
              payload.what,
            );
            if (payload.what === 'text') {
              text = (JSON.parse(r) as { text: string }).text;
              outputName = 'extracted.txt';
              bytes = new TextEncoder().encode(text);
            } else if (payload.what === 'pages') {
              bytes = toBytes(r);
              outputName = 'extracted.pdf';
            } else {
              const parsed = JSON.parse(r) as Array<{ name: string; bytes: string }>;
              outputs = parsed.map((p) => ({ name: `${p.name}.bin`, bytes: toBytes(p.bytes) }));
              outputName = outputs[0]?.name ?? 'image.bin';
              bytes = outputs[0]?.bytes ?? new Uint8Array(0);
            }
            break;
          }
          case 'office.structure': {
            // Word→PDF / PDF→Word 的结构化转换在前端用 JS 库完成（mammoth/pdf-lib/docx）。
            // Worker 只提供「PDF 文本结构化」辅助：先把 PDF 的文本抽出来做成段落。
            const raw = glue.pdf_extract(
              inputs[0]!,
              JSON.stringify({ ranges: [], oddOnly: false, evenOnly: false }),
              'text',
            );
            const textRaw = (JSON.parse(raw) as { text: string }).text;
            const paras = glue.office_structure_text(textRaw);
            text = paras;
            bytes = new TextEncoder().encode(text);
            outputName = payload.direction === 'docx2pdf' ? 'converted.json' : 'structured.json';
            break;
          }
          case 'video.transcode': {
            // Web 侧视频走 WebCodecs（主线程），这里只返回构造好的 argv（供可选 ffmpeg.wasm 降级）
            const params = payload.params as unknown as Record<string, unknown>;
            const args = glue.video_build_args(
              JSON.stringify({ rateMode: 'crf', crf: 23, bitrateKbps: 2500, container: 'mp4', audioBitrateKbps: 128, ...params }),
              'input',
              'output.mp4',
            );
            text = args;
            bytes = new TextEncoder().encode(text);
            outputName = 'ffmpeg-args.txt';
            break;
          }
          default: {
            send({
              v: PROTOCOL_VERSION,
              type: 'error',
              taskId,
              error: errObj(`暂不支持: ${(payload as { kind: string }).kind}`) as never,
            });
            return;
          }
        }

        // 用 ArrayBuffer 显式构造，避免 TS 把 .buffer 推断为 ArrayBufferLike（可能是 SharedArrayBuffer）
        send({
          v: PROTOCOL_VERSION,
          type: 'log',
          taskId,
          level: 'info',
          message: `outputName=${outputName}`,
        });

        const copy = new Uint8Array(bytes.length);
        copy.set(bytes);
        const out = copy.buffer.slice(0) as ArrayBuffer;
        send(
          {
            v: PROTOCOL_VERSION,
            type: 'done',
            taskId,
            output: out,
            meta: {
              outFormat: 'pdf' as never,
              outWidth: 0,
              outHeight: 0,
              inputBytes: inputs.reduce((n, i) => n + i.length, 0),
              outputBytes: bytes.length,
              outputHash: '',
              savingsRatio: 0,
              savingsText: '',
            },
          },
          [out],
        );
      } catch (e) {
        send({
          v: PROTOCOL_VERSION,
          type: 'error',
          taskId,
          error: errObj(e) as never,
        });
      }
      return;
    }

    case 'dispose':
      glue = null;
      self.close();
      return;
  }
};
