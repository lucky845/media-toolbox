import { useCallback, useRef, useState } from 'react';
import { DropZone } from '../../components/DropZone';
import { ErrorBanner } from '../../components/ErrorBanner';
import { DesktopCta, LimitNotice } from '../../components/LimitNotice';
import { getBackend } from '../../lib/backend';
import { getVideoBackend } from '../../lib/backend/web/videoBackend';
import { DESKTOP_RELEASE_URL, formatBytes } from '../../lib/errors';
import type { InputRef, Progress, ToolError, VideoProbeResult } from '../../lib/backend/types';
import { useCapabilities } from '../../store/capabilities';
import { buildParams, defaultForm, describeParams, formatDuration, type VideoFormState } from './videoForm';

const ACCEPT = '.mp4,video/mp4';

/** 视频轻量页：mp4box 解封装 + WebCodecs 编解码 + muxer 封装，全程在本机浏览器内完成。
 *
 * 限制（UI 常驻，见 docs/COMPATIBILITY.md）：
 * - 输入仅 MP4(ISOBMFF)/H.264；输出 MP4(H.264) 或 WebM(VP9)；无硬件编码。
 * - 音频仅「MP4 输出 + 源 AAC + 保留音轨」时无损透传，其余情况无音轨。
 * - 可选 ffmpeg.wasm 降级只在用户显式点击时加载（GPL-2.0-or-later）。
 */
export function VideoPage() {
  const { caps } = useCapabilities();
  const [file, setFile] = useState<InputRef | null>(null);
  const [probe, setProbe] = useState<VideoProbeResult | null>(null);
  const [form, setForm] = useState<VideoFormState>(() => defaultForm());
  const [error, setError] = useState<ToolError | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  const onFiles = useCallback(async (files: File[]) => {
    setError(null);
    setProbe(null);
    setResult(null);
    setProgress(null);
    const f = files[0];
    if (!f) return;
    const ref: InputRef = { file: f, name: f.name, size: f.size };
    setFile(ref);
    setBusy(true);
    try {
      setProbe(await getVideoBackend().probe(ref));
    } catch (e) {
      setError(e as ToolError);
    } finally {
      setBusy(false);
    }
  }, []);

  const pick = useCallback(async () => {
    const backend = await getBackend();
    const refs = await backend.pickFiles(ACCEPT, false);
    if (refs[0]?.file) await onFiles([refs[0].file]);
  }, [onFiles]);

  const run = useCallback(async () => {
    if (!file || busy) return;
    setError(null);
    setResult(null);
    setBusy(true);
    const ac = new AbortController();
    controller.current = ac;
    try {
      const backend = await getBackend();
      const out = await backend.run(
        { kind: 'video.transcode', input: file, params: buildParams(form) },
        {
          taskId: `video-${Date.now().toString(36)}`,
          signal: ac.signal,
          onProgress: (p) => setProgress(p),
          onLog: () => {},
        },
      );
      await backend.saveOutput(out.bytes, out.outputName);
      setResult(`已生成 ${out.outputName}（${formatBytes(out.bytes.length)}，${out.meta.savingsText}）`);
    } catch (e) {
      setError(e as ToolError);
    } finally {
      controller.current = null;
      setBusy(false);
    }
  }, [file, busy, form]);

  const cancel = useCallback(() => {
    controller.current?.abort();
  }, []);

  // 视频阈值取自 caps.video（200 MB / 300 秒），不能用图片通用的 limits.maxBytes（20 MB）。
  const videoMaxBytes = caps?.video.maxBytes ?? 200 * 1024 * 1024;
  const videoMaxDuration = caps?.video.maxDurationSec ?? 300;
  const durationBlocked = probe && probe.durationSec > videoMaxDuration;
  const sizeBlocked = file && file.size > videoMaxBytes;

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card">
        <h2>导入视频（MP4 / H.264）</h2>
        <p className="hint">
          在线版用浏览器原生 WebCodecs 转码：解封装仅支持 MP4，输出 MP4(H.264) / WebM(VP9)，
          文件始终留在本机，不上传。桌面版可处理全格式与更大文件。
        </p>
        <DropZone accept={ACCEPT} multiple={false} onFiles={onFiles} onPick={pick} disabled={busy} />
      </div>

      <div className="card">
        <h2>探测到的编解码器</h2>
        <dl className="kv" style={{ marginTop: 10 }}>
          <dt>WebCodecs 可用</dt>
          <dd>{caps?.video.available ? '是' : '否（本浏览器不支持，转码不可用）'}</dd>
          <dt>支持解码</dt>
          <dd className="mono">{(caps?.video.decoders ?? []).join(', ') || '—'}</dd>
          <dt>支持编码</dt>
          <dd className="mono">{(caps?.video.encoders ?? []).join(', ') || '—'}</dd>
          <dt>硬件编码</dt>
          <dd>{caps?.video.hardwareEncoder ? '可用' : '不可用（在线版不使用）'}</dd>
          <dt>文件大小上限</dt>
          <dd className="mono">{formatBytes(videoMaxBytes)}</dd>
          <dt>时长上限</dt>
          <dd className="mono">{Math.round(videoMaxDuration / 60)} 分钟</dd>
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
                  ? `${probe.audioCodec ?? '未知'}${probe.audioPassthrough ? '（可无损透传）' : '（无法透传，输出将无音轨）'}`
                  : '无'}
              </dd>
            </dl>
          )}
          {sizeBlocked && (
            <div style={{ marginTop: 12 }}>
              <DesktopCta reason={`文件 ${formatBytes(file.size)}，超过在线版 ${formatBytes(videoMaxBytes)} 上限。`} />
            </div>
          )}
          {durationBlocked && (
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
            尝试保留音轨（仅 MP4 + AAC 源）
          </label>
        </div>
        <p className="hint mono" style={{ marginTop: 10 }}>{describeParams(form)}</p>
        {form.container === 'webm' && probe?.hasAudio && (
          <p className="hint">WebM 输出不重编码音频，将生成无音轨视频；需要音轨请选 MP4 或用桌面版。</p>
        )}
      </div>

      {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}

      {busy && progress && (
        <div className="card">
          <div className="row between">
            <span>{progress.phase} · {progress.done} / {progress.total} {progress.unit}</span>
            <button type="button" className="btn ghost" onClick={cancel}>取消</button>
          </div>
          <progress max={progress.total || 1} value={progress.done} style={{ width: '100%', marginTop: 8 }} />
        </div>
      )}

      <div className="row">
        <button type="button" className="btn" disabled={!file || busy || !caps?.video.available || Boolean(sizeBlocked || durationBlocked)} onClick={run}>
          {busy ? '处理中…' : '开始转码'}
        </button>
        {result && <span className="hint">{result}</span>}
      </div>

      <LimitNotice kind="capability" title="编解码器由浏览器决定">
        WebCodecs 复用浏览器自带的编解码器：Chrome/Edge 94+、Firefox 130+、Safari 16.4+
        （仅 video，音频编码需 26+）。本页按 isConfigSupported 逐个探测，不支持的配置不会假装可用。
      </LimitNotice>
      <LimitNotice kind="capability" title="容器与音轨限制">
        解封装只支持 MP4(H.264)；MKV/MOV/HEVC 请下载桌面版。音频仅「MP4 输出 + 源 AAC + 保留音轨」时无损透传，
        其余情况输出无音轨。在线版没有硬件编码、没有 FFmpeg/LibreOffice。
      </LimitNotice>
      <LimitNotice kind="capability" title="可选 ffmpeg.wasm 降级（GPL）">
        若浏览器编解码器不足，可手动下载 ffmpeg.wasm 降级包（@ffmpeg/core，
        <strong>GPL-2.0-or-later</strong>）。它约 31 MB / 9.7 MB gzip，单线程且慢，
        <strong>默认不加载、不预取</strong>。点击前会显示许可证说明并提供对应源码地址。
      </LimitNotice>

      <div className="card">
        <h2>需要全格式？</h2>
        <p className="hint">桌面版捆绑 FFmpeg sidecar（LGPL-2.1-or-later 构建），全格式、硬件编码、批量并行，完全离线。</p>
        <a href={DESKTOP_RELEASE_URL} target="_blank" rel="noreferrer noopener">下载桌面版 →</a>
      </div>
    </div>
  );
}
