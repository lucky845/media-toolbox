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
      <header className="topbar">
        <span className="brand">本地多媒体工具箱</span>
        <nav className="nav">
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
        <span className="grow" />
        {status === 'loading' && <span className="badge">探测能力中…</span>}
        {status === 'ready' && summary && (
          <span className={`badge ${summary.tone}`}>{summary.label}</span>
        )}
        {status === 'failed' && <span className="badge err">能力探测失败</span>}
      </header>

      {status === 'failed' && (
        <div style={{ maxWidth: 1080, margin: '16px auto 0', padding: '0 22px' }}>
          <div className="notice danger">
            <span>⚠</span>
            <div>
              <strong>核心模块未能加载，已进入受限模式。</strong>
              <div className="hint" style={{ marginTop: 4 }}>
                {error?.message ?? '未知原因'}
                {error?.detail && <div className="mono" style={{ marginTop: 4 }}>{error.detail}</div>}
              </div>
            </div>
          </div>
        </div>
      )}

      <main>{children}</main>

      <footer className="footer">
        所有处理都在你的设备上完成，文件不会上传。在线版仅分发代码，但仓库与构建产物是公开的。
      </footer>
    </div>
  );
}
