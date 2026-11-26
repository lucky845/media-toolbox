// Web 后端：Worker + wasm。
//
// 关键设计：
//  - **每次 run 独占一个 worker 生命周期中的任务**，取消 = terminate。
//  - 保留一个「空闲 worker」复用，减少每次任务的 30–80 ms 启动开销。
//  - 所有 URL 都经 `import.meta.env.BASE_URL` 拼接（规格 §16）。

import { warmWasm } from './wasmLoader';
import { getVideoBackend, videoCodecSupport } from './videoBackend';
import { getDocBackend } from './docBackend';
import type { VideoProbeResult } from '../types';
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

const cancelled: ToolError = {
  code: 'CANCELLED', message: '已取消', retryable: false, desktopHint: false,
};

export class WebBackend implements Backend_ {
  readonly kind = 'web' as const;

  private worker: Worker | null = null;
  private ready = false;
  private initPromise: Promise<void> | null = null;
  private rejectInit: ((error: ToolError) => void) | null = null;
  private limitsCache: Limits | null = null;
  private capsCache: Capabilities | null = null;
  private loadPath = '';
  /** init 阶段（无 taskId）的日志，供「能力与限制」页与排障读取 */
  private initLogs: LogEntry[] = [];
  /** taskId → 待决任务 */
  private pending = new Map<string, PendingTask>();
  /**
   * 探测请求的待决项。
   *
   * 这里必须同时持有 resolve/reject/timer 三样东西：
   *  - 只存 resolve 时，worker 返回的 `error` 无处可去，只能等超时定时器触发，
   *    用户看到的是误导性的「探测超时」，而不是真实原因（如超像素上限）；
   *  - 成功时必须 clearTimeout，否则会留下野定时器（旧实现只在失败路径删过）。
   */
  private probes = new Map<
    string,
    { resolve: (m: ImageMeta) => void; reject: (e: unknown) => void; timer: number }
  >();

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
      if (this.worker === w) this.stopWorker(err);
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

    const w = this.ensureWorker();
    this.initPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.stopWorker({
          code: 'WASM_LOAD_FAILED',
          message: '核心模块加载超时（30 秒）',
          retryable: true,
          desktopHint: true,
        });
      }, 30_000);

      this.rejectInit = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
      w.onmessage = (ev: MessageEvent<FromWorker>) => {
        if (this.worker !== w) return;
        const m = ev.data;
        if (m.type === 'ready') {
          clearTimeout(timeout);
          this.ready = true;
          this.limitsCache = m.limits;
          this.loadPath = m.loadPath;
          this.rejectInit = null;
          resolve();
          return;
        }
        if (m.type === 'error' && m.taskId === 'init') {
          clearTimeout(timeout);
          this.rejectInit = null;
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

  private stopWorker(error: ToolError): void {
    const worker = this.worker;
    this.worker = null;
    this.ready = false;
    this.initPromise = null;
    this.limitsCache = null;
    worker?.terminate();
    this.rejectInit?.(error);
    this.rejectInit = null;
    for (const pending of this.pending.values()) {
      if (!pending.settled) {
        pending.settled = true;
        pending.reject(error);
      }
    }
    this.pending.clear();
    for (const [id, probe] of this.probes) {
      clearTimeout(probe.timer);
      this.probes.delete(id);
      probe.reject(error);
    }
  }

  private onMessage(m: FromWorker): void {
    switch (m.type) {
      case 'ready':
        this.ready = true;
        this.limitsCache = m.limits;
        this.loadPath = m.loadPath;
        return;
      case 'probed': {
        const entry = this.probes.get(m.taskId);
        if (entry) {
          this.probes.delete(m.taskId);
          clearTimeout(entry.timer);
          entry.resolve(m.meta);
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
        // 探测请求走的是 probes 而不是 pending，必须在这里一并处理，
        // 否则 worker 报的真实错误会被丢弃，只剩一个 15 秒后的「探测超时」。
        const probe = this.probes.get(m.taskId);
        if (probe) {
          this.probes.delete(m.taskId);
          clearTimeout(probe.timer);
          probe.reject(m.error);
          return;
        }
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

    const caps = this.capsCache ??= await this.mergeBrowserCaps();
    const installed = await this.isServiceWorkerActivated();
    return { ...caps, offline: { ...caps.offline, installed } };
  }

  /** 单独探测 SW 是否已激活（与 mergeBrowserCaps 内同一判据） */
  private async isServiceWorkerActivated(): Promise<boolean> {
    if (!('serviceWorker' in navigator)) return false;
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      return reg?.active?.state === 'activated';
    } catch {
      return false;
    }
  }

  async limits(): Promise<Limits> {
    await this.init();
    if (!this.limitsCache) throw new Error('limits 未初始化');
    // 图片处理和取消共用同一个 Worker，只能调度一个运行任务。
    return { ...this.limitsCache, maxConcurrent: 1 };
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
    // 真实编解码器由浏览器/OS 决定，用 isConfigSupported 逐个探测而非 UA 猜（docs/COMPATIBILITY.md）。
    const codecs = await videoCodecSupport();
    const savePicker = typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function';
    const dirPicker = typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
    const sw = 'serviceWorker' in navigator;
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
        engines: videoEncoder && videoDecoder ? ['webcodecs', 'ffmpeg-wasm'] : ['ffmpeg-wasm'],
        decoders: codecs.decoders,
        encoders: codecs.encoders,
        hardwareEncoder: false,
        maxBytes: 200 * 1024 * 1024,
        maxDurationSec: 300,
        inputContainers: ['mp4'],
        outputContainers: ['mp4', 'webm'],
        audioPassthrough: true,
      },
      pdf: { render: true, edit: true, maxPages: 100, maxDpi: 200 },
      office: { wordToPdf: 'structured', pdfToWord: 'structured' },
      cancel: { hard: false },
      fileSystem: { directoryPicker: dirPicker, savePicker },
      offline: { serviceWorker: sw, installed: false },
      env: { userAgentMajor: major, crossOriginIsolated: coi },
    };
  }

  async run(task: TaskPayload, opts: RunOptions): Promise<TaskResult> {
    // 视频转码走浏览器原生 WebCodecs（主线程 + 浏览器内部编解码线程），不经过 wasm worker。
    if (task.kind === 'video.transcode') {
      return getVideoBackend().run(task.input, task.params, opts);
    }

    // PDF 结构操作：委托给专用后端（它内部是 core_doc wasm worker）。
    if (
      task.kind === 'pdf.merge' || task.kind === 'pdf.split' ||
      task.kind === 'pdf.rotate' || task.kind === 'pdf.extract'
    ) {
      return getDocBackend().run(task, opts);
    }

    // 文档结构化：docx2pdf 用 mammoth 读 docx 文本；pdf2docx 用 core_doc 的 PDF 文本抽取。
    // 两者都只产出「结构化中间产物」（JSON 段落），Web 不承诺高保真（UI 常驻声明）。
    if (task.kind === 'office.structure') {
      if (task.direction === 'docx2pdf') {
        return this.structureDocx(task.input, opts);
      }
      return getDocBackend().run(task, opts);
    }

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

    const buf = await task.input.file?.arrayBuffer();
    if (opts.signal.aborted || this.worker !== w) throw cancelled;

    if (!buf?.byteLength) {
      throw {
        code: 'IO',
        message: '无法读取文件内容',
        retryable: false,
        desktopHint: false,
      } satisfies ToolError;
    }

    const onAbort = () => this.cancel(opts.taskId);
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
      try {
        w.postMessage(msg, [buf]);
      } catch (error) {
        this.pending.delete(opts.taskId);
        reject(error);
      }
    }).finally(() => opts.signal.removeEventListener('abort', onAbort));
  }

  cancel(taskId: string): void {
    // 硬取消会终止共享 worker，同时拒绝受其生命周期影响的任务与探测。
    if (this.pending.has(taskId)) this.stopWorker(cancelled);
  }

  /** 探测单张图（不入队） */
  async probe(ref: InputRef): Promise<ImageMeta> {
    await this.init();
    const w = this.worker;
    if (!w) throw new Error('worker 不可用');
    const buf = (await ref.file?.arrayBuffer()) ?? new ArrayBuffer(0);
    if (this.worker !== w) throw cancelled;
    const taskId = `probe-${Math.random().toString(36).slice(2, 10)}`;

    return new Promise<ImageMeta>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.probes.delete(taskId);
        reject(new Error('探测超时'));
      }, 15_000);
      this.probes.set(taskId, { resolve, reject, timer });
      try {
        w.postMessage(
          { v: PROTOCOL_VERSION, type: 'probe', taskId, input: buf, inputName: ref.name } satisfies ToWorker,
          [buf],
        );
      } catch (error) {
        clearTimeout(timer);
        this.probes.delete(taskId);
        reject(error);
      }
    });
  }

  /** docx 结构化（Web 侧 mammoth 在主线程只读文本，输出 JSON 段落；不生成 PDF，不承诺高保真）。
   *  mammoth 走动态 import，不进首屏包。
   */
  private async structureDocx(ref: InputRef, opts: RunOptions): Promise<TaskResult> {
    if (!ref.file) {
      throw { code: 'IO', message: '结构化读取需要浏览器文件对象', retryable: false, desktopHint: false } satisfies ToolError;
    }
    const mammoth = await import('mammoth/mammoth.browser');
    const arrayBuffer = await ref.file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    // 按空行/换行切段，启发式识别标题（与 core::office::structure_text 同规则）
    const paras = result.value
      .split(/\n\s*\n/)
      .flatMap((block) => block.split('\n'))
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((text) => ({
        text,
        headingLevel: text.length < 80 && !/[。，,.；;]$/.test(text) ? 1 : 0,
      }));
    opts.onProgress({ done: 1, total: 1, phase: 'finalizing', unit: 'percent' });
    const bytes = new TextEncoder().encode(JSON.stringify(paras, null, 2));
    return {
      bytes,
      outputName: 'structured.json',
      meta: {
        outFormat: 'pdf',
        outWidth: 0,
        outHeight: 0,
        inputBytes: ref.size,
        outputBytes: bytes.length,
        outputHash: '',
        savingsRatio: 0,
        savingsText: `${paras.length} 个结构化段落（不承诺高保真）`,
      },
    };
  }

  /** 视频探测（Web 侧由 mp4box 解封装，主线程，无字节进 wasm） */
  async probeVideo(ref: InputRef): Promise<VideoProbeResult> {
    if (!ref.file) throw new Error('视频探测需要浏览器文件对象');
    return getVideoBackend().probe(ref);
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
    this.stopWorker({ code: 'CANCELLED', message: '后端已释放', retryable: false, desktopHint: false });
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
