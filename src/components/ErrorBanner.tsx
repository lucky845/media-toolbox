import { DESKTOP_RELEASE_URL, messageOf } from '../lib/errors';
import type { ToolError } from '../lib/backend/types';

export function ErrorBanner({
  error,
  onRetry,
  onDismiss,
}: {
  error: ToolError | unknown;
  onRetry?: () => void;
  onDismiss?: () => void;
}) {
  const e = error as ToolError;
  const showDesktop = typeof e?.desktopHint === 'boolean' && e.desktopHint;

  return (
    <div className="notice danger">
      <span aria-hidden="true">⛔</span>
      <div className="grow">
        <strong>{messageOf(error)}</strong>
        {e?.detail && (
          <div className="mono hint" style={{ marginTop: 4 }}>
            {e.detail}
          </div>
        )}
        {showDesktop && (
          <div style={{ marginTop: 8 }}>
            <a href={DESKTOP_RELEASE_URL} target="_blank" rel="noreferrer noopener">
              用桌面版处理这类文件 →
            </a>
          </div>
        )}
        <div className="row" style={{ marginTop: 8 }}>
          {onRetry && e?.retryable !== false && (
            <button onClick={onRetry}>重试</button>
          )}
          {onDismiss && (
            <button onClick={onDismiss} className="hint">
              忽略
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
