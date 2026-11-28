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
  colorPresetAdjust,
  compressionPresetQuality,
  defaultForm,
  describeParams,
  icoSizeError,
  needsBackgroundNotice,
  normalizeImageSection,
  type ImageFormState,
} from './form';

const ACCEPT = '.jpg,.jpeg,.png,.webp,.gif,.bmp,.tif,.tiff,.qoi,.ico';

export function ImagePage({ section }: { section?: string }) {
  const current = normalizeImageSection(section);
  const showTransform = current === 'all' || current === 'transform';
  const showCompress = current === 'all' || current === 'compress';
  const showFill = current === 'all' || current === 'fill';
  const showColor = current === 'all' || current === 'color';
  const canvasHelpId = useId();
  const canvasErrorId = useId();
  const outputId = useId();
  const icoNoticeId = useId();
  const { caps, limits, status } = useCapabilities();
  const settings = useSettings();
  const availableFormats = caps?.image.formats ?? [];
  const encode = settings.encodeOptions();
  if (availableFormats[0] && !availableFormats.includes(encode.format)) {
    encode.format = availableFormats[0];
  }

  const [selected, setSelected] = useState<InputRef | null>(null);
  const [batch, setBatch] = useState<InputRef[]>([]);
  const [batchIcoErrors, setBatchIcoErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const probeGeneration = useRef(0);
  const [meta, setMeta] = useState<ImageMeta | null>(null);
  const [probeError, setProbeError] = useState<ToolError | null>(null);
  const [limitBlocked, setLimitBlocked] = useState<string | null>(null);
  const [form, setForm] = useState<ImageFormState>(() => defaultForm(settings.filter));
  const [preset, setPreset] = useState<'custom' | 'compact' | 'balanced' | 'quality'>('custom');
  const [colorPreset, setColorPreset] = useState<'original' | 'grayscale' | 'soft' | 'vivid' | 'custom'>('original');

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);

  // 单值选择器（避免 store 整体变化触发无限重渲染）
  const items = useQueue((s) => s.items);
  const enqueue = useQueue((s) => s.enqueue);
  const paused = useQueue((s) => s.paused);
  const invalidCanvas = showFill ? canvasError(form, limits?.maxPixels) : null;

  // 设置里的滤波变化时同步到表单
  useEffect(() => {
    setForm((f) => ({ ...f, filter: settings.filter }));
  }, [settings.filter]);

  useEffect(() => {
    let disposed = false;
    let url: string | undefined;
    setPreviewUrl(null);
    if (selected && !/\.(qoi|tiff?)$/i.test(selected.name)) {
      void (async () => {
        try {
          const bytes = selected.file ?? await (await getBackend()).readImagePreview?.(selected);
          if (!bytes || disposed) return;
          url = URL.createObjectURL(bytes instanceof Blob ? bytes : new Blob([bytes]));
          setPreviewUrl(url);
        } catch {
          // Metadata and processing remain available if the preview cannot be read.
        }
      })();
    }
    return () => {
      disposed = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [selected]);

  const probe = useCallback(
    async (ref: InputRef) => {
      const generation = ++probeGeneration.current;
      setProbeError(null);
      setLimitBlocked(null);
      setMeta(null);
      try {
        const backend = await getBackend();
        if (!backend.probe) return;
        const m = (await backend.probe(ref)) as ImageMeta;
        if (generation !== probeGeneration.current) return;
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
        if (generation === probeGeneration.current) setProbeError(e as ToolError);
      }
    },
    [limits],
  );

  const adoptFiles = useCallback(
    async (refs: InputRef[]) => {
      if (refs.length === 0) return;
      const first = refs[0]!;
      setSelected(first);
      setBatch(refs);
      await probe(first);
    },
    [probe],
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

  const applyColorPreset = useCallback((next: typeof colorPreset) => {
    setColorPreset(next);
    if (next === 'custom') return;
    const adjust = colorPresetAdjust(next);
    setForm((f) => ({ ...f, adjust: adjust ?? { brightness: 1, contrast: 1, saturation: 1 } }));
  }, []);

  const params = buildParams(form, meta, current);
  const icoError = icoSizeError(meta, params, encode.format);
  useEffect(() => setBatchIcoErrors([]), [batch, form, current, encode.format]);

  const exceedsBatchLimit = !!limits && limits.maxBatch > 0 && batch.length > limits.maxBatch;
  const canSubmit = status === 'ready' && availableFormats.length > 0 && !invalidCanvas && !exceedsBatchLimit;

  async function runBatch() {
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setBatchIcoErrors([]);
    try {
      const needsDimensions = encode.format === 'ico' || (showTransform && (form.cropEnabled || form.scalePercent !== 100));
      const backend = needsDimensions ? await getBackend() : undefined;
      const prepared = [];
      const errors: string[] = [];
      for (const ref of batch) {
        let refMeta = ref === selected ? meta : null;
        if (!refMeta && backend?.probe) {
          try {
            refMeta = (await backend.probe(ref)) as ImageMeta;
          } catch {
            // The queue records this file’s processing error independently.
          }
        }
        const refParams = buildParams(form, refMeta, current);
        const error = icoSizeError(refMeta, refParams, encode.format);
        if (error) errors.push(`${ref.name}：${error}`);
        else prepared.push({ ref, params: refParams });
      }
      setBatchIcoErrors(errors);
      for (const { ref, params } of prepared) enqueue(ref, params, encode);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  function runSingle() {
    if (!selected || !meta || limitBlocked || icoError || !canSubmit) return;
    enqueue(selected, buildParams(form, meta, current), encode);
  }

  const latest = [...items].reverse().find((i) => i.status === 'succeeded' && i.task.kind === 'image.process' && i.task.input === selected)?.result;
  useEffect(() => {
    setResultUrl(null);
    if (latest?.bytes.length && latest.meta.outFormat !== 'qoi' && latest.meta.outFormat !== 'tiff') {
      const blob = new Blob([latest.bytes.slice().buffer as ArrayBuffer], {
        type: latest.meta.outFormat === 'ico' ? 'image/x-icon' : `image/${latest.meta.outFormat}`,
      });
      const url = URL.createObjectURL(blob);
      setResultUrl(url);
      return () => URL.revokeObjectURL(url);
    }
  }, [latest]);

  const batchBytes = batch.reduce((sum, ref) => sum + ref.size, 0);
  const batchBytesKnown = batch.every((ref) => ref.size > 0);
  const active = items.filter((i) => i.task.kind === 'image.process' && (i.status === 'running' || i.status === 'queued'));
  const finished = items.filter(
    (i) => i.task.kind === 'image.process' && (i.status === 'succeeded' || i.status === 'failed' || i.status === 'cancelled'),
  );

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card">
        <h2>导入</h2>
        {batch.length > 1 && (
          <p className="hint" role="status">
            已选 {batch.length} 张图片{batchBytesKnown ? `，共 ${formatBytes(batchBytes)}` : ''}；调整下方参数后可统一批量处理。
          </p>
        )}
        {exceedsBatchLimit && <p role="alert">单批最多处理 {limits?.maxBatch} 张图片，请分批导入。</p>}
        <DropZone accept={ACCEPT} onFiles={handleFiles}
          onNativeFiles={caps?.fileSystem.nativeFilePicker ? adoptFiles : undefined} onPick={handlePick} />
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
            <PreviewCompare before={previewUrl} after={resultUrl} />
            <p className="source-filename">{selected.name}</p>
            {(meta?.format === 'qoi' || encode.format === 'qoi') && <p className="hint">此处无法预览 QOI，处理后的文件可在任务列表下载。</p>}
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
          if (batch.length > 1) void runBatch();
          else runSingle();
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
            <div className="row" style={{ gap: 12, marginBottom: 12 }}>
              <label className="col" style={{ gap: 4 }}>
                <span className="hint">预设</span>
                <select
                  value={encode.format === 'jpeg' ? preset : 'custom'}
                  disabled={encode.format !== 'jpeg'}
                  onChange={(e) => {
                    const next = e.target.value as typeof preset;
                    setPreset(next);
                    if (next !== 'custom') settings.setQuality(compressionPresetQuality[next]);
                  }}
                >
                  <option value="custom">自定义</option>
                  <option value="compact">体积优先</option>
                  <option value="balanced">均衡</option>
                  <option value="quality">质量优先</option>
                </select>
              </label>
              <span className="hint" style={{ alignSelf: 'end' }}>预设适用于 JPEG。</span>
            </div>
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
                  onChange={(e) => {
                    setPreset('custom');
                    settings.setQuality(Number(e.target.value));
                  }}
                />
              </label>
            </div>
            <p className="hint">JPEG 质量可调；WebP 编码器为无损模式。在输出中比较格式和体积。</p>
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
            <div className="row" style={{ gap: 12, marginBottom: 12 }}>
              <label className="col" style={{ gap: 4 }}>
                <span className="hint">滤镜预设</span>
                <select value={colorPreset} onChange={(e) => applyColorPreset(e.target.value as typeof colorPreset)}>
                  <option value="original">原始</option>
                  <option value="grayscale">黑白</option>
                  <option value="soft">柔和</option>
                  <option value="vivid">鲜明</option>
                  <option value="custom" disabled>自定义</option>
                </select>
              </label>
            </div>
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
                    onChange={(e) => {
                      setColorPreset('custom');
                      setForm((f) => ({
                        ...f,
                        adjust: { ...f.adjust, [key]: Number(e.target.value) },
                      }));
                    }}
                  />
                </label>
              ))}
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <button
                type="button"
                className="ghost"
                onClick={() => applyColorPreset('original')}
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
                value={encode.format}
                onChange={(e) => {
                  setPreset('custom');
                  settings.setFormat(e.target.value as EncodeOptions['format']);
                }}
              >
                {availableFormats.map((f) => (
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

          {encode.format === 'ico' && (
            <div id={icoNoticeId} role="status">
              {batch.length <= 1 && icoError
                ? <p className="notice danger">{icoError}</p>
                : <p className="hint">ICO 输出宽和高均不能超过 256 像素。批量处理会跳过超限图片。</p>}
              {batchIcoErrors.length > 0 && (
                <div className="notice danger">
                  <p>以下 {batchIcoErrors.length} 张图片未提交：</p>
                  <ul>{batchIcoErrors.map((message, index) => <li key={index}>{message}</li>)}</ul>
                </div>
              )}
            </div>
          )}
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
              type="button"
              disabled={!selected || !canSubmit || submitting || (batch.length <= 1 && (!meta || !!limitBlocked || !!icoError))}
              aria-describedby={encode.format === 'ico' ? icoNoticeId : undefined}
              onClick={() => void (batch.length > 1 ? runBatch() : runSingle())}
            >
              {submitting ? '正在准备批量任务…' : batch.length > 1 ? `批量处理 ${batch.length} 张` : '开始处理'}
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
        onClear={() => useQueue.getState().clearFinished('image.process')}
      />
    </div>
  );
}
