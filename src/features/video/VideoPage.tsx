import { useCallback, useRef, useState } from 'react';
import { DropZone } from '../../components/DropZone';
import { ErrorBanner } from '../../components/ErrorBanner';
import { DesktopCta, LimitNotice } from '../../components/LimitNotice';
import { getBackend } from '../../lib/backend';
import { submitTask, useQueue } from '../../store/queue';
import { DESKTOP_RELEASE_URL, formatBytes } from '../../lib/errors';
import type { InputRef, TaskPayload, ToolError, VideoProbeResult } from '../../lib/backend/types';
import { useCapabilities } from '../../store/capabilities';
import { buildParams, defaultForm, describeParams, formatDuration, type VideoFormState } from './videoForm';

const BROWSER_INPUT = '.mp4';
const LOCAL_INPUT = '.mp4,.mov,.mkv,.webm,.avi,.m4v,.mpeg,.mpg,.ts,.wmv';

export function VideoPage() {
  const { caps, summary } = useCapabilities();
  const browserGuidance = summary?.showBrowserGuidance;
  const nativePicker = caps?.fileSystem.nativeFilePicker;
  const accept = nativePicker ? LOCAL_INPUT : BROWSER_INPUT;
  const [file, setFile] = useState<InputRef | null>(null);
  const [probe, setProbe] = useState<VideoProbeResult | null>(null);
  const [form, setForm] = useState<VideoFormState>(() => defaultForm());
  const [error, setError] = useState<ToolError | null>(null);
  const [busy, setBusy] = useState(false);
  const [submittedTask, setSubmittedTask] = useState<TaskPayload | null>(null);
  const item = useQueue((state) => state.items.find((entry) => entry.task === submittedTask));
  const paused = useQueue((state) => state.paused);
  const setPaused = useQueue((state) => state.setPaused);
  const queued = item?.status === 'queued';
  const running = item?.status === 'running';
  const progress = item?.progress;
  const [result, setResult] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  const loadInput = useCallback(async (ref: InputRef) => {
    setError(null);
    setProbe(null);
    setResult(null);
    setFile(ref);
    setBusy(true);
    try {
      const backend = await getBackend();
      if (!backend.probeVideo) throw new Error('当前形态不支持视频探测');
      setProbe(await backend.probeVideo(ref));
    } catch (e) {
      setError(e as ToolError);
    } finally {
      setBusy(false);
    }
  }, []);

  const onFiles = (files: File[]) => {
    const f = files[0];
    if (f) void loadInput({ file: f, name: f.name, size: f.size });
  };

  const pick = useCallback(async () => {
    const backend = await getBackend();
    const refs = await backend.pickFiles(accept, false);
    if (refs[0]) await loadInput(refs[0]);
  }, [accept, loadInput]);

  const run = useCallback(async () => {
    if (!file || busy) return;
    setError(null);
    setResult(null);
    setBusy(true);
    const ac = new AbortController();
    controller.current = ac;
    const task: TaskPayload = { kind: 'video.transcode', input: file, params: buildParams(form) };
    setSubmittedTask(task);
    try {
      const out = await submitTask(task, { signal: ac.signal });
      const backend = await getBackend();
      await backend.saveOutput(out.bytes, out.outputName);
      setResult(`已生成 ${out.outputName}（${out.bytes.length > 0 ? `${formatBytes(out.bytes.length)}，` : ''}${out.meta.savingsText}）`);
    } catch (e) {
      setError(e as ToolError);
    } finally {
      controller.current = null;
      setSubmittedTask(null);
      setBusy(false);
    }
  }, [file, busy, form]);

  const cancel = useCallback(() => {
    controller.current?.abort();
  }, []);

  const videoMaxBytes = caps?.video.maxBytes ?? -1;
  const videoMaxDuration = caps?.video.maxDurationSec ?? -1;
  const durationBlocked = probe && videoMaxDuration >= 0 && probe.durationSec > videoMaxDuration;
  const sizeBlocked = file && videoMaxBytes >= 0 && file.size > videoMaxBytes;

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card">
        <h2>{browserGuidance ? '导入视频（MP4 / H.264）' : '导入视频'}</h2>
        {browserGuidance && <p className="hint">使用浏览器原生 WebCodecs 转码，支持输出 MP4（H.264）或 WebM（VP9）。</p>}
        <DropZone
          accept={accept}
          multiple={false}
          onFiles={onFiles}
          onNativeFiles={nativePicker ? ([ref]) => { if (ref) void loadInput(ref); } : undefined}
          onPick={pick}
          disabled={busy || !summary}
        />
      </div>

      <div className="card">
        <h2>探测到的编解码器</h2>
        <dl className="kv" style={{ marginTop: 10 }}>
          <dt>转码引擎</dt>
          <dd>{caps ? (caps.video.available ? (browserGuidance ? 'WebCodecs' : 'FFmpeg') : (browserGuidance ? 'WebCodecs 不可用' : '未检测到 FFmpeg')) : '探测中…'}</dd>
          <dt>支持解码</dt>
          <dd className="mono">{(caps?.video.decoders ?? []).join(', ') || '—'}</dd>
          <dt>支持编码</dt>
          <dd className="mono">{(caps?.video.encoders ?? []).join(', ') || '—'}</dd>
          <dt>硬件编码</dt>
          <dd>{caps ? (caps.video.hardwareEncoder ? '可用' : '不可用') : '—'}</dd>
          {videoMaxBytes >= 0 && <><dt>文件大小上限</dt><dd className="mono">{formatBytes(videoMaxBytes)}</dd></>}
          {videoMaxDuration >= 0 && <><dt>时长上限</dt><dd className="mono">{Math.round(videoMaxDuration / 60)} 分钟</dd></>}
        </dl>
      </div>

      {file && (
        <div className="card">
          <h2>源文件</h2>
          <div className="row" style={{ marginTop: 6 }}>
            <strong style={{ wordBreak: 'break-all' }}>{file.name}</strong>
          </div>
          {probe && (
            <dl className="kv" style={{ marginTop: 10 }}>
              <dt>编码</dt><dd className="mono">{probe.codec}</dd>
              <dt>尺寸</dt><dd className="mono">{probe.width} × {probe.height}</dd>
              <dt>时长</dt><dd className="mono">{formatDuration(probe.durationSec)}</dd>
              <dt>帧率</dt><dd className="mono">{probe.frameRate || '—'} fps</dd>
              <dt>音轨</dt>
              <dd>
                {probe.hasAudio
                  ? `${probe.audioCodec ?? '有音轨'}${browserGuidance ? (probe.audioPassthrough ? '（可无损透传）' : '（无法透传）') : ''}`
                  : '无'}
              </dd>
            </dl>
          )}
          {browserGuidance && sizeBlocked && (
            <div style={{ marginTop: 12 }}>
              <DesktopCta reason={`文件 ${formatBytes(file.size)}，超过在线版 ${formatBytes(videoMaxBytes)} 上限。`} />
            </div>
          )}
          {browserGuidance && durationBlocked && (
            <div style={{ marginTop: 12 }}>
              <DesktopCta reason={`视频 ${formatDuration(probe.durationSec)}，超过在线版 ${formatDuration(videoMaxDuration)} 上限。`} />
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h2>转码参数</h2>
        <div className="form-grid" style={{ marginTop: 10 }}>
          <label>
            输出容器
            <select value={form.container} onChange={(e) => setForm((f) => ({ ...f, container: e.target.value as 'mp4' | 'webm' }))}>
              <option value="mp4">MP4（H.264）</option>
              <option value="webm">WebM（VP9）</option>
            </select>
          </label>
          <label>
            码率（Mbps）
            <input type="number" min={0.4} max={12} step={0.1} value={form.bitrateMbps}
              onChange={(e) => setForm((f) => ({ ...f, bitrateMbps: Number(e.target.value) }))} />
          </label>
          <label>
            尺寸缩放（%）
            <input type="number" min={10} max={100} step={5} value={form.scalePercent}
              onChange={(e) => setForm((f) => ({ ...f, scalePercent: Number(e.target.value) }))} />
          </label>
          <label>
            帧率（0=源帧率）
            <input type="number" min={0} max={60} step={1} value={form.fps}
              onChange={(e) => setForm((f) => ({ ...f, fps: Number(e.target.value) }))} />
          </label>
          <label className="check">
            <input type="checkbox" checked={form.keepAudio}
              onChange={(e) => setForm((f) => ({ ...f, keepAudio: e.target.checked }))} />
            {browserGuidance ? '尝试保留音轨（仅 MP4 + AAC 源）' : '保留音轨'}
          </label>
        </div>
        <p className="hint mono" style={{ marginTop: 10 }}>{describeParams(form)}</p>
        {browserGuidance && form.container === 'webm' && probe?.hasAudio && (
          <p className="hint">WebM 输出不重编码音频，将生成无音轨视频；需要音轨请选 MP4 或用桌面版。</p>
        )}
      </div>

      {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}

      <div role="status" aria-live="polite">
        {queued && (paused ? '已排队：队列已暂停' : '已排队：等待空闲处理槽位')}
        {running && '正在转码'}
      </div>
      {(queued || running) && (
        <div className="card">
          <div className="row between">
            {running && progress && <span>{progress.phase} · {progress.done} / {progress.total} {progress.unit}</span>}
            {queued && paused && <button type="button" className="btn ghost" onClick={() => setPaused(false)}>继续队列</button>}
            <button type="button" className="btn ghost" onClick={cancel}>取消</button>
          </div>
          {running && progress && <progress aria-label="视频转码进度" max={progress.total || 1} value={progress.done} style={{ width: '100%', marginTop: 8 }} />}
        </div>
      )}

      <div className="row">
        <button type="button" className="btn" disabled={!file || !probe || busy || !caps?.video.available || Boolean(sizeBlocked || durationBlocked)} onClick={run}>
          {queued ? '排队中…' : busy ? '处理中…' : '开始转码'}
        </button>
        {result && <span className="hint">{result}</span>}
      </div>

      {browserGuidance && (
        <>
          <LimitNotice kind="capability" title="编解码器由浏览器决定">
            输入仅支持 MP4（H.264）。保留音轨需要 MP4 输出和 AAC 源音轨，其余情况输出无音轨。
          </LimitNotice>
          <a href={DESKTOP_RELEASE_URL} target="_blank" rel="noreferrer noopener">下载桌面版 →</a>
        </>
      )}
    </div>
  );
}
