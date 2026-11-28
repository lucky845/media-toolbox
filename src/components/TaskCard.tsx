import { useState } from 'react';
import { ErrorBanner } from './ErrorBanner';
import { ProgressBar } from './ProgressBar';
import { fallbackMessage, formatBytes, isToolError } from '../lib/errors';
import type { ToolError } from '../lib/backend/types';
import { canRetryItem, hasPendingOutputs, isActive, TASK_LABELS, taskInputs, taskOutputs, useQueue, type QueueItem } from '../store/queue';

const LABELS: Record<QueueItem['status'], string> = {
  queued: '排队中',
  running: '处理中',
  succeeded: '完成',
  failed: '失败',
  cancelled: '已取消',
};

export function TaskCard({ item, onRemove }: { item: QueueItem; onRemove: (item: QueueItem) => void }) {
  const { retry, cancel, saveOutput } = useQueue.getState();
  const [saveError, setSaveError] = useState<ToolError | null>(null);
  const result = item.result;
  const outputs = taskOutputs(result);
  const saving = Object.values(item.outputSaveStates ?? {}).includes('saving');
  const pending = hasPendingOutputs(item);

  async function save(index: number) {
    setSaveError(null);
    try {
      await saveOutput(item.id, index);
    } catch (error) {
      setSaveError(isToolError(error) ? error : {
        code: 'IO', message: fallbackMessage('IO'), retryable: true, desktopHint: false,
      });
    }
  }

  return (
    <div className={`task ${item.status}`}>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <span className="mono" style={{ overflowWrap: 'anywhere' }}>{taskInputs(item.task).map((input) => input.name).join('、')}</span>
        <span className="hint">{TASK_LABELS[item.task.kind]} · {pending ? '待保存' : LABELS[item.status]}</span>
      </div>
      {item.status === 'running' && <ProgressBar progress={item.progress} />}
      {result && <p className="hint mono">{formatBytes(result.meta.inputBytes)} → {formatBytes(result.meta.outputBytes)}</p>}
      {outputs.map(({ name }, index) => {
        const state = item.outputSaveStates?.[index];
        return (
          <p key={`${index}-${name}`} className="hint" style={{ overflowWrap: 'anywhere' }}>
            输出文件：<span className="mono">{name}</span>
            {state === 'saved' ? ' · 已保存' : state === 'downloaded' ? ' · 已发起下载' : null}
          </p>
        );
      })}
      {result?.savedOutputs?.map(({ path, name }) => (
        <p key={path} className="hint" title={path} style={{ overflowWrap: 'anywhere' }}>
          输出文件：<span className="mono">{name}</span> · 已写入磁盘
        </p>
      ))}
      {item.error && <ErrorBanner error={item.error} />}
      <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
        {isActive(item) && <button type="button" className="ghost" onClick={() => cancel(item.id)}>取消</button>}
        {canRetryItem(item) && (
          <button type="button" onClick={() => retry(item.id)} disabled={item.attempt >= 3}>
            {item.attempt >= 3 ? '已达重试上限' : `重试${item.attempt ? ` (${item.attempt}/3)` : ''}`}
          </button>
        )}
        {outputs.map((output, index) => {
          const state = item.outputSaveStates?.[index];
          if (output.bytes.length === 0 || state === 'saved' || state === 'downloaded') return null;
          return (
            <button key={`${index}-${output.name}`} type="button" onClick={() => void save(index)} disabled={saving}>
              {state === 'saving' ? '保存中…' : outputs.length === 1 ? '保存' : `保存 ${output.name}`}
            </button>
          );
        })}
        {!isActive(item) && (
          <button type="button" className="ghost" disabled={saving} onClick={() => onRemove(item)}>
            {pending ? '放弃未保存结果并移除' : '移除'}
          </button>
        )}
      </div>
      {saveError && <ErrorBanner error={saveError} onDismiss={() => setSaveError(null)} />}
    </div>
  );
}
