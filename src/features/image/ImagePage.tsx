import { useCallback, useEffect, useRef, useState } from 'react';
import { DropZone } from '../../components/DropZone';
import { ErrorBanner } from '../../components/ErrorBanner';
import { DesktopCta, LimitNotice } from '../../components/LimitNotice';
import { ProgressBar } from '../../components/ProgressBar';
import { getBackend } from '../../lib/backend';
import { formatBytes } from '../../lib/errors';
import type {
  EncodeOptions,
  ImageMeta,
  ImageParams,
  Filter,
  InputRef,
  ToolError,
} from '../../lib/backend/types';
import { useCapabilities } from '../../store/capabilities';
import { useQueue, type QueueItem } from '../../store/queue';
import { useSettings } from '../../store/settings';

const ACCEPT = '.jpg,.jpeg,.png,.webp,.gif,.bmp,.tif,.tiff';

export function ImagePage() {
  const { caps, limits, status } = useCapabilities();
  const settings = useSettings();
  // 只订阅需要的字段（zustand 的浅比较），避免整个 store 变化触发重渲染循环
  const paused = useQueue((s) => s.paused);
  const items = useQueue((s) => s.items);
  const setPaused = useQueue((s) => s.setPaused);
  const clearFinished = useQueue((s) => s.clearFinished);
  const runningCountFn = useQueue((s) => s.runningCount);

  const [selected, setSelected] = useState<InputRef | null>(null);
  const [meta, setMeta] = useState<ImageMeta | null>(null);
  const [probeError, setProbeError] = useState<ToolError | null>(null);
  const [limitBlocked, setLimitBlocked] = useState<string | null>(null);
  const [scalePercent, setScalePercent] = useState(100);

  // 注意：这里用「单值选择器」而不是 `useQueue()` 整个对象。
  // 整个对象每次 setState 都是新引用，放进 useEffect 依赖会无限循环（React #185）。
  const setConcurrency = useQueue((s) => s.setConcurrency);
  const enqueue = useQueue((s) => s.enqueue);
  const enqueueMany = useQueue((s) => s.enqueueMany);
  const previewUrl = useRef<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  // 队列的并发度跟随能力探测结果
  useEffect(() => {
    if (limits) setConcurrency(limits.maxConcurrent);
  }, [limits, setConcurrency]);

  const probe = useCallback(async (ref: InputRef) => {
    setProbeError(null);
    setLimitBlocked(null);
    setMeta(null);
    try {
      const backend = await getBackend();
      if (backend.probe) {
        const m = await backend.probe(ref);
        setMeta(m);
        // 阈值前置判定：这里就能知道会不会超限，不用等到跑起来
        if (limits) {
          if (m.width * m.height > limits.maxPixels) {
            setLimitBlocked(
              `这张图是 ${m.width}×${m.height}（${((m.width * m.height) / 1e6).toFixed(1)} MP），超过在线版 ${(limits.maxPixels / 1e6).toFixed(0)} MP 上限。`,
            );
          } else if (m.bytes > limits.maxBytes) {
            setLimitBlocked(`文件 ${formatBytes(m.bytes)}，超过在线版 ${formatBytes(limits.maxBytes)} 上限。`);
          }
        }
      }
    } catch (e) {
      setProbeError(e as ToolError);
    }
  }, [limits]);

  const handleFiles = useCallback(
    async (files: File[]) => {
      const refs: InputRef[] = files.map((f) => ({ file: f, name: f.name, size: f.size }));
      if (refs.length === 0) return;

      // 预览第一张
      const first = refs[0]!;
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
      if (first.file) {
        const url = URL.createObjectURL(first.file);
        previewUrl.current = url;
        setPreview(url);
      }
      setSelected(first);
      await probe(first);

      // 批量：一次全部入队（超限的会在 start 时被 core 拒绝，UI 显示对应错误）
      if (refs.length > 1) {
        const params = buildParams(settings.filter, scalePercent, null);
        enqueueMany(refs, params, settings.encodeOptions());
      }
    },
    [probe, enqueueMany, settings, scalePercent],
  );

  const handlePick = useCallback(async () => {
    const backend = await getBackend();
    const refs = await backend.pickFiles(ACCEPT, true);
    if (refs.length === 0) return;
    const first = refs[0]!;
    if (first.file) {
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
      const url = URL.createObjectURL(first.file);
      previewUrl.current = url;
      setPreview(url);
    }
    setSelected(first);
    await probe(first);
    if (refs.length > 1) {
      const params = buildParams(settings.filter, scalePercent, null);
      enqueueMany(refs, params, settings.encodeOptions());
    }
  }, [probe, enqueueMany, settings, scalePercent]);

  const runSingle = useCallback(() => {
    if (!selected) return;
    const params = buildParams(settings.filter, scalePercent, meta);
    enqueue(selected, params, settings.encodeOptions());
  }, [selected, enqueue, settings, scalePercent, meta]);

  const active = items.filter((i) => i.status === 'running' || i.status === 'queued');
  const finished = items.filter(
    (i) => i.status === 'succeeded' || i.status === 'failed' || i.status === 'cancelled',
  );

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card">
        <h2>图片压缩与转换</h2>
        <DropZone accept={ACCEPT} onFiles={handleFiles} onPick={handlePick} />
      </div>

      {status === 'failed' && (
        <LimitNotice kind="capability" title="核心模块未加载">
          当前只能查看页面，无法处理文件。请刷新重试；若在本地打开，请确认用的是{' '}
          <code>npm run preview</code> 或已为 <code>.wasm</code> 配置 MIME 的静态服务器。
        </LimitNotice>
      )}

      {selected && (
        <div className="card">
          <div className="row" style={{ alignItems: 'flex-start', gap: 18 }}>
            {preview && (
              <img
                src={preview}
                alt="待处理图片预览"
                style={{
                  width: 180,
                  height: 180,
                  objectFit: 'contain',
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                }}
              />
            )}
            <div className="grow col" style={{ gap: 6 }}>
              <strong style={{ wordBreak: 'break-all' }}>{selected.name}</strong>
              {meta && (
                <dl className="kv">
                  <dt>尺寸</dt>
                  <dd className="mono">
                    {meta.width} × {meta.height}（{((meta.width * meta.height) / 1e6).toFixed(2)} MP）
                  </dd>
                  <dt>格式</dt>
                  <dd className="mono">{meta.format.toUpperCase()}</dd>
                  <dt>大小</dt>
                  <dd className="mono">{formatBytes(meta.bytes)}</dd>
                  <dt>透明通道</dt>
                  <dd>{meta.hasAlpha ? '有' : '无'}</dd>
                  <dt>EXIF 方向</dt>
                  <dd className="mono">{meta.exifOrientation}</dd>
                  <dt>预计峰值内存</dt>
                  <dd className="mono">{formatBytes(meta.peakMemoryEstimate)}</dd>
                </dl>
              )}
              {!meta && !probeError && <span className="hint">读取中…</span>}
            </div>
          </div>

          {probeError && <div style={{ marginTop: 12 }}><ErrorBanner error={probeError} /></div>}

          {limitBlocked && (
            <div style={{ marginTop: 12 }}>
              <DesktopCta reason={limitBlocked} />
            </div>
          )}
        </div>
      )}

      {caps && (
        <div className="card">
          <h2>输出参数</h2>
          <div className="row" style={{ gap: 18 }}>
            <label className="col" style={{ gap: 4 }}>
              <span className="hint">格式</span>
              <select
                value={settings.format}
                onChange={(e) => settings.setFormat(e.target.value as EncodeOptions['format'])}
              >
                {(caps.image.formats as string[]).map((f) => (
                  <option key={f} value={f}>
                    {f.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>

            <label className="col grow" style={{ gap: 4 }}>
              <span className="hint">
                质量 <span className="mono">{settings.quality}</span>
              </span>
              <input
                type="range"
                min={10}
                max={100}
                value={settings.quality}
                onChange={(e) => settings.setQuality(Number(e.target.value))}
              />
            </label>

            <label className="col" style={{ gap: 4 }}>
              <span className="hint">
                缩放 <span className="mono">{scalePercent}%</span>
              </span>
              <input
                type="range"
                min={10}
                max={100}
                step={5}
                value={scalePercent}
                onChange={(e) => setScalePercent(Number(e.target.value))}
                style={{ width: 120 }}
              />
            </label>

            <label className="col" style={{ gap: 4 }}>
              <span className="hint">缩放滤波</span>
              <select
                value={settings.filter}
                onChange={(e) => settings.setFilter(e.target.value as typeof settings.filter)}
              >
                <option value="lanczos3">Lanczos3（默认，锐利）</option>
                <option value="catmull_rom">Catmull-Rom</option>
                <option value="gaussian">高斯（柔和）</option>
                <option value="triangle">线性（快）</option>
                <option value="nearest">最近邻（像素风）</option>
              </select>
            </label>
          </div>

          <div className="row" style={{ marginTop: 12 }}>
            <label className="row" style={{ gap: 6 }}>
              <input
                type="checkbox"
                checked={settings.keepMetadata}
                onChange={(e) => settings.setKeepMetadata(e.target.checked)}
              />
              <span className="hint">保留元数据（默认剥离 EXIF/GPS）</span>
            </label>
          </div>

          <div className="row" style={{ marginTop: 16 }}>
            <button
              className="primary"
              onClick={runSingle}
              disabled={!selected || !!limitBlocked || status !== 'ready'}
            >
              开始处理
            </button>
            <button onClick={() => setPaused(!paused)} disabled={active.length === 0}>
              {paused ? '继续队列' : '暂停队列'}
            </button>
            <button onClick={() => clearFinished()} disabled={finished.length === 0}>
              清除已完成
            </button>
            <span className="grow" />
            {active.length > 0 && (
              <span className="hint">
                {runningCountFn()} 个进行中 / {active.length} 个待处理
              </span>
            )}
          </div>

          {caps.image.parallel === 1 && (
            <div style={{ marginTop: 12 }}>
              <LimitNotice kind="capability" title="单线程处理">
                GitHub Pages 无法设置 COOP/COEP 响应头，因此没有 SharedArrayBuffer，wasm
                只能单线程。桌面版会用 rayon 并行处理。
              </LimitNotice>
            </div>
          )}
        </div>
      )}

      {active.length > 0 && (
        <div className="card">
          <h2>处理中</h2>
          {active.map((item) => (
            <TaskRow key={item.id} item={item} />
          ))}
        </div>
      )}

      {finished.length > 0 && (
        <div className="card">
          <h2>已完成</h2>
          {finished.map((item) => (
            <TaskRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

/** 由设置生成参数。scalePercent === 100 时不缩放（保留原始尺寸）。 */
function buildParams(filter: Filter, scalePercent: number, meta: ImageMeta | null): ImageParams {
  const resize =
    meta && scalePercent > 0 && scalePercent !== 100
      ? {
          width: Math.max(1, Math.round((meta.width * scalePercent) / 100)),
          height: null,
          mode: 'fit' as const,
          filter,
          allowUpscale: false,
        }
      : null;

  return {
    resize,
    crop: null,
    rotate: 'none',
    flip: 'none',
    adjust: null,
    applyExifOrientation: true,
    background: { r: 255, g: 255, b: 255, a: 255 },
  };
}

function TaskRow({ item }: { item: QueueItem }) {
  // 单值选择器：同上，避免每次渲染都拿到新对象
  const retry = useQueue((s) => s.retry);
  const remove = useQueue((s) => s.remove);
  const cancel = useQueue((s) => s.cancel);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ToolError | null>(null);

  const save = useCallback(async () => {
    if (!item.outputBytes || !item.outputName) return;
    setSaving(true);
    setSaveError(null);
    try {
      const backend = await getBackend();
      await backend.saveOutput(item.outputBytes, item.outputName);
    } catch (e) {
      setSaveError(e as ToolError);
    } finally {
      setSaving(false);
    }
  }, [item]);

  const statusLabel: Record<QueueItem['status'], string> = {
    queued: '排队中',
    running: '处理中',
    succeeded: '完成',
    failed: '失败',
    cancelled: '已取消',
    removed: '已移除',
  };

  return (
    <div className={`task ${item.status}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span style={{ wordBreak: 'break-all' }}>{item.input.name}</span>
        <span className="hint">{statusLabel[item.status]}</span>
      </div>

      {item.status === 'running' && (
        <div style={{ marginTop: 8 }}>
          <ProgressBar progress={item.progress} />
        </div>
      )}

      {item.status === 'succeeded' && item.result && (
        <div className="row" style={{ marginTop: 8, gap: 14 }}>
          <span className="hint mono">{formatBytes(item.result.inputBytes)}</span>
          <span className="hint">→</span>
          <span className="ok-text mono">{formatBytes(item.result.outputBytes)}</span>
          <span className="hint">{item.result.savingsText}</span>
          <span className="grow" />
          <button onClick={save} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      )}

      {(item.status === 'failed' || item.status === 'cancelled') && (
        <div className="row" style={{ marginTop: 8 }}>
          {item.error && (
            <span className="err-text" style={{ flex: 1 }}>
              {item.error.message}
            </span>
          )}
          <button
            onClick={() => void retry(item.id)}
            disabled={item.attempt >= 3}
          >
            {item.attempt >= 3 ? '已达重试上限' : `重试${item.attempt > 0 ? ` (${item.attempt}/3)` : ''}`}
          </button>
          <button onClick={() => remove(item.id)} className="hint">
            移除
          </button>
        </div>
      )}

      {item.status === 'queued' && (
        <div className="row" style={{ marginTop: 8 }}>
          <button onClick={() => cancel(item.id)}>取消</button>
        </div>
      )}

      {saveError && <div style={{ marginTop: 8 }}><ErrorBanner error={saveError} onDismiss={() => setSaveError(null)} /></div>}
    </div>
  );
}
