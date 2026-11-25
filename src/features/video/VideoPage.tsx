import { useCapabilities } from '../../store/capabilities';
import { LimitNotice } from '../../components/LimitNotice';
import { DESKTOP_RELEASE_URL } from '../../lib/errors';

/** 视频轻量页。
 *
 * 视频转码的实际执行走 WebCodecs（主线程，浏览器原生编解码器），
 * 可选 ffmpeg.wasm 降级需要用户显式点击才会加载（GPL 声明常驻）。
 * 本页 Phase 4 先给出能力探测结论与限制说明；WebCodecs 转码管线在 Phase 4b 接入。
 */
export function VideoPage() {
  const { caps, limits } = useCapabilities();

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card">
        <h2>视频（轻量）</h2>
        <p className="hint">
          在线版视频走 WebCodecs：编解码器由浏览器与操作系统提供，容器限定 MP4 / WebM，
          不保证 MKV / MOV / HEVC。桌面版用 FFmpeg sidecar 支持全格式。
        </p>
        <dl className="kv" style={{ marginTop: 14 }}>
          <dt>WebCodecs 可用</dt>
          <dd>{caps?.video.available ? '是' : '否（本浏览器不支持）'}</dd>
          <dt>可用引擎</dt>
          <dd className="mono">{(caps?.video.engines ?? []).join(', ') || '—'}</dd>
          <dt>硬件编码</dt>
          <dd>{caps?.video.hardwareEncoder ? '可用' : '不可用'}</dd>
          <dt>文件大小上限</dt>
          <dd className="mono">{formatMb(limits?.maxBytes ?? 200 * 1024 * 1024)}</dd>
          <dt>时长上限</dt>
          <dd className="mono">{Math.round((limits?.maxDurationSec ?? 300) / 60)} 分钟</dd>
        </dl>
      </div>

      <div className="notice">
        <span aria-hidden="true">⚠️</span>
        <div>
          <strong>WebCodecs 转码管线在 Phase 4b 接入</strong>
          <div className="hint" style={{ marginTop: 6 }}>
            当前版本会如实探测浏览器能力，不会假装能转码。视频压缩 / 格式转换 / 抽音频 / GIF
            的完整能力请先用桌面版。
          </div>
        </div>
      </div>

      <LimitNotice kind="capability" title="编解码器由浏览器决定">
        WebCodecs 复用浏览器自带的编解码器：Chrome/Edge 94+、Firefox 130+、Safari 16.4+
        （仅 video，音频编码需 26+）。Safari 上含音频的视频转码会降级提示。
      </LimitNotice>

      <LimitNotice kind="capability" title="可选 ffmpeg.wasm 降级（GPL）">
        若浏览器编解码器不足，可手动下载 ffmpeg.wasm 降级包（@ffmpeg/core，
        <strong>GPL-2.0-or-later</strong>）。它约 31 MB / 9.7 MB gzip，单线程且慢，
        <strong>默认不加载、不预取</strong>。点击前会显示许可证说明并提供对应源码地址。
      </LimitNotice>

      <div className="card">
        <h2>需要全格式？</h2>
        <p className="hint">桌面版捆绑 FFmpeg sidecar（LGPL-2.1-or-later 构建），全格式、硬件编码、批量并行，完全离线。</p>
        <a href={DESKTOP_RELEASE_URL} target="_blank" rel="noreferrer noopener">
          下载桌面版 →
        </a>
      </div>
    </div>
  );
}

function formatMb(bytes: number): string {
  if (bytes < 0) return '不限';
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}
