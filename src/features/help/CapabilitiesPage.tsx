import { useCapabilities } from '../../store/capabilities';
import { LimitNotice } from '../../components/LimitNotice';
import type { Limits } from '../../lib/backend/types';
import { DESKTOP_RELEASE_URL, formatBytes } from '../../lib/errors';

/**
 * 站内「能力与限制」页（规格 §15 的硬交付物）。
 *
 * 内容与 `docs/CAPABILITIES.md` 的 ✅/⚠️/❌ 判断一致；措辞面向用户，
 * 但每一条 ⚠️ 都必须给**原因**，不能只说「不支持」。
 */
export function CapabilitiesPage() {
  const { caps, limits, summary } = useCapabilities();

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card">
        <h2>当前环境</h2>
        {caps ? (
          <dl className="kv">
            <dt>形态</dt>
            <dd>{summary?.formDescription ?? '未知'}</dd>
            <dt>契约版本</dt>
            <dd className="mono">v{caps.contractVersion}</dd>
            {summary?.showBrowserGuidance && (
              <>
                <dt>跨源隔离</dt>
                <dd>{caps.env.crossOriginIsolated ? '已隔离' : '未隔离'}</dd>
              </>
            )}
            <dt>并行度</dt>
            <dd className="mono">{caps.image.parallel}</dd>
            <dt>取消能力</dt>
            <dd>
              {caps.cancel.hard ? (
                <span className="ok-text">硬取消（立即停止并清理）</span>
              ) : (
                <span className="warn-text">软取消（终止工作线程，需重建）</span>
              )}
            </dd>
            <dt>目录写入</dt>
            <dd>{caps.fileSystem.directoryPicker ? '支持选择输出目录' : '仅能逐个下载'}</dd>
            <dt>离线</dt>
            <dd>{summary?.offlineDescription ?? '未知'}</dd>
          </dl>
        ) : (
          <span className="hint">探测中…</span>
        )}
      </div>

      {summary?.showBrowserGuidance && <BrowserHelp limits={limits} />}
      {caps && summary && !summary.showBrowserGuidance && (
        <div className="card">
          <h2>本机处理能力</h2>
          <dl className="kv">
            <dt>图片输出</dt>
            <dd>{caps.image.formats.join(' / ') || '—'}</dd>
            <dt>PDF 处理</dt>
            <dd>{[caps.pdf.edit && '合并、拆分、旋转、提取', caps.pdf.render && '导出图片'].filter(Boolean).join(' / ') || '不可用'}</dd>
            <dt>视频转码</dt>
            <dd>{caps.video.available ? 'FFmpeg' : '未检测到 FFmpeg'}</dd>
            <dt>Word ↔ PDF</dt>
            <dd>
              {caps.office.wordToPdf === 'native'
                ? 'LibreOffice 原生转换'
                : <a href="#/documents">查看 LibreOffice 下载与安装说明</a>}
            </dd>
          </dl>
        </div>
      )}
    </div>
  );
}

function BrowserHelp({ limits }: { limits: Limits | null }) {
  return (
    <>
      <div className="card">
        <h2>能力矩阵</h2>
        <p className="hint">
          下表对比两个版本的处理能力。
        </p>
        <table>
          <thead>
            <tr>
              <th style={{ width: '30%' }}>能力</th>
              <th style={{ width: '14%' }}>在线版</th>
              <th style={{ width: '14%' }}>桌面版</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>图片压缩 / 裁剪 / 旋转 / 缩放</td>
              <td>✅ 中小图</td>
              <td>✅ 大图 + 批量 + 并行</td>
              <td>同一份 Rust 代码，在线版单线程、桌面版 rayon 并行</td>
            </tr>
            <tr>
              <td>图片格式转换</td>
              <td>✅ jpeg/png/webp/gif/bmp/tiff</td>
              <td>✅ 加 AVIF</td>
              <td>在线版 AVIF 编码默认关闭（体积预算：+1.5–2 MB）</td>
            </tr>
            <tr>
              <td>视频压缩 / 转码</td>
              <td>✅ 轻量：MP4(H.264)→MP4/WebM</td>
              <td>✅ FFmpeg 原生转码</td>
              <td>
                WebCodecs 原生编解码，mp4box.js 解封装，≤200 MB / ≤5 分钟。
                输入仅 MP4/H.264、输出 MP4(H.264)/WebM(VP9)，无硬件编码、不保证 MKV/MOV/HEVC；
                音轨仅 MP4 + 源 AAC 可无损透传，否则无音轨。桌面版使用 FFmpeg，支持更多输入格式。
              </td>
            </tr>
            <tr>
              <td>PDF → 图片</td>
              <td>✅ ≤100 页，按页渲染 + 虚拟化</td>
              <td>✅ 全页数 + 高 DPI</td>
              <td>
                pdf.js 在主线程按页渲染到 OffscreenCanvas，解析由 pdf.js 自带 Worker 完成；
                只渲染视口附近的页，位图按 LRU 回收。支持 72/120/150/200 DPI、PNG/JPEG/WebP、
                页码范围与长图拼接；单次最多 100 页，更高 DPI 的批量导出请到桌面版。
              </td>
            </tr>
            <tr>
              <td>PDF 合并 / 拆分 / 旋转 / 提取</td>
              <td>✅</td>
              <td>✅</td>
              <td>Rust lopdf，字节级结构重排，两端同一份</td>
            </tr>
            <tr>
              <td>Word ↔ PDF</td>
              <td>⚠️ 仅结构化</td>
              <td>✅ LibreOffice headless</td>
              <td>
                浏览器内没有 LibreOffice，只能按结构化方式排版。会丢失：嵌入字体、分栏、浮动图形、
                页眉页脚、脚注、批注、修订、域、复杂表格边框、目录、公式。
              </td>
            </tr>
            <tr>
              <td>批量队列</td>
              <td>⚠️ 1–2 个 Worker</td>
              <td>✅ rayon + 子进程池</td>
              <td>在线版并发受 wasm 单线程限制</td>
            </tr>
            <tr>
              <td>离线</td>
              <td>⚠️ 首次在线加载后</td>
              <td>✅ 完全离线</td>
              <td>在线版首次必须联网加载外壳与 wasm</td>
            </tr>
            <tr>
              <td>大文件</td>
              <td>❌ 超限中止</td>
              <td>✅ 流式处理</td>
              <td>
                在线版上限：图片 {(limits?.maxPixels ?? 20_000_000) / 1e6} MP /{' '}
                {formatBytes(limits?.maxBytes ?? 20 * 1024 * 1024)}，视频{' '}
                {Math.round((limits?.maxDurationSec ?? 300) / 60)} 分钟 /{' '}
                {formatBytes(200 * 1024 * 1024)}，PDF {limits?.maxPages ?? 100} 页
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>为什么在线版有限制</h2>
        <div className="col" style={{ gap: 12 }}>
          <LimitNotice kind="capability" title="没有多线程，因为 GitHub Pages 不能设置响应头">
            SharedArrayBuffer 与 wasm 多线程都要求页面处于「跨源隔离」状态，而跨源隔离依赖
            COOP/COEP 两个 HTTP 响应头。GitHub Pages 不支持自定义响应头，所以
            <code>crossOriginIsolated</code> 恒为 false。这不是我们不想做，是平台不给。
          </LimitNotice>

          <LimitNotice kind="capability" title="wasm 只有 32 位地址空间">
            理论上限 4 GB，浏览器实际可用的内存通常更少。在线版会在处理前检查文件是否超过上限。
          </LimitNotice>

          <LimitNotice kind="capability" title="编解码器由浏览器决定">
            在线版的视频转码走 WebCodecs，它复用浏览器/系统自带的编解码器。这意味着：能压什么格式、
            有没有硬件加速，取决于你用的浏览器与操作系统，而不是我们能控制的。桌面版通过 FFmpeg 支持更多输入格式。
          </LimitNotice>

          <LimitNotice kind="capability" title="不能调用 LibreOffice / FFmpeg 原生程序">
            浏览器沙箱里无法启动外部进程。所以 Word↔PDF 只能做结构化转换，视频只能用浏览器的编解码器。
            桌面版使用随包提供的 FFmpeg。原生文档转换需要 LibreOffice。
          </LimitNotice>
        </div>
      </div>

      <div className="card">
        <h2>桌面版</h2>
        <p className="hint">
          桌面版可离线处理文件，随包提供 FFmpeg。原生文档转换需要 LibreOffice。
        </p>
        <a href={DESKTOP_RELEASE_URL} target="_blank" rel="noreferrer noopener">
          下载桌面版 →
        </a>
      </div>
    </>
  );
}
