import { useCallback, useState } from 'react';
import { ErrorBanner } from '../components/ErrorBanner';
import { ProgressBar } from '../components/ProgressBar';
import { getBackend } from '../lib/backend';
import { formatBytes } from '../lib/errors';
import type { ToolError } from '../lib/backend/types';
import { useQueue, type QueueItem } from '../store/queue';

/** 单个任务卡：两端共用，不读任何壳相关信息 */
export function TaskCard({ item }: { item: QueueItem }) {
  // 单值选择器（避免整个 store 变化导致重渲染）
  const retry = useQueue((s) => s.retry);
  const remove = useQueue((s) => s.remove);
  const cancel = useQueue((s) => s.cancel);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ToolError | null>(null);

  const save = useCallback(async () => {
    if (!item.outputBytes || !item.outputName) return;
    setSaving(true);
    setSaveError(null);
    try {
      const backend = await getBackend();
      await backend.saveOutput(item.outputBytes, item.outputName);
    } catch (e) {
      setSaveError(e as ToolError);
    } finally {
      setSaving(false);
    }
  }, [item.outputBytes, item.outputName]);

  const label: Record<QueueItem['status'], string> = {
    queued: '排队中',
    running: '处理中',
    succeeded: '完成',
    failed: '失败',
    cancelled: '已取消',
    removed: '已移除',
  };

  return (
    <div className={`task ${item.status}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span style={{ wordBreak: 'break-all' }} className="mono">
          {item.input.name}
        </span>
        <span className="hint mono">/ {label[item.status]}</span>
      </div>

      {item.status === 'running' && (
        <div style={{ marginTop: 8 }}>
          <ProgressBar progress={item.progress} />
        </div>
      )}

      {item.status === 'succeeded' && item.result && (
        <div className="row" style={{ marginTop: 8, gap: 14 }}>
          <span className="hint mono">{formatBytes(item.result.inputBytes)}</span>
          <span className="hint">→</span>
          <span className="ok-text mono">{formatBytes(item.result.outputBytes)}</span>
          <span className="hint">{item.result.savingsText}</span>
          <span className="grow" />
          <button onClick={save} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      )}

      {(item.status === 'failed' || item.status === 'cancelled') && (
        <div className="row" style={{ marginTop: 8 }}>
          {item.error && (
            <span className="err-text" style={{ flex: 1 }}>
              {item.error.message}
            </span>
          )}
          <button onClick={() => void retry(item.id)} disabled={item.attempt >= 3}>
            {item.attempt >= 3 ? '已达上限' : `重试${item.attempt > 0 ? ` (${item.attempt}/3)` : ''}`}
          </button>
          <button onClick={() => remove(item.id)} className="ghost">
            移除
          </button>
        </div>
      )}

      {item.status === 'queued' && (
        <div className="row" style={{ marginTop: 8 }}>
          <button onClick={() => cancel(item.id)} className="ghost">
            取消
          </button>
        </div>
      )}

      {saveError && (
        <div style={{ marginTop: 8 }}>
          <ErrorBanner error={saveError} onDismiss={() => setSaveError(null)} />
        </div>
      )}
    </div>
  );
}
