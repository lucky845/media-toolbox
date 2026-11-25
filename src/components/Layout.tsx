import { useEffect } from 'react';
import { useCapabilities } from '../store/capabilities';

const NAV = [
  { href: '#/image', label: '图片' },
  { href: '#/pdf', label: 'PDF' },
  { href: '#/video', label: '视频' },
  { href: '#/documents', label: '文档' },
  { href: '#/help', label: '能力与限制' },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const { status, summary, error, load } = useCapabilities();

  useEffect(() => {
    void load();
  }, [load]);

  const activeHash = typeof window !== 'undefined' ? window.location.hash : '';

  return (
    <div className="layout">
      {/* 图纸装订边（≥1280px 显示，与主页一致） */}
      <div className="ruler" aria-hidden="true" />

      <header className="topbar">
        <a className="brand" href="#/image" aria-label="本地多媒体工具箱首页">
          media-toolbox
        </a>
        <span className="brand-sub">/ LOCAL MEDIA LAB</span>
        <nav className="nav" aria-label="主要导航">
          {NAV.map((n) => (
            <a
              key={n.href}
              href={n.href}
              className={activeHash === n.href || (activeHash === '' && n.href === '#/image') ? 'active' : ''}
            >
              {n.label}
            </a>
          ))}
        </nav>
      </header>

      {/* 形态状态属于内容信息，不挤占顶栏导航空间 */}
      <div className="status-strip" aria-live="polite">
        {status === 'loading' && <span className="badge">/ 正在探测能力…</span>}
        {status === 'ready' && summary && (
          <span className={`badge ${summary.tone}`}>{summary.label}</span>
        )}
        {status === 'failed' && <span className="badge err">/ 能力探测失败</span>}
      </div>

      {status === 'failed' && (
        <div style={{ padding: '16px clamp(1.5rem, 6vw, 5rem) 0' }}>
          <div className="notice danger">
            <span aria-hidden="true">✕</span>
            <div>
              <strong>核心模块未能加载，已进入受限模式。</strong>
              <div className="hint" style={{ marginTop: 4 }}>
                {error?.message ?? '未知原因'}
                {error?.detail && (
                  <div className="mono" style={{ marginTop: 4 }}>{error.detail}</div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <main>
        {/* 角上的十字定位记号（与主页 .reg 一致） */}
        <span className="reg reg-tl" aria-hidden="true" style={{ left: '6vw', top: '1.4rem' }} />
        {children}
      </main>

      <footer className="footer">
        所有处理都在你的设备上完成，文件不会上传。在线版仅分发代码，但仓库与构建产物是公开的。
        <br />
        <span className="mono">lucky845 / media-toolbox — schematic sheet</span>
      </footer>
    </div>
  );
}
