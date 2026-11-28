// PDF→图片渲染后端（主线程执行 pdf.js）。
//
// 关键架构决策（由真实 Chromium 原型验证，不要改成「专用 Worker 内跑 pdf.js」）：
//   1. pdf.js 6.x 的 ESM 构建强制要求 GlobalWorkerOptions.workerSrc，getDocument 会在
//      调用方上下文里再 new Worker(pdf.worker.min.mjs, {type:'module'})。在专用 Worker
//      内派生嵌套 Worker 后，握手消息无法被内部 MessageHandler 消费，task.promise 永久挂起。
//   2. pdf.js 的 worker 侧渲染（rendererSrc）依赖 globalThis.document.fonts —— 专用 Worker
//      里没有 document，这条路也不通。
//   3. 默认 DOMCanvasFactory 同样依赖 document。
// 因此：pdf.min.mjs 在主线程**动态 import**（独立懒加载 chunk），解析交给 pdf.js 自带的
// pdf.worker.min.mjs（本来就不阻塞主线程），逐页渲染到 OffscreenCanvas，页间主动 yield，
// 只有可见页才进入 DOM（由 PdfPreview 的 IntersectionObserver 负责）。
//
// 这不是「把渲染塞回主线程假装没事」：每页渲染只有几十毫秒，页间 await setTimeout(0)
// 让 UI 有机会响应；解析这一重活仍在 pdf.js 自己的 Worker 里。

import type { PageRange, PdfRenderParams, RunOptions, TaskResult, ToolError } from '../types';

// pdf.js 只在编译期提供类型；运行时通过 BASE_URL 拼出的同源 URL 动态 import，
// 不进 Vite 模块图（路径必须是 /pdfjs/pdf.min.mjs，见 scripts/copy-pdfjs.mjs）。
interface PdfPageLike {
  getViewport(opts: { scale: number }): { width: number; height: number };
  render(opts: {
    canvasContext: OffscreenCanvasRenderingContext2D;
    viewport: { width: number; height: number };
    background: string;
  }): { promise: Promise<void>; cancel(): void };
  cleanup(): void;
}

interface PdfDocLike {
  numPages: number;
  getPage(n: number): Promise<PdfPageLike>;
  loadingTask: { destroy(): Promise<void> };
}

interface PdfJsLike {
  GlobalWorkerOptions: {
    workerSrc: string;
    standardFontDataUrl: string;
  };
  getDocument(src: { data: Uint8Array; useSystemFonts: boolean }): { promise: Promise<PdfDocLike> };
}

export interface PreviewPage {
  page: number;
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

const MAX_PREVIEW_BITMAPS = 8;
const CANVAS_POOL_MAX = 4;
const MAX_PAGE_PIXELS = 20_000_000; // 与 Web 图片阈值一致
const MAX_LONG_IMAGE_PIXELS = 40_000_000;

function cancelled(): ToolError {
  return { code: 'CANCELLED', message: '已取消', retryable: false, desktopHint: false };
}

function toToolError(e: unknown, signal?: AbortSignal): ToolError {
  if (signal?.aborted) return cancelled();
  const detail = e instanceof Error ? e.message : String(e);
  if (/password|encrypted/i.test(detail)) {
    return {
      code: 'DECODE_FAILED',
      message: 'PDF 已加密，在线版无法渲染',
      detail,
      retryable: false,
      desktopHint: true,
    };
  }
  if (/invalid page|out of range/i.test(detail)) {
    return { code: 'INVALID_PARAMS', message: '页码超出范围', detail, retryable: false, desktopHint: false };
  }
  return {
    code: 'DECODE_FAILED',
    message: 'PDF 渲染失败',
    detail,
    retryable: false,
    desktopHint: true,
  };
}

function baseUrl(): string {
  const base = import.meta.env.BASE_URL || '/';
  return base.endsWith('/') ? base : `${base}/`;
}

/** FNV-1a，仅用于结果元信息里给个稳定摘要，不用于安全用途 */
function shortHash(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 按像素上限压缩缩放系数，避免高 DPI 大页把 wasm/浏览器内存打爆 */
function safeScale(w: number, h: number, wanted: number, cap: number): number {
  if (!(w > 0) || !(h > 0)) return wanted;
  const max = Math.sqrt(cap / (w * h));
  return Math.max(0.05, Math.min(wanted, max));
}

function sleep0(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

export class PdfRenderBackend {
  private libPromise: Promise<PdfJsLike> | null = null;
  private doc: PdfDocLike | null = null;
  private docKey = '';
  private cache = new Map<string, ImageBitmap>();
  private pool: OffscreenCanvas[] = [];

  private loadLib(): Promise<PdfJsLike> {
    if (this.libPromise) return this.libPromise;
    const url = `${baseUrl()}pdfjs/pdf.min.mjs`;
    this.libPromise = import(/* @vite-ignore */ url)
      .then((mod) => {
        const lib = mod as unknown as PdfJsLike;
        lib.GlobalWorkerOptions.workerSrc = `${baseUrl()}pdfjs/pdf.worker.min.mjs`;
        lib.GlobalWorkerOptions.standardFontDataUrl = `${baseUrl()}pdfjs/standard_fonts/`;
        return lib;
      })
      .catch((e) => {
        this.libPromise = null;
        throw toToolError(e);
      });
    return this.libPromise;
  }

  private fileKey(file: File): string {
    return `${file.name}|${file.size}|${file.lastModified}`;
  }

  private async open(file: File): Promise<PdfDocLike> {
    const key = this.fileKey(file);
    if (this.doc && this.docKey === key) return this.doc;
    this.closeDoc();
    const lib = await this.loadLib();
    const data = new Uint8Array(await file.arrayBuffer());
    let task;
    try {
      task = lib.getDocument({ data, useSystemFonts: true });
      this.doc = await task.promise;
      this.docKey = key;
      return this.doc;
    } catch (e) {
      throw toToolError(e);
    }
  }

  private closeDoc(): void {
    this.clearCache();
    const old = this.doc;
    this.doc = null;
    this.docKey = '';
    if (old) void old.loadingTask.destroy().catch(() => {});
  }

  /** 清空预览位图缓存（切换 DPI 或文件时需要） */
  clearCache(): void {
    for (const bmp of this.cache.values()) bmp.close();
    this.cache.clear();
  }

  private takeCanvas(w: number, h: number): OffscreenCanvas {
    const canvas = this.pool.pop() ?? new OffscreenCanvas(1, 1);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return canvas;
  }

  private putCanvas(canvas: OffscreenCanvas): void {
    if (this.pool.length < CANVAS_POOL_MAX) {
      this.pool.push(canvas);
    } else {
      // 主动释放底层像素缓冲
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  private cachePut(key: string, bmp: ImageBitmap): void {
    this.cache.delete(key);
    this.cache.set(key, bmp);
    while (this.cache.size > MAX_PREVIEW_BITMAPS) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cache.get(oldest)?.close();
      this.cache.delete(oldest);
    }
  }

  private async renderOne(
    doc: PdfDocLike,
    pageNumber: number,
    dpi: number,
    signal?: AbortSignal,
  ): Promise<{ bitmap: ImageBitmap; width: number; height: number }> {
    if (signal?.aborted) throw cancelled();
    const page = await doc.getPage(pageNumber);
    try {
      const base = page.getViewport({ scale: 1 });
      const scale = safeScale(base.width, base.height, dpi / 72, MAX_PAGE_PIXELS);
      const viewport = page.getViewport({ scale });
      const w = Math.max(1, Math.round(viewport.width));
      const h = Math.max(1, Math.round(viewport.height));
      // 每次 pdf.js render 必须用全新 canvas：pdf.js 用静态 WeakSet 跟踪「正在渲染的 canvas」，
      // 被 cancel 的 render 会在下一帧才从 WeakSet 移除；此时把 canvas 放回池里会被下一次
      // render 取到，触发 "Cannot use the same canvas during multiple render() operations"。
      // 专用 canvas 在 transferToImageBitmap() 后即可 GC，不进池。
      const canvas = new OffscreenCanvas(w, h);
      let bitmap: ImageBitmap | null = null;
      try {
        const ctx = canvas.getContext('2d', { alpha: false }) as OffscreenCanvasRenderingContext2D | null;
        if (!ctx) throw new Error('无法获取 OffscreenCanvas 2D 上下文');
        const task = page.render({ canvasContext: ctx, viewport, background: '#ffffff' });
        const onAbort = () => task.cancel();
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
          await task.promise;
        } finally {
          signal?.removeEventListener('abort', onAbort);
        }
        if (signal?.aborted) throw cancelled();
        bitmap = typeof canvas.transferToImageBitmap === 'function'
          ? canvas.transferToImageBitmap()
          : await createImageBitmap(canvas);
        return { bitmap, width: bitmap.width, height: bitmap.height };
      } catch (e) {
        throw toToolError(e, signal);
      } finally {
        // canvas 不回池（见上方注释）
      }
    } finally {
      page.cleanup();
    }
  }

  /** 供虚拟化预览按需取单页（带 LRU 缓存） */
  async renderPreviewPage(file: File, pageNumber: number, dpi: number, signal?: AbortSignal): Promise<PreviewPage> {
    const key = `${this.fileKey(file)}|${pageNumber}|${dpi}`;
    const hit = this.cache.get(key);
    if (hit) return { page: pageNumber, bitmap: hit, width: hit.width, height: hit.height };
    const doc = await this.open(file);
    const rendered = await this.renderOne(doc, pageNumber, dpi, signal);
    this.cachePut(key, rendered.bitmap);
    return { page: pageNumber, ...rendered };
  }

  private resolvePages(doc: PdfDocLike, ranges: PageRange[]): number[] {
    const all = Array.from({ length: doc.numPages }, (_, i) => i + 1);
    if (!ranges.length) return all;
    const wanted = new Set<number>();
    for (const r of ranges) {
      const from = Math.max(1, Math.min(doc.numPages, r.from));
      const to = Math.max(from, Math.min(doc.numPages, r.toInclusive));
      for (let p = from; p <= to; p++) wanted.add(p);
    }
    return all.filter((p) => wanted.has(p));
  }

  private async bitmapToBytes(bmp: ImageBitmap, format: PdfRenderParams['format'], quality: number): Promise<Uint8Array> {
    const canvas = this.takeCanvas(bmp.width, bmp.height);
    try {
      const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null;
      if (!ctx) throw new Error('无法获取 OffscreenCanvas 2D 上下文');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bmp, 0, 0);
      const mime = format === 'png' ? 'image/png' : format === 'jpeg' ? 'image/jpeg' : 'image/webp';
      let blob: Blob;
      try {
        blob = await canvas.convertToBlob({ type: mime, quality });
      } catch {
        // Safari 对 webp 编码支持不完整 → 明确降级为 png，不让整个任务失败
        blob = await canvas.convertToBlob({ type: 'image/png' });
      }
      return new Uint8Array((await blob.arrayBuffer()) as ArrayBuffer);
    } finally {
      this.putCanvas(canvas);
    }
  }

  /** 渲染并导出。多页时 outputs 里逐页返回；longImage 时合成一张长图。 */
  async render(
    file: File,
    params: PdfRenderParams,
    opts: RunOptions,
    signal?: AbortSignal,
    /** 页数上限来自 capabilities().pdf.maxPages（-1 表示不限）；不再在渲染层硬编码。 */
    maxPages = 100,
  ): Promise<TaskResult> {
    if (signal?.aborted) throw cancelled();
    const doc = await this.open(file);
    const pages = this.resolvePages(doc, params.pages);
    if (!pages.length) throw { code: 'INVALID_PARAMS', message: '页码范围内没有页面', retryable: false, desktopHint: false } satisfies ToolError;
    if (maxPages > 0 && pages.length > maxPages) {
      throw {
        code: 'PAGE_LIMIT',
        message: `当前形态单次最多渲染 ${maxPages} 页，请缩小页码范围`,
        retryable: false,
        desktopHint: true,
      } satisfies ToolError;
    }

    let bytes: Uint8Array = new Uint8Array(0);
    let outName = '';
    let outWidth = 0;
    let outHeight = 0;
    const outputs: Array<{ name: string; bytes: Uint8Array }> = [];

    if (params.longImage && pages.length > 1) {
      // 先把每页渲染成位图并记下尺寸（受 LRU 限制，边渲染边合成）
      const rendered: Array<{ p: number; bmp: ImageBitmap; w: number; h: number }> = [];
      try {
        for (let i = 0; i < pages.length; i++) {
          if (signal?.aborted) throw cancelled();
          opts.onProgress?.({ done: i, total: pages.length, phase: 'decoding', unit: 'pages' });
          const r = await this.renderOne(doc, pages[i]!, params.dpi, signal);
          rendered.push({ p: pages[i]!, bmp: r.bitmap, w: r.width, h: r.height });
          if (i % 2 === 1) await sleep0();
        }
        const gap = 8;
        const totalH = rendered.reduce((s, r) => s + r.h, 0) + gap * (rendered.length - 1);
        const totalW = Math.max(...rendered.map((r) => r.w));
        const scale = Math.sqrt(MAX_LONG_IMAGE_PIXELS / Math.max(1, totalW * totalH));
        const cw = Math.max(1, Math.round(totalW * Math.min(1, scale)));
        const ch = Math.max(1, Math.round(totalH * Math.min(1, scale)));
        const composite = new OffscreenCanvas(cw, ch);
        const ctx = composite.getContext('2d', { alpha: false }) as OffscreenCanvasRenderingContext2D | null;
        if (!ctx) throw new Error('无法创建长图画布');
        ctx.fillStyle = params.background || '#ffffff';
        ctx.fillRect(0, 0, cw, ch);
        let y = 0;
        for (const r of rendered) {
          const ph = Math.round(r.h * Math.min(1, scale));
          const pw = Math.round(r.w * Math.min(1, scale));
          ctx.drawImage(r.bmp, 0, y, pw, ph);
          y += ph + Math.max(1, Math.round(gap * Math.min(1, scale)));
          await sleep0();
        }
        const mime = params.format === 'png' ? 'image/png' : params.format === 'jpeg' ? 'image/jpeg' : 'image/webp';
        try {
          const longBuf = await composite.convertToBlob({ type: mime, quality: params.quality }).then((b) => b.arrayBuffer());
          bytes = new Uint8Array(longBuf as ArrayBuffer);
        } catch {
          const longBuf2 = await composite.convertToBlob({ type: 'image/png' }).then((b) => b.arrayBuffer());
          bytes = new Uint8Array(longBuf2 as ArrayBuffer);
        }
        outWidth = cw;
        outHeight = ch;
        outName = `pages-${pages[0]}-${pages[pages.length - 1]}-long.${params.format === 'jpeg' ? 'jpg' : params.format}`;
      } finally {
        for (const r of rendered) r.bmp.close();
      }
    } else {
      for (let i = 0; i < pages.length; i++) {
        if (signal?.aborted) throw cancelled();
        opts.onProgress?.({ done: i, total: pages.length, phase: 'decoding', unit: 'pages' });
        const r = await this.renderOne(doc, pages[i]!, params.dpi, signal);
        try {
          const b = await this.bitmapToBytes(r.bitmap, params.format, params.quality);
          const ext = params.format === 'jpeg' ? 'jpg' : params.format;
          outputs.push({
            name: `page-${String(pages[i]!).padStart(3, '0')}.${ext}`,
            bytes: b,
          });
          if (i === 0) {
            outWidth = r.width;
            outHeight = r.height;
            bytes = b;
            outName = outputs[0]!.name;
          }
        } finally {
          r.bitmap.close();
        }
        if (i % 2 === 1) await sleep0();
      }
    }

    opts.onProgress?.({ done: pages.length, total: pages.length, phase: 'finalizing', unit: 'pages' });
    return {
      bytes,
      outputs: outputs.length > 1 ? outputs : undefined,
      outputName: outName,
      meta: {
        outFormat: params.format === 'jpeg' ? 'jpeg' : params.format,
        outWidth,
        outHeight,
        inputBytes: file.size,
        outputBytes: outputs.length ? outputs.reduce((s, o) => s + o.bytes.length, 0) : bytes.length,
        outputHash: shortHash(bytes),
        savingsRatio: 0,
        savingsText: 'PDF 渲染为图片',
      },
    };
  }

  dispose(): void {
    this.clearCache();
    this.closeDoc();
    for (const c of this.pool) {
      c.width = 0;
      c.height = 0;
    }
    this.pool = [];
  }
}

let singleton: PdfRenderBackend | null = null;
export function getPdfRenderBackend(): PdfRenderBackend {
  if (!singleton) singleton = new PdfRenderBackend();
  return singleton;
}
