// PDF 页面虚拟化预览：按页渲染、只把视口附近的页放进 DOM、canvas 位图按 LRU 回收。
// 渲染全部在 getPdfRenderBackend()（主线程 pdf.js + 自带解析 Worker）完成；
// 这里只负责「何时请求哪一页」以及把 ImageBitmap 画到 <canvas> 上。

import { useCallback, useEffect, useRef, useState } from 'react';
import { getBackend } from '../../lib/backend';
import { getPdfRenderBackend, PdfRenderBackend } from '../../lib/backend/web/pdfRenderBackend';
import { submitTask } from '../../store/queue';
import { useCapabilities } from '../../store/capabilities';
import type { InputRef, PageRange, ToolError } from '../../lib/backend/types';

interface PdfPreviewProps {
  file: File;
  pageCount: number;
  batch?: InputRef[];
  reorder?: { order: number[]; setOrder: (order: number[]) => void; disabled: boolean };
  onError: (error: ToolError) => void;
}

const LOCAL_MAX_BITMAPS = 12;

function parseRanges(text: string, pageCount: number): PageRange[] {
  if (!text.trim()) return [{ from: 1, toInclusive: pageCount }];
  const ranges: PageRange[] = [];
  for (const part of text.split(',')) {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part.trim());
    if (!match) return [];
    const from = Number(match[1]);
    const toInclusive = Number(match[2] ?? match[1]);
    if (from < 1 || toInclusive < from || !Number.isSafeInteger(toInclusive)) return [];
    ranges.push({ from, toInclusive });
  }
  return ranges;
}

export function PdfPreview({ file, pageCount, onError, reorder, batch }: PdfPreviewProps) {
  // 阈值来自 capabilities，不在渲染层/UI 硬编码（规格 D10）。
  const { caps } = useCapabilities();
  const maxPages = caps?.pdf.maxPages ?? 100;
  const maxDpi = caps?.pdf.maxDpi ?? 200;
  const dpiOptions = [72, 120, 150, 200, 300, 400].filter((d) => d <= maxDpi);
  const [dpi, setDpi] = useState(120);
  const [format, setFormat] = useState<'png' | 'jpeg' | 'webp'>('png');
  const [quality, setQuality] = useState(0.9);
  const [rangeText, setRangeText] = useState(`1-${Math.min(pageCount, 3)}`);
  const [longImage, setLongImage] = useState(false);
  const [visible, setVisible] = useState<Set<number>>(() => new Set([1, 2, 3].filter((p) => p <= pageCount)));
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const draggedPage = useRef<number | null>(null);
  function movePage(from: number, to: number) {
    if (!reorder || reorder.disabled || from === to || from < 0 || to < 0 || to >= reorder.order.length) return;
    const next = [...reorder.order];
    const [page] = next.splice(from, 1);
    next.splice(to, 0, page!);
    reorder.setOrder(next);
  }

  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRefs = useRef(new Map<number, HTMLCanvasElement>());
  const bitmaps = useRef(new Map<number, ImageBitmap>());
  const acRef = useRef<AbortController | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // 换文件或换 DPI：位图尺寸语义变了，全部作废
  useEffect(() => {
    bitmaps.current.clear();
    getPdfRenderBackend().clearCache();
  }, [file, dpi]);

  useEffect(() => () => {
    acRef.current?.abort();
    bitmaps.current.clear();
  }, []);

  const draw = useCallback((n: number) => {
    const canvas = canvasRefs.current.get(n);
    const bmp = bitmaps.current.get(n);
    if (!canvas || !bmp) return;
    if (canvas.width !== bmp.width) canvas.width = bmp.width;
    if (canvas.height !== bmp.height) canvas.height = bmp.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0);
  }, []);

  const setCanvasRef = useCallback((n: number) => (el: HTMLCanvasElement | null) => {
    if (!el) {
      canvasRefs.current.delete(n);
      return;
    }
    canvasRefs.current.set(n, el);
    draw(n);
  }, [draw]);

  // 虚拟化：只有进入（含 300px 预取区）的页才渲染，离开的页从任务集合移除
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          const next = new Set(prev);
          for (const entry of entries) {
            const n = Number((entry.target as HTMLElement).dataset.page);
            if (!Number.isFinite(n)) continue;
            if (entry.isIntersecting) next.add(n);
            else next.delete(n);
          }
          return next;
        });
      },
      { root, rootMargin: '300px 0px', threshold: 0 },
    );
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-page]'))) io.observe(el);
    return () => io.disconnect();
  }, [pageCount]);

  // 按可见集合逐页渲染；缓存命中直接画，未命中才调用后端
  useEffect(() => {
    const ac = new AbortController();
    acRef.current = ac;
    void (async () => {
      for (const n of Array.from(visible).sort((a, b) => a - b)) {
        if (ac.signal.aborted) return;
        if (bitmaps.current.has(n)) {
          draw(n);
          continue;
        }
        try {
          const r = await getPdfRenderBackend().renderPreviewPage(file, n, dpi, ac.signal);
          if (ac.signal.aborted) {
            r.bitmap.close();
            return;
          }
          bitmaps.current.set(n, r.bitmap);
          // 本地 LRU 上限：超出的位图关掉，下次滚动到再按需渲染
          while (bitmaps.current.size > LOCAL_MAX_BITMAPS) {
            const oldest = bitmaps.current.keys().next().value as number | undefined;
            if (oldest === undefined) break;
            bitmaps.current.get(oldest)?.close();
            bitmaps.current.delete(oldest);
            const canvas = canvasRefs.current.get(oldest);
            if (canvas) {
              const ctx = canvas.getContext('2d');
              ctx?.clearRect(0, 0, canvas.width, canvas.height);
            }
          }
          draw(n);
        } catch (e) {
          if (!ac.signal.aborted) onErrorRef.current(e as ToolError);
        }
      }
    })();
    return () => ac.abort();
  }, [visible, dpi, file, draw]);

  const exportImages = useCallback(async () => {
    const ranges = parseRanges(rangeText, pageCount);
    if (!ranges.length) {
      onErrorRef.current({ code: 'INVALID_PARAMS', message: '请填写有效的页码范围', retryable: false, desktopHint: false });
      return;
    }
    setBusy(true);
    setProgress(null);
    setNotice(null);
    try {
      const backend = await getBackend();
      const sources = batch ?? [{ file, name: file.name, size: file.size }];
      const outcomes = await Promise.allSettled(sources.map(async (input, index) => {
        const out = await submitTask({
          kind: 'pdf.render', input,
          params: { dpi, pages: rangeText.trim() ? ranges : [], format, quality, background: '#ffffff', longImage },
        }, batch ? undefined : { onProgress: ({ done, total }) => setProgress({ done, total }) }, async (payload, options) => {
          if (payload.kind !== 'pdf.render') throw new Error('Expected PDF render task');
          const source = payload.input.file ?? (backend.readPdf
            ? new File([await backend.readPdf(payload.input)], payload.input.name, { type: 'application/pdf' })
            : undefined);
          if (!source) throw new Error('无法读取 PDF');
          // Each queued export owns its document/cache, independent of preview and other jobs.
          const renderer = new PdfRenderBackend();
          let result;
          try {
            result = await renderer.render(source, payload.params, options, options.signal, maxPages);
          } finally {
            renderer.dispose();
          }
          if (!batch) return result;
          const stem = input.name.replace(/\.pdf$/i, '');
          const nameOutput = (name: string) => `${stem}-${index + 1}-${name}`;
          return { ...result, outputName: nameOutput(result.outputName), outputs: result.outputs?.map((output) => ({
            ...output, name: nameOutput(output.name),
          })) };
        });
        const outputs = out.outputs?.length ? out.outputs : [{ bytes: out.bytes, name: out.outputName }];
        let saved = 0;
        for (const item of outputs) {
          if (await backend.saveOutput(item.bytes, item.name, { directDownload: true }) !== 'cancelled') saved++;
        }
        return { saved, total: outputs.length };
      }));
      const failures = outcomes.flatMap((outcome, index) => outcome.status === 'rejected'
        ? [`${sources[index]?.name}：${outcome.reason?.message ?? String(outcome.reason)}`] : []);
      if (!batch && outcomes[0]?.status === 'rejected') throw outcomes[0].reason;
      const totals = outcomes.reduce((sum, outcome) => outcome.status === 'fulfilled'
        ? { saved: sum.saved + outcome.value.saved, total: sum.total + outcome.value.total } : sum, { saved: 0, total: 0 });
      setNotice(`已导出 ${totals.saved} / ${totals.total} 张图片${failures.length ? `。${failures.join('；')}` : ''}`);
    } catch (e) {
      onErrorRef.current(e as ToolError);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }, [file, pageCount, dpi, format, quality, rangeText, longImage, batch, maxPages]);

  const pageNumbers = reorder?.order ?? Array.from({ length: pageCount }, (_, i) => i + 1);

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2>{reorder ? '拖动缩略图调整顺序' : '页面预览与图片导出'}</h2>
      {!reorder && <>
      <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
        <label className="row" style={{ gap: 8 }}>
          <span className="hint">DPI</span>
          <select value={dpi} onChange={(e) => setDpi(Number(e.target.value))} disabled={busy}>
            {dpiOptions.map((d) => (
              <option key={d} value={d}>{d}{d === 120 ? '（默认）' : d >= 300 ? '（高，慢）' : ''}</option>
            ))}
          </select>
        </label>
        <label className="row" style={{ gap: 8 }}>
          <span className="hint">格式</span>
          <select value={format} onChange={(e) => setFormat(e.target.value as typeof format)} disabled={busy}>
            <option value="png">PNG（无损）</option>
            <option value="jpeg">JPEG</option>
            <option value="webp">WebP</option>
          </select>
        </label>
        {format !== 'png' && (
          <label className="row" style={{ gap: 8 }}>
            <span className="hint">质量</span>
            <input type="range" min={0.5} max={1} step={0.05} value={quality} onChange={(e) => setQuality(Number(e.target.value))} disabled={busy} />
            <span className="mono">{quality.toFixed(2)}</span>
          </label>
        )}
        <label className="row" style={{ gap: 8 }}>
          <span className="hint">导出范围</span>
          <input type="text" value={rangeText} placeholder="留空导出全部" onChange={(e) => setRangeText(e.target.value)} style={{ width: 140 }} disabled={busy} />
        </label>
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={longImage} onChange={(e) => setLongImage(e.target.checked)} disabled={busy} />
          <span className="hint">拼成长图</span>
        </label>
      </div>

      <div className="row" style={{ marginTop: 12, gap: 10 }}>
        <button className="primary" onClick={() => void exportImages()} disabled={busy}>
          {busy ? (progress ? `导出中 ${progress.done}/${progress.total}…` : '导出中…') : batch ? `批量导出 ${batch.length} 份 PDF` : '导出为图片'}
        </button>
        <span className="hint">仅渲染视口附近的页；导出范围{maxPages > 0 ? `最多 ${maxPages} 页` : '不限页数'}</span>
      </div>
      {notice && <div className="notice info" style={{ marginTop: 10 }}><span>✓</span><div>{notice}</div></div>}

      </>}
      <div
        aria-label={reorder ? '页面顺序' : undefined}
        ref={rootRef}
        style={{
          marginTop: 14,
          maxHeight: 620,
          overflowY: 'auto',
          border: '1px solid var(--line)',
          background: '#0a1014',
          padding: 12,
          display: reorder ? 'grid' : 'flex',
          gridTemplateColumns: reorder ? 'repeat(auto-fit, minmax(140px, 1fr))' : undefined,
          flexDirection: 'column',
          alignItems: 'center',
          gap: 12,
        }}
      >
        {pageNumbers.map((n, index) => (
          <div
            key={n}
            data-page={n}
            draggable={!!reorder && !reorder.disabled}
            onDragStart={reorder ? (event) => {
              draggedPage.current = n;
              event.dataTransfer.setData('text/plain', String(n));
              event.dataTransfer.effectAllowed = 'move';
            } : undefined}
            onDragEnd={reorder ? () => { draggedPage.current = null; } : undefined}
            onDragOver={reorder ? (event) => { if (draggedPage.current !== null) event.preventDefault(); } : undefined}
            onDrop={reorder ? (event) => {
              if (draggedPage.current === null) return;
              event.preventDefault();
              movePage(pageNumbers.indexOf(draggedPage.current), index);
              draggedPage.current = null;
            } : undefined}
            style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}
          >
            <span className="hint mono" style={{ fontSize: 11 }}>{reorder ? `第 ${index + 1} 项 · 原第 ${n} 页` : `PAGE ${String(n).padStart(3, '0')}`}</span>
            {reorder && <div className="row" style={{ gap: 4 }}>
              <button type="button" disabled={reorder.disabled || index === 0}
                aria-label={`前移原第 ${n} 页`} onClick={() => movePage(index, index - 1)}>前移</button>
              <button type="button" disabled={reorder.disabled || index === pageNumbers.length - 1}
                aria-label={`后移原第 ${n} 页`} onClick={() => movePage(index, index + 1)}>后移</button>
            </div>}
            <canvas
              ref={setCanvasRef(n)}
              style={{
                maxWidth: '100%',
                height: 'auto',
                background: '#fff',
                border: '1px solid var(--line)',
                aspectRatio: 'auto',
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
