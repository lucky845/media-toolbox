import { useCapabilities } from '../../store/capabilities';
import { LimitNotice } from '../../components/LimitNotice';
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
            <dt>跨源隔离</dt>
            <dd>
              {caps.env.crossOriginIsolated ? (
                <span className="ok-text">已隔离（可用多线程）</span>
              ) : (
                <span className="warn-text">未隔离 —— 这是本站单线程的根本原因</span>
              )}
            </dd>
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

      <div className="card">
        <h2>能力矩阵</h2>
        <p className="hint">
          下表是**当前形态**的真实能力。在线版的每处限制都给了原因 —— 这不是「暂时没做」，而是平台边界。
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
              <td>⚠️ 能力探测已接入，WebCodecs 管线 Phase 4b</td>
              <td>✅ 全格式 + 硬件编码</td>
              <td>
                当前在线版会如实探测浏览器编解码能力，但尚未执行转码（不假装能转）。
                浏览器的编码器由 Chrome/Safari 决定，容器只出 MP4/WebM；不保证 MKV/MOV/HEVC。
                需要转码请用桌面版（FFmpeg sidecar）。
              </td>
            </tr>
            <tr>
              <td>PDF → 图片</td>
              <td>⚠️ 渲染管线 Phase 4b 待接入</td>
              <td>✅ 全页数 + 高 DPI</td>
              <td>
                当前在线版只做 PDF 结构操作（旋转/拆分/合并/提取）。按页渲染需要 pdf.js +
                虚拟化缓冲池，将在 Phase 4b 接入；在此之前请到 PDF 页用结构功能或桌面版渲染。
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
            理论上限 4 GB，但浏览器单个页面实际可用的远低于此。为了让「处理到一半 OOM 崩溃」
            不发生在你身上，我们对超过阈值的文件**在开始前就拒绝**，并给出桌面版引导。
          </LimitNotice>

          <LimitNotice kind="capability" title="编解码器由浏览器决定">
            在线版的视频转码走 WebCodecs，它复用浏览器/系统自带的编解码器。这意味着：能压什么格式、
            有没有硬件加速，取决于你用的浏览器与操作系统，而不是我们能控制的。需要「所有格式都能转」
            就只能用桌面版。
          </LimitNotice>

          <LimitNotice kind="capability" title="不能调用 LibreOffice / FFmpeg 原生程序">
            浏览器沙箱里无法启动外部进程。所以 Word↔PDF 只能做结构化转换，视频只能用浏览器的编解码器。
            桌面版把这些程序打包进安装包（FFmpeg + LibreOffice），不需要你另外安装。
          </LimitNotice>
        </div>
      </div>

      <div className="card">
        <h2>桌面版</h2>
        <p className="hint">
          桌面版是同一个仓库的 Tauri 应用：完全离线、无网络请求、把 FFmpeg 与 LibreOffice
          打包进安装包。macOS 版本目前未签名，首次打开需要右键 → 打开。
        </p>
        <a href={DESKTOP_RELEASE_URL} target="_blank" rel="noreferrer noopener">
          下载桌面版 →
        </a>
      </div>
    </div>
  );
}
