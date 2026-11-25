import { DESKTOP_RELEASE_URL } from '../lib/errors';

/**
 * 受限功能的常驻提示（规格 §15：每个受限功能旁必须有常驻提示，不能只在出错后弹窗）。
 * `kind` 决定语气：limit = 硬上限，fidelity = 保真度声明，capability = 浏览器能力缺失。
 */
export function LimitNotice({
  kind,
  title,
  children,
}: {
  kind: 'limit' | 'fidelity' | 'capability';
  title: string;
  children: React.ReactNode;
}) {
  const icon = kind === 'limit' ? '⛔' : kind === 'fidelity' ? '⚠️' : 'ℹ️';
  return (
    <div className={`notice ${kind === 'capability' ? 'info' : ''}`}>
      <span aria-hidden="true">{icon}</span>
      <div>
        <strong>{title}</strong>
        <div className="hint" style={{ marginTop: 4 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

/** 超限时给的桌面版引导（带链接，且说明为什么不支持） */
export function DesktopCta({ reason }: { reason: string }) {
  return (
    <div className="notice danger">
      <span aria-hidden="true">⛔</span>
      <div>
        <strong>这超出在线版的处理范围</strong>
        <div className="hint" style={{ marginTop: 4, marginBottom: 8 }}>{reason}</div>
        <a href={DESKTOP_RELEASE_URL} target="_blank" rel="noreferrer noopener">
          下载桌面版（全量能力，完全离线）→
        </a>
      </div>
    </div>
  );
}
