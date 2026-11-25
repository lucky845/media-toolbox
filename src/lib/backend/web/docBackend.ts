// 文档 Backend：第二个 Worker（core_doc 分包）。
//
// 为什么和 WebBackend 分开：两个 wasm 包（image / doc）互不依赖，
// 分开加载让「只用图片」的用户不下载 doc 包（307 KB vs 531 KB）。
// features/ 不感知这个差异 —— 它通过 lib/backend/index.ts 的 getDocBackend() 使用。
//
// 当前支持：PDF 旋转 / 拆分 / 提取（wasm）；
// Word↔PDF 结构化转换：由前端 mammoth/pdf-lib/docx 完成（Phase 4 后续接入），
// 这里先返回核心提示与结构化文本，UI 常驻保真度声明。

import { PROTOCOL_VERSION, type FromWorker, type ToWorker } from '../../../workers/protocol';
import type {
  Backend,
  Capabilities,
  InputRef,
  Limits,
  RunOptions,
  TaskPayload,
  TaskResult,
  ToolError,
} from '../types';

function wasmUrls(): { glue: string; wasm: string } {
  const base = import.meta.env.BASE_URL || '/';
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return {
    glue: `${prefix}wasm/core_doc.js`,
    wasm: `${prefix}wasm/core_doc_bg.wasm`,
  };
}

interface Pending {
  resolve: (r: TaskResult) => void;
  reject: (e: ToolError) => void;
  onProgress: RunOptions['onProgress'];
  onLog?: RunOptions['onLog'];
  outputName: string;
  settled: boolean;
}

const DOC_LIMITS: Limits = {
  maxPixels: -1,
  maxBytes: -1,
  maxBatch: -1,
  maxDurationSec: -1,
  maxPages: 100,
  maxMemoryBytes: 0,
  maxConcurrent: 1,
  isRestricted: true,
};

export class DocBackend implements Backend {
  readonly kind = 'web' as const;

  private worker: Worker | null = null;
  private ready = false;
  private initPromise: Promise<void> | null = null;
  private pending = new Map<string, Pending>();
  private probes = new Map<string, (m: unknown) => void>();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('../../../workers/doc.worker.ts', import.meta.url), {
      type: 'module',
      name: 'media-doc',
    });
    w.onmessage = (ev: MessageEvent<FromWorker>) => this.onMessage(ev.data);
    const { glue, wasm } = wasmUrls();
    w.postMessage({ v: PROTOCOL_VERSION, type: 'init', glueUrl: glue, wasmUrl: wasm } as ToWorker);
    this.worker = w;
    return w;
  }

  private init(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.initPromise) return this.initPromise;
    this.initPromise = new Promise<void>((resolve, reject) => {
      const w = this.ensureWorker();
      const orig = w.onmessage;
      const timer = setTimeout(() => reject({
        code: 'WASM_LOAD_FAILED',
        message: '文档模块加载超时',
        retryable: true,
        desktopHint: false,
      } satisfies ToolError), 30_000);
      w.onmessage = (ev: MessageEvent<FromWorker>) => {
        const m = ev.data;
        if (m.type === 'ready') {
          clearTimeout(timer);
          this.ready = true;
          w.onmessage = orig;
          resolve();
        } else if (m.type === 'error' && m.taskId === 'init') {
          clearTimeout(timer);
          w.onmessage = orig;
          this.initPromise = null;
          reject(m.error);
        } else {
          this.onMessage(m);
        }
      };
    });
    return this.initPromise;
  }

  private onMessage(m: FromWorker): void {
    switch (m.type) {
      case 'probed': {
        const cb = this.probes.get(m.taskId);
        if (cb) { this.probes.delete(m.taskId); cb(m.meta); }
        return;
      }
      case 'progress':
        return;
      case 'log': {
        const p = this.pending.get(m.taskId);
        if (m.message.startsWith('outputName=') && p) {
          p.outputName = m.message.slice('outputName='.length);
        }
        p?.onLog?.({ level: m.level, message: m.message, at: Date.now() });
        return;
      }
      case 'done': {
        const p = this.pending.get(m.taskId);
        if (!p || p.settled) return;
        p.settled = true;
        this.pending.delete(m.taskId);
        p.resolve({
          bytes: new Uint8Array(m.output),
          meta: m.meta,
          outputName: p.outputName,
        });
        return;
      }
      case 'error':
      case 'cancelled': {
        const p = this.pending.get(m.taskId);
        if (!p || p.settled) return;
        p.settled = true;
        this.pending.delete(m.taskId);
        p.reject(m.type === 'cancelled'
          ? { code: 'CANCELLED', message: '已取消', retryable: false, desktopHint: false }
          : m.error);
        return;
      }
    }
  }

  async capabilities(): Promise<Capabilities> {
    await this.init();
    return {
      kind: 'web',
      contractVersion: 1,
      image: { formats: [], avif: false, maxPixels: -1, parallel: 1, pngOptimize: false },
      video: { available: false, engines: [], decoders: [], encoders: [], hardwareEncoder: false, maxBytes: -1, maxDurationSec: -1 },
      pdf: { render: true, edit: true, maxPages: 100 },
      office: { wordToPdf: 'structured', pdfToWord: 'structured' },
      cancel: { hard: false },
      fileSystem: { directoryPicker: false, savePicker: false },
      offline: { serviceWorker: false, installed: false },
      env: { userAgentMajor: '', crossOriginIsolated: false },
    };
  }

  async limits(): Promise<Limits> {
    await this.init();
    return DOC_LIMITS;
  }

  /** 探测 PDF 元信息（只读，不修改文件） */
  async probe(ref: InputRef): Promise<unknown> {
    await this.init();
    const w = this.worker;
    if (!w) throw new Error('worker 不可用');
    const bytes = ref.file ? new Uint8Array(await ref.file.arrayBuffer()) : new Uint8Array(0);
    const buf = bytes.buffer.slice(0) as ArrayBuffer;
    const taskId = `probe-${Math.random().toString(36).slice(2, 10)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.probes.delete(taskId);
        reject({ code: 'TIMEOUT', message: 'PDF 探测超时', retryable: true, desktopHint: false });
      }, 30_000);
      this.probes.set(taskId, (meta) => { clearTimeout(timer); resolve(meta); });
      w.postMessage({
        v: PROTOCOL_VERSION,
        type: 'probe',
        taskId,
        input: buf,
        inputName: ref.name,
      } as ToWorker, [buf]);
    });
  }

  async run(task: TaskPayload, opts: RunOptions): Promise<TaskResult> {
    await this.init();
    const w = this.worker;
    if (!w) throw { code: 'WASM_LOAD_FAILED', message: 'Worker 不可用', retryable: true, desktopHint: false } satisfies ToolError;

    const ref = 'input' in task ? task.input : null;
    const bytes = ref?.file ? new Uint8Array(await ref.file.arrayBuffer()) : new Uint8Array(0);
    const buf = bytes.buffer.slice(0) as ArrayBuffer;

    return new Promise<TaskResult>((resolve, reject) => {
      const p: Pending = {
        resolve,
        reject,
        onProgress: opts.onProgress,
        onLog: opts.onLog,
        outputName: 'output.pdf',
        settled: false,
      };
      this.pending.set(opts.taskId, p);

      const onAbort = () => this.cancel(opts.taskId);
      opts.signal.addEventListener('abort', onAbort, { once: true });

      const msg: ToWorker = {
        v: PROTOCOL_VERSION,
        type: 'runDoc',
        taskId: opts.taskId,
        input: buf,
        inputName: ref?.name ?? 'input.pdf',
        payload: task,
      };
      w.postMessage(msg, [buf]);
    });
  }

  cancel(taskId: string): void {
    const p = this.pending.get(taskId);
    if (p && !p.settled) {
      p.settled = true;
      this.pending.delete(taskId);
      p.reject({ code: 'CANCELLED', message: '已取消', retryable: false, desktopHint: false });
    }
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.ready = false;
      this.initPromise = null;
    }
  }

  async pickFiles(accept: string, multiple: boolean): Promise<InputRef[]> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.multiple = multiple;
      input.style.display = 'none';
      document.body.appendChild(input);
      let done = false;
      const finish = (refs: InputRef[]) => {
        if (done) return;
        done = true;
        input.remove();
        resolve(refs);
      };
      input.onchange = () => {
        finish(Array.from(input.files ?? []).map((f) => ({ file: f, name: f.name, size: f.size })));
      };
      window.addEventListener('focus', () => {
        setTimeout(() => {
          if (!done && (!input.files || input.files.length === 0)) finish([]);
        }, 300);
      }, { once: true });
      input.click();
    });
  }

  async saveOutput(bytes: Uint8Array, name: string): Promise<'downloaded' | 'saved' | 'cancelled'> {
    const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return 'downloaded';
  }

  dispose(): void {
    if (this.worker) {
      this.worker.postMessage({ v: PROTOCOL_VERSION, type: 'dispose' } as ToWorker);
      this.worker.terminate();
      this.worker = null;
    }
    this.ready = false;
    this.initPromise = null;
    this.pending.clear();
  }
}

let singleton: DocBackend | null = null;
export function getDocBackend(): DocBackend {
  if (!singleton) singleton = new DocBackend();
  return singleton;
}
