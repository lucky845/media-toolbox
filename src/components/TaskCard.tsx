import { useState } from 'react';
import { ErrorBanner } from './ErrorBanner';
import { ProgressBar } from './ProgressBar';
import { getBackend } from '../lib/backend';
import { fallbackMessage, formatBytes, isToolError } from '../lib/errors';
import type { ToolError } from '../lib/backend/types';
import { isActive, TASK_LABELS, taskInputs, useQueue, type QueueItem } from '../store/queue';

const LABELS: Record<QueueItem['status'], string> = {
  queued: '排队中',
  running: '处理中',
  succeeded: '完成',
  failed: '失败',
  cancelled: '已取消',
};

export function TaskCard({ item }: { item: QueueItem }) {
  const { retry, remove, cancel } = useQueue.getState();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ToolError | null>(null);
  const result = item.result;
  const outputs = result && !result.savedOutputs
    ? result.outputs ?? [{ name: result.outputName, bytes: result.bytes }]
    : [];
  const downloadable = outputs.filter((output) => output.bytes.length > 0);

  async function save(output: (typeof downloadable)[number]) {
    setSaving(true);
    setSaveError(null);
    try {
      await (await getBackend()).saveOutput(output.bytes, output.name);
    } catch (error) {
      setSaveError(isToolError(error) ? error : {
        code: 'IO', message: fallbackMessage('IO'), retryable: true, desktopHint: false,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`task ${item.status}`}>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <span className="mono" style={{ overflowWrap: 'anywhere' }}>{taskInputs(item.task).map((input) => input.name).join('、')}</span>
        <span className="hint">{TASK_LABELS[item.task.kind]} · {LABELS[item.status]}</span>
      </div>
      {item.status === 'running' && <ProgressBar progress={item.progress} />}
      {result && <p className="hint mono">{formatBytes(result.meta.inputBytes)} → {formatBytes(result.meta.outputBytes)}</p>}
      {result?.savedOutputs?.map(({ path, name }) => <p key={path} className="hint" title={path}>{name} · 已写入磁盘</p>)}
      {item.error && <ErrorBanner error={item.error} />}
      <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
        {isActive(item) && <button type="button" className="ghost" onClick={() => cancel(item.id)}>取消</button>}
        {(item.status === 'failed' || item.status === 'cancelled') && (
          <button type="button" onClick={() => retry(item.id)} disabled={item.attempt >= 3}>
            {item.attempt >= 3 ? '已达重试上限' : `重试${item.attempt ? ` (${item.attempt}/3)` : ''}`}
          </button>
        )}
        {downloadable.map((output, index) => (
          <button key={`${index}-${output.name}`} type="button" onClick={() => void save(output)} disabled={saving}>
            {downloadable.length === 1 ? '保存' : `保存 ${output.name}`}
          </button>
        ))}
        {!isActive(item) && <button type="button" className="ghost" onClick={() => remove(item.id)}>移除</button>}
      </div>
      {saveError && <ErrorBanner error={saveError} onDismiss={() => setSaveError(null)} />}
    </div>
  );
}
