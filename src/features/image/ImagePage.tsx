import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { DropZone } from '../../components/DropZone';
import { ErrorBanner } from '../../components/ErrorBanner';
import { DesktopCta, LimitNotice } from '../../components/LimitNotice';
import { getBackend } from '../../lib/backend';
import { formatBytes } from '../../lib/errors';
import type {
  EncodeOptions,
  ImageMeta,
  InputRef,
  ToolError,
} from '../../lib/backend/types';
import { useCapabilities } from '../../store/capabilities';
import { useQueue } from '../../store/queue';
import { useSettings } from '../../store/settings';
import { QueuePanel } from '../../components/QueuePanel';
import { PreviewCompare } from './PreviewCompare';
import {
  buildParams,
  canvasError,
  defaultForm,
  describeParams,
  needsBackgroundNotice,
  normalizeImageSection,
  type ImageFormState,
} from './form';

const ACCEPT = '.jpg,.jpeg,.png,.webp,.gif,.bmp,.tif,.tiff';

export function ImagePage({ section }: { section?: string }) {
  const current = normalizeImageSection(section);
  const showTransform = current === 'all' || current === 'transform';
  const showCompress = current === 'all' || current === 'compress';
  const showFill = current === 'all' || current === 'fill';
  const showColor = current === 'all' || current === 'color';
  const canvasHelpId = useId();
  const canvasErrorId = useId();
  const outputId = useId();
  const { limits, status } = useCapabilities();
  const settings = useSettings();

  const [selected, setSelected] = useState<InputRef | null>(null);
  const [meta, setMeta] = useState<ImageMeta | null>(null);
  const [probeError, setProbeError] = useState<ToolError | null>(null);
  const [limitBlocked, setLimitBlocked] = useState<string | null>(null);
  const [form, setForm] = useState<ImageFormState>(() => defaultForm(settings.filter));

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewRef = useRef<string | null>(null);
  const [result, setResult] = useState<{ url: string; bytes: number } | null>(null);
  const resultRef = useRef<string | null>(null);

  // 单值选择器（避免 store 整体变化触发无限重渲染）
  const items = useQueue((s) => s.items);
  const setConcurrency = useQueue((s) => s.setConcurrency);
  const enqueue = useQueue((s) => s.enqueue);
  const paused = useQueue((s) => s.paused);
  const invalidCanvas = showFill ? canvasError(form, limits?.maxPixels) : null;

  useEffect(() => {
    if (limits) setConcurrency(Math.min(limits.maxConcurrent, 2));
  }, [limits, setConcurrency]);

  // 设置里的滤波变化时同步到表单
  useEffect(() => {
    setForm((f) => ({ ...f, filter: settings.filter }));
  }, [settings.filter]);

  // 清理 object URL
  useEffect(() => {
    return () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      if (resultRef.current) URL.revokeObjectURL(resultRef.current);
    };
  }, []);

  const probe = useCallback(
    async (ref: InputRef) => {
      setProbeError(null);
      setLimitBlocked(null);
      setMeta(null);
      try {
        const backend = await getBackend();
        if (!backend.probe) return;
        const m = (await backend.probe(ref)) as ImageMeta;
        setMeta(m);
        if (limits) {
          if (m.width * m.height > limits.maxPixels) {
            setLimitBlocked(
              `这张图是 ${m.width}×${m.height}（${((m.width * m.height) / 1e6).toFixed(1)} MP），超过在线版 ${(limits.maxPixels / 1e6).toFixed(0)} MP 上限。`,
            );
          } else if (m.bytes > limits.maxBytes) {
            setLimitBlocked(
              `文件 ${formatBytes(m.bytes)}，超过在线版 ${formatBytes(limits.maxBytes)} 上限。`,
            );
          }
        }
      } catch (e) {
        setProbeError(e as ToolError);
      }
    },
    [limits],
  );

  const adoptFiles = useCallback(
    async (refs: InputRef[]) => {
      if (refs.length === 0) return;
      const first = refs[0]!;
      if (first.file) {
        if (previewRef.current) URL.revokeObjectURL(previewRef.current);
        const url = URL.createObjectURL(first.file);
        previewRef.current = url;
        setPreviewUrl(url);
      }
      setSelected(first);
      setResult(null);
      await probe(first);
      if (refs.length > 1 && !invalidCanvas) {
        const backend = await getBackend();
        const encode = settings.encodeOptions();
        for (const ref of refs) {
          let refMeta: ImageMeta | null = null;
          if (showTransform && (form.cropEnabled || form.scalePercent !== 100)) {
            try {
              refMeta = (await backend.probe?.(ref) as ImageMeta | undefined) ?? null;
            } catch {
              // The queue reports the backend error for this individual file.
            }
          }
          enqueue(ref, buildParams(form, refMeta, current), encode);
        }
      }
    },
    [probe, form, settings, enqueue, current, invalidCanvas, showTransform],
  );

  const handleFiles = useCallback(
    async (files: File[]) => {
      await adoptFiles(files.map((f) => ({ file: f, name: f.name, size: f.size })));
    },
    [adoptFiles],
  );

  const handlePick = useCallback(async () => {
    const backend = await getBackend();
    await adoptFiles(await backend.pickFiles(ACCEPT, true));
  }, [adoptFiles]);

  const runSingle = useCallback(() => {
    if (!selected || limitBlocked || invalidCanvas || status !== 'ready') return;
    enqueue(selected, buildParams(form, meta, current), settings.encodeOptions());
  }, [selected, form, meta, current, settings, enqueue, limitBlocked, invalidCanvas, status]);

  // 取最新成功结果用于对比预览
  useEffect(() => {
    const latest = [...items].reverse().find((i) => i.status === 'succeeded');
    if (latest?.outputBytes && latest.result) {
      if (resultRef.current) URL.revokeObjectURL(resultRef.current);
      const blob = new Blob([latest.outputBytes.slice().buffer as ArrayBuffer], {
        type: `image/${latest.result.outFormat}`,
      });
      const url = URL.createObjectURL(blob);
      resultRef.current = url;
      setResult({ url, bytes: latest.outputBytes.length });
    }
  }, [items]);

  const encode = settings.encodeOptions();
  const params = buildParams(form, meta, current);
  const active = items.filter((i) => i.status === 'running' || i.status === 'queued');
  const finished = items.filter(
    (i) => i.status === 'succeeded' || i.status === 'failed' || i.status === 'cancelled',
  );

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card">
        <h2>导入</h2>
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
            <h2>源文件</h2>
            <PreviewCompare before={previewUrl} after={result?.url ?? null} />
            <p className="source-filename">{selected.name}</p>
            {meta && (
              <dl className="source-details">
                <div>
                  <dt>尺寸</dt>
                  <dd className="mono">
                    {meta.width} × {meta.height}（{((meta.width * meta.height) / 1e6).toFixed(2)} MP）
                  </dd>
                </div>
                <div>
                  <dt>格式</dt>
                  <dd className="mono">{meta.format.toUpperCase()}</dd>
                </div>
                <div>
                  <dt>大小</dt>
                  <dd className="mono">{formatBytes(meta.bytes)}</dd>
                </div>
                <div>
                  <dt>透明通道</dt>
                  <dd>{meta.hasAlpha ? '有' : '无'}</dd>
                </div>
                <div>
                  <dt>EXIF 方向</dt>
                  <dd className="mono">{meta.exifOrientation}</dd>
                </div>
                <div>
                  <dt>预计峰值内存</dt>
                  <dd className="mono">{formatBytes(meta.peakMemoryEstimate)}</dd>
                </div>
              </dl>
            )}
            {!meta && !probeError && <span className="hint">读取中…</span>}
            {probeError && (
              <div style={{ marginTop: 12 }}>
                <ErrorBanner error={probeError} />
              </div>
            )}
            {limitBlocked && (
              <div style={{ marginTop: 12 }}>
                <DesktopCta reason={limitBlocked} />
              </div>
            )}
          </div>
      )}

      <form
        className="col"
        style={{ gap: 16 }}
        aria-labelledby={outputId}
        onSubmit={(event) => {
          event.preventDefault();
          runSingle();
        }}
      >
        <p className="hint">
          {current === 'all'
            ? '一次应用全部已设参数：裁剪 → 旋转和翻转 → 缩放 → 色彩 → 画布填充 → 编码。'
            : '本页参数与输出设置用于本次处理。打开「组合」可一次应用各组参数。'}
        </p>
        {showTransform && (
          <fieldset className="card" style={{ minInlineSize: 0 }}>
            <legend>变换</legend>
            <div className="row" style={{ gap: 18 }}>
              <label className="col" style={{ gap: 4 }}>
                <span className="hint">旋转</span>
                <select
                  value={form.rotate}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, rotate: e.target.value as typeof f.rotate }))
                  }
                >
                  <option value="none">不旋转</option>
                  <option value="cw90">顺时针 90°</option>
                  <option value="cw180">180°</option>
                  <option value="cw270">逆时针 90°</option>
                </select>
              </label>

              <label className="col" style={{ gap: 4 }}>
                <span className="hint">翻转</span>
                <select
                  value={form.flip}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, flip: e.target.value as typeof f.flip }))
                  }
                >
                  <option value="none">不翻转</option>
                  <option value="h">水平</option>
                  <option value="v">垂直</option>
                  <option value="both">水平+垂直</option>
                </select>
              </label>

            </div>

            <div className="row" style={{ marginTop: 14, gap: 18 }}>
              <label className="col grow" style={{ gap: 4 }}>
                <span className="hint">
                  缩放 <span className="mono">{form.scalePercent}%</span>
                </span>
                <input
                  type="range"
                  min={10}
                  max={100}
                  step={5}
                  value={form.scalePercent}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, scalePercent: Number(e.target.value) }))
                  }
                />
              </label>
              <label className="col" style={{ gap: 4 }}>
                <span className="hint">重采样滤波</span>
                <select
                  value={form.filter}
                  onChange={(e) => {
                    const v = e.target.value as typeof form.filter;
                    settings.setFilter(v);
                    setForm((f) => ({ ...f, filter: v }));
                  }}
                >
                  <option value="lanczos3">Lanczos3（锐利）</option>
                  <option value="catmull_rom">Catmull-Rom</option>
                  <option value="gaussian">高斯（柔和）</option>
                  <option value="triangle">线性（快）</option>
                  <option value="nearest">最近邻（像素风）</option>
                </select>
              </label>
            </div>

            <div className="row" style={{ marginTop: 14 }}>
              <label className="row" style={{ gap: 6 }}>
                <input
                  type="checkbox"
                  checked={form.cropEnabled}
                  onChange={(e) => setForm((f) => ({ ...f, cropEnabled: e.target.checked }))}
                />
                <span className="hint">启用裁剪（按百分比框选）</span>
              </label>
            </div>
            {form.cropEnabled && (
              <div className="col" style={{ marginTop: 10, gap: 8 }}>
                {(['x', 'y', 'w', 'h'] as const).map((key) => (
                  <label className="row" key={key} style={{ gap: 10 }}>
                    <span className="hint mono" style={{ width: 16 }}>
                      {key}
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={form.cropPct[key]}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          cropPct: { ...f.cropPct, [key]: Number(e.target.value) },
                        }))
                      }
                    />
                    <span className="mono" style={{ width: 40, textAlign: 'right' }}>
                      {form.cropPct[key]}%
                    </span>
                  </label>
                ))}
                <span className="hint">
                  裁剪区域以自动调整方向后的原图为准。
                </span>
              </div>
            )}
          </fieldset>
        )}
        {showCompress && (
          <fieldset className="card" style={{ minInlineSize: 0 }}>
            <legend>压缩</legend>
            <div className="row">
              <label className="col grow" style={{ gap: 4 }}>
                <span className="hint">
                  质量 <span className="mono">{settings.quality}</span>
                </span>
                <input
                  type="range"
                  disabled={encode.format !== 'jpeg'}
                  min={10}
                  max={100}
                  value={settings.quality}
                  onChange={(e) => settings.setQuality(Number(e.target.value))}
                />
              </label>
            </div>
            <p className="hint">质量滑块适用于 JPEG。在输出中选择格式以比较处理后的大小。</p>
          </fieldset>
        )}
        {showFill && (
          <fieldset className="card" style={{ minInlineSize: 0 }}>
            <legend>填充</legend>
            <label className="row" style={{ gap: 6 }}>
              <input
                type="checkbox"
                checked={form.canvasEnabled}
                onChange={(e) => setForm((f) => ({ ...f, canvasEnabled: e.target.checked }))}
              />
              <span>扩展画布</span>
            </label>
            <p className="hint" id={canvasHelpId}>
              图片居中摆放，保持处理后的像素尺寸。画布的宽和高至少要与图片相同。
            </p>
            {form.canvasEnabled && (
              <div className="row" style={{ gap: 14 }}>
                {(['canvasWidth', 'canvasHeight'] as const).map((dimension) => (
                  <label className="col" key={dimension} style={{ gap: 4 }}>
                    <span className="hint">{dimension === 'canvasWidth' ? '画布宽度 (px)' : '画布高度 (px)'}</span>
                    <input
                      type="number"
                      min={1}
                      max={0xffffffff}
                      step={1}
                      required
                      style={{ width: 100 }}
                      aria-invalid={!!invalidCanvas}
                      aria-describedby={`${canvasHelpId}${invalidCanvas ? ` ${canvasErrorId}` : ''}`}
                      value={form[dimension]}
                      onChange={(e) => setForm((f) => ({ ...f, [dimension]: e.target.value }))}
                    />
                  </label>
                ))}
                <label className="col" style={{ gap: 4 }}>
                  <span className="hint">画布颜色</span>
                  <input
                    type="color"
                    value={form.canvasColor}
                    disabled={form.canvasTransparent}
                    onChange={(e) => setForm((f) => ({ ...f, canvasColor: e.target.value }))}
                  />
                </label>
                <label className="row" style={{ gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={form.canvasTransparent}
                    onChange={(e) => setForm((f) => ({ ...f, canvasTransparent: e.target.checked }))}
                  />
                  <span>透明画布</span>
                </label>
              </div>
            )}
            {invalidCanvas && <p className="hint" id={canvasErrorId} role="status">{invalidCanvas}</p>}
          </fieldset>
        )}
        {showColor && (
          <fieldset className="card" style={{ minInlineSize: 0 }}>
            <legend>色彩</legend>
            <div className="row" style={{ gap: 18 }}>
              {(
                [
                  ['brightness', '亮度'],
                  ['contrast', '对比度'],
                  ['saturation', '饱和度'],
                ] as const
              ).map(([key, label]) => (
                <label className="col grow" key={key} style={{ gap: 4 }}>
                  <span className="hint">
                    {label} <span className="mono">{form.adjust[key].toFixed(2)}</span>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={4}
                    step={0.05}
                    value={form.adjust[key]}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        adjust: { ...f.adjust, [key]: Number(e.target.value) },
                      }))
                    }
                  />
                </label>
              ))}
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <button
                type="button"
                className="ghost"
                onClick={() =>
                  setForm((f) => ({ ...f, adjust: { brightness: 1, contrast: 1, saturation: 1 } }))
                }
              >
                重置色彩
              </button>
              <span className="hint">1.00 表示不变</span>
            </div>
          </fieldset>
        )}

        <div className="card">
          <h2 id={outputId}>输出</h2>
          <div className="row" style={{ gap: 18 }}>
            <label className="col" style={{ gap: 4 }}>
              <span className="hint" id="image-format-label">格式</span>
              <select
                aria-labelledby="image-format-label"
                value={settings.format}
                onChange={(e) => settings.setFormat(e.target.value as EncodeOptions['format'])}
              >
                {['jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff'].map((f) => (
                  <option key={f} value={f}>
                    {f.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>

            <label className="row" style={{ gap: 6 }}>
              <input
                type="checkbox"
                checked={settings.keepMetadata}
                onChange={(e) => settings.setKeepMetadata(e.target.checked)}
              />
              <span className="hint">保留元数据（默认剥离 EXIF/GPS）</span>
            </label>
          </div>

          {needsBackgroundNotice(meta, encode, params.canvas) && (
            <div style={{ marginTop: 12 }}>
              <LimitNotice kind="fidelity" title="透明图将转为不透明">
                {encode.format.toUpperCase()} 不支持 alpha。将用下方背景色填充透明区域。
              </LimitNotice>
            </div>
          )}
          {(encode.format === 'jpeg' || encode.format === 'bmp') && (
            <div className="row" style={{ marginTop: 12, gap: 14 }}>
              <span className="hint">背景填充</span>
              {(['r', 'g', 'b'] as const).map((c) => (
                <label className="row" key={c} style={{ gap: 6 }}>
                  <span className="mono hint">{c.toUpperCase()}</span>
                  <input
                    type="number"
                    min={0}
                    max={255}
                    value={form.background[c]}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        background: {
                          ...f.background,
                          [c]: Math.max(0, Math.min(255, Number(e.target.value))),
                        },
                      }))
                    }
                    style={{ width: 64 }}
                  />
                </label>
              ))}
            </div>
          )}

          <div className="row" style={{ marginTop: 16 }}>
            <button
              className="primary"
              type="submit"
              disabled={!selected || !!limitBlocked || !!invalidCanvas || status !== 'ready'}
            >
              开始处理
            </button>
            <span className="hint mono">{describeParams(params)}</span>
          </div>
        </div>
      </form>

      <QueuePanel
        active={active}
        finished={finished}
        paused={paused}
        onPause={() => {
          const q = useQueue.getState();
          q.setPaused(!q.paused);
        }}
        onClear={() => useQueue.getState().clearFinished()}
      />
    </div>
  );
}
