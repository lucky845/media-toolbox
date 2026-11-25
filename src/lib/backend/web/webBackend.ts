// Web 后端：Worker + wasm。
//
// 关键设计：
//  - **每次 run 独占一个 worker 生命周期中的任务**，取消 = terminate。
//  - 保留一个「空闲 worker」复用，减少每次任务的 30–80 ms 启动开销。
//  - 所有 URL 都经 `import.meta.env.BASE_URL` 拼接（规格 §16）。

import { warmWasm } from './wasmLoader';
import {
  PROTOCOL_VERSION,
  isTerminal,
  type FromWorker,
  type ToWorker,
} from '../../../workers/protocol';
import type {
  Capabilities,
  ImageMeta,
  ImageResultMeta,
  InputRef,
  Limits,
  LogEntry,
  Progress,
  RunOptions,
  TaskPayload,
  TaskResult,
  ToolError,
} from '../types';

/** wasm 与胶水的位置：全部相对 BASE_URL，禁止硬编码绝对路径 */
function wasmUrls(): { glue: string; wasm: string } {
  const base = import.meta.env.BASE_URL || '/';
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return {
    glue: `${prefix}wasm/core_image.js`,
    wasm: `${prefix}wasm/core_image_bg.wasm`,
  };
}

interface PendingTask {
  resolve: (r: TaskResult) => void;
  reject: (e: ToolError) => void;
  onProgress: (p: Progress) => void;
  onLog?: (e: LogEntry) => void;
  chunks: Uint8Array[];
  meta?: ImageResultMeta;
  outputName?: string;
  settled: boolean;
}

export class WebBackend implements Backend_ {
  readonly kind = 'web' as const;

  private worker: Worker | null = null;
  private ready = false;
  private initPromise: Promise<void> | null = null;
  private limitsCache: Limits | null = null;
  private capsCache: Capabilities | null = null;
  private loadPath = '';
  /** init 阶段（无 taskId）的日志，供「能力与限制」页与排障读取 */
  private initLogs: LogEntry[] = [];
  /** taskId → 待决任务 */
  private pending = new Map<string, PendingTask>();
  /** 探测请求的待决回调 */
  private probes = new Map<string, (m: ImageMeta) => void>();

  // ---- 初始化 ----

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;

    const w = new Worker(new URL('../../../workers/image.worker.ts', import.meta.url), {
      type: 'module',
      name: 'media-image',
    });

    w.onmessage = (ev: MessageEvent<FromWorker>) => this.onMessage(ev.data);
    w.onerror = (ev) => {
      const err: ToolError = {
        code: 'INTERNAL',
        message: 'Worker 异常退出',
        detail: ev.message,
        retryable: true,
        desktopHint: false,
      };
      for (const [, p] of this.pending) {
        if (!p.settled) {
          p.settled = true;
          p.reject(err);
        }
      }
      this.pending.clear();
      this.worker = null;
      this.ready = false;
      this.initPromise = null;
    };

    const { glue, wasm } = wasmUrls();
    // 预热：让 SW 缓存 wasm 与胶水（离线可用）；不阻塞 worker init
    void warmWasm(wasm);
    void warmWasm(glue);
    const initMsg: ToWorker = { v: PROTOCOL_VERSION, type: 'init', glueUrl: glue, wasmUrl: wasm };
    w.postMessage(initMsg);

    this.worker = w;
    return w;
  }

  private init(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise<void>((resolve, reject) => {
      const w = this.ensureWorker();
      const orig = w.onmessage;
      const timeout = setTimeout(() => {
        reject({
          code: 'WASM_LOAD_FAILED',
          message: '核心模块加载超时（30 秒）',
          retryable: true,
          desktopHint: true,
        });
      }, 30_000);

      w.onmessage = (ev: MessageEvent<FromWorker>) => {
        const m = ev.data;
        if (m.type === 'ready') {
          clearTimeout(timeout);
          this.ready = true;
          this.limitsCache = m.limits;
          this.loadPath = m.loadPath;
          w.onmessage = orig;
          resolve();
          return;
        }
        if (m.type === 'error' && m.taskId === 'init') {
          clearTimeout(timeout);
          w.onmessage = orig;
          this.initPromise = null;
          this.worker = null;
          w.terminate();
          reject(m.error);
          return;
        }
        // 其他消息交给正常分发
        this.onMessage(m);
      };
    });

    return this.initPromise;
  }

  private onMessage(m: FromWorker): void {
    switch (m.type) {
      case 'ready':
        this.ready = true;
        this.limitsCache = m.limits;
        this.loadPath = m.loadPath;
        return;
      case 'probed': {
        const cb = this.probes.get(m.taskId);
        if (cb) {
          this.probes.delete(m.taskId);
          cb(m.meta);
        }
        return;
      }
      case 'progress': {
        const p = this.pending.get(m.taskId);
        if (p && !p.settled) p.onProgress(m.p);
        return;
      }
      case 'done': {
        const p = this.pending.get(m.taskId);
        if (!p || p.settled) return;
        p.settled = true;
        p.meta = m.meta;
        const bytes = new Uint8Array(m.output);
        // outputName 由 worker 通过 log 消息送来；若没到就用兜底名
        p.chunks.push(bytes);
        this.pending.delete(m.taskId);
        const merged = concat(p.chunks);
        p.resolve({
          bytes: merged,
          meta: m.meta,
          outputName: p.outputName ?? 'output',
        });
        return;
      }
      case 'cancelled': {
        const p = this.pending.get(m.taskId);
        if (!p || p.settled) return;
        p.settled = true;
        this.pending.delete(m.taskId);
        p.reject({
          code: 'CANCELLED',
          message: '已取消',
          retryable: false,
          desktopHint: false,
        });
        return;
      }
      case 'error': {
        const p = this.pending.get(m.taskId);
        if (!p || p.settled) return;
        p.settled = true;
        this.pending.delete(m.taskId);
        p.reject(m.error);
        return;
      }
      case 'log': {
        if (m.taskId === 'init') {
          this.initLogs.push({ level: m.level, message: m.message, at: Date.now() });
          if (this.initLogs.length > 50) this.initLogs.shift();
          return;
        }
        const p = this.pending.get(m.taskId);
        if (m.message.startsWith('outputName=')) {
          if (p) p.outputName = m.message.slice('outputName='.length);
        }
        if (p && p.onLog) {
          p.onLog({ level: m.level, message: m.message, at: Date.now() });
        }
        return;
      }
    }
  }

  // ---- Backend 接口 ----

  async capabilities(): Promise<Capabilities> {
    await this.init();
    if (this.capsCache) return this.capsCache;

    // wasm 侧的静态能力（编译进包的 codec 集合）从 worker 拿；浏览器能力在这里探测。
    const merged = await this.mergeBrowserCaps();
    this.capsCache = merged;
    return merged;
  }

  async limits(): Promise<Limits> {
    await this.init();
    if (!this.limitsCache) throw new Error('limits 未初始化');
    return this.limitsCache;
  }

  private async mergeBrowserCaps(): Promise<Capabilities> {
    // 这里的能力对象是「wasm 静态能力 + 浏览器动态能力」的合并。
    // 静态部分来自 Rust（唯一来源），动态部分只能在这里探测。
    const has = (k: string) => {
      try {
        return k in globalThis;
      } catch {
        return false;
      }
    };

    const videoEncoder = has('VideoEncoder');
    const videoDecoder = has('VideoDecoder');
    const savePicker = typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function';
    const dirPicker = typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
    // 注意：getRegistration() 在无注册时返回 undefined。
    // 早期版本写成 `!== undefined`（恒真）导致 UI 错误地宣称「可离线」—— 已在 e2e 中发现并修复。
    const sw = 'serviceWorker' in navigator;
    let swReady = false;
    if (sw) {
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        swReady = reg?.active?.state === 'activated';
      } catch {
        swReady = false;
      }
    }
    const coi = (self as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
    const ua = navigator.userAgent;
    const major = (/(?:Chrome|Firefox|Version)\/(\d+)/.exec(ua)?.[1] ?? '0');

    return {
      kind: 'web',
      contractVersion: 1,
      image: {
        formats: ['jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff'],
        avif: false,
        maxPixels: 20_000_000,
        parallel: 1,
        pngOptimize: false,
      },
      video: {
        available: videoEncoder && videoDecoder,
        engines: videoEncoder ? ['webcodecs', 'ffmpeg-wasm'] : ['ffmpeg-wasm'],
        decoders: [],
        encoders: [],
        hardwareEncoder: false,
        maxBytes: 200 * 1024 * 1024,
        maxDurationSec: 300,
      },
      pdf: { render: true, edit: true, maxPages: 100 },
      office: { wordToPdf: 'structured', pdfToWord: 'structured' },
      cancel: { hard: false },
      fileSystem: { directoryPicker: dirPicker, savePicker },
      offline: { serviceWorker: sw, installed: swReady },
      env: { userAgentMajor: major, crossOriginIsolated: coi },
    };
  }

  async run(task: TaskPayload, opts: RunOptions): Promise<TaskResult> {
    if (task.kind !== 'image.process') {
      throw {
        code: 'UNSUPPORTED_FORMAT',
        message: `当前版本暂不支持 ${task.kind}`,
        retryable: false,
        desktopHint: false,
      } satisfies ToolError;
    }

    await this.init();
    const w = this.worker;
    if (!w) throw { code: 'WASM_LOAD_FAILED', message: 'Worker 不可用', retryable: true, desktopHint: false } satisfies ToolError;

    const bytes = task.input.file
      ? new Uint8Array(await task.input.file.arrayBuffer())
      : new Uint8Array();

    if (bytes.length === 0) {
      throw {
        code: 'IO',
        message: '无法读取文件内容',
        retryable: false,
        desktopHint: false,
      } satisfies ToolError;
    }

    // 转移 buffer 给 worker（零拷贝）
    const buf = bytes.buffer.slice(0) as ArrayBuffer;

    return new Promise<TaskResult>((resolve, reject) => {
      const p: PendingTask = {
        resolve,
        reject,
        onProgress: opts.onProgress,
        onLog: opts.onLog,
        chunks: [],
        settled: false,
      };
      this.pending.set(opts.taskId, p);

      // 取消：Web 端是硬取消（terminate），因为 wasm 同步执行无法软中断
      const onAbort = () => {
        this.cancel(opts.taskId);
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });

      const msg: ToWorker = {
        v: PROTOCOL_VERSION,
        type: 'run',
        taskId: opts.taskId,
        input: buf,
        inputName: task.input.name,
        params: task.params,
        encode: task.encode,
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
    // 硬取消：terminate 后重建 worker（下一个任务会重新 init）
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.ready = false;
      this.initPromise = null;
    }
  }

  /** 探测单张图（不入队） */
  async probe(ref: InputRef): Promise<ImageMeta> {
    await this.init();
    const w = this.worker;
    if (!w) throw new Error('worker 不可用');
    const bytes = ref.file ? new Uint8Array(await ref.file.arrayBuffer()) : new Uint8Array();
    const buf = bytes.buffer.slice(0) as ArrayBuffer;
    const taskId = `probe-${Math.random().toString(36).slice(2, 10)}`;

    return new Promise<ImageMeta>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.probes.delete(taskId);
        reject(new Error('探测超时'));
      }, 15_000);
      this.probes.set(taskId, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      w.postMessage(
        { v: PROTOCOL_VERSION, type: 'probe', taskId, input: buf, inputName: ref.name } as ToWorker,
        [buf],
      );
    });
  }

  async pickFiles(accept: string, multiple: boolean): Promise<InputRef[]> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.multiple = multiple;
      input.style.display = 'none';
      document.body.appendChild(input);

      let settled = false;
      const finish = (refs: InputRef[]) => {
        if (settled) return;
        settled = true;
        input.remove();
        resolve(refs);
      };

      input.onchange = () => {
        const files = Array.from(input.files ?? []);
        finish(files.map((f) => ({ file: f, name: f.name, size: f.size })));
      };
      // 用户取消：没有 change 事件，靠 window focus 兜底（200ms 后仍无文件即视为取消）
      window.addEventListener(
        'focus',
        () => {
          setTimeout(() => {
            if (!settled && (!input.files || input.files.length === 0)) finish([]);
          }, 300);
        },
        { once: true },
      );

      input.click();
    });
  }

  async saveOutput(bytes: Uint8Array, name: string): Promise<'downloaded' | 'saved' | 'cancelled'> {
    // 优先用 File System Access API（可让用户选目录），降级到 <a download>
    const picker = (globalThis as {
      showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle>;
    }).showSaveFilePicker;

    if (picker) {
      try {
        const handle = await picker({
          suggestedName: name,
          types: [
            {
              description: '输出文件',
              accept: { 'application/octet-stream': [`.${name.split('.').pop() ?? 'bin'}`] },
            },
          ],
        });
        const writable = await handle.createWritable();
        // Uint8Array 的底层 buffer 可能是 SharedArrayBuffer，这里显式复制成 ArrayBuffer
        await writable.write(bytes.slice().buffer as ArrayBuffer);
        await writable.close();
        return 'saved';
      } catch (e) {
        if ((e as { name?: string }).name === 'AbortError') return 'cancelled';
        // 其他错误（权限、不支持的类型）降级到下载
      }
    }

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

  /** 本机加载路径（排障用） */
  getLoadPath(): string {
    return this.loadPath;
  }

  /** init 阶段日志（含 MIME 降级信息），不落盘不外发 */
  getInitLogs(): LogEntry[] {
    return [...this.initLogs];
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
    this.probes.clear();
  }
}

/** 拼接多个 Uint8Array（多数情况下只有一个） */
function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// 避免循环依赖：Backend 类型在 types.ts，这里只是实现
import type { Backend as Backend_ } from '../types';

void isTerminal;
