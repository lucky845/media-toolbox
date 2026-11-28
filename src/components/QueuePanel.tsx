import { useId, useRef, useState } from 'react';
import { canClearItem, hasPendingOutputs, useQueue, type QueueItem } from '../store/queue';
import { TaskCard } from './TaskCard';
import './QueuePanel.css';

/** 批量队列面板：单任务进度 + 总进度 + 队列级暂停 */
export function QueuePanel({
  active,
  finished,
  paused,
  onPause,
  onClear,
}: {
  active: QueueItem[];
  finished: QueueItem[];
  paused: boolean;
  onPause: () => void;
  onClear: () => void;
}) {
  const [selection, setSelection] = useState<QueueItem | null>(null);
  const [feedback, setFeedback] = useState('');
  const confirmation = useRef<HTMLDialogElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const dialogTitle = useId();
  const dialogDescription = useId();
  const clearable = finished.filter(canClearItem).length;
  const pending = finished.length - clearable;
  const runningCount = active.filter((item) => item.status === 'running').length;

  function remove(item: QueueItem) {
    if (useQueue.getState().remove(item.id)) {
      setFeedback(hasPendingOutputs(item) ? '已移除任务，并丢弃未保存的结果。' : '已从队列移除任务。');
      status.current?.focus({ preventScroll: true });
    }
  }

  function requestRemoval(item: QueueItem) {
    if (!hasPendingOutputs(item)) {
      remove(item);
      return;
    }
    setSelection(item);
    confirmation.current?.showModal();
  }
  const overall = active.length ? active.reduce((sum, { progress }) => (
    sum + (progress && progress.total > 0 ? Math.min(1, Math.max(0, progress.done / progress.total)) : 0)
  ), 0) / active.length : 0;

  return (
    <>
      <p className="hint queue-feedback" role="status" ref={status} tabIndex={-1}>{feedback}</p>
      <dialog
        ref={confirmation}
        className="queue-remove-dialog"
        aria-labelledby={dialogTitle}
        aria-describedby={dialogDescription}
        onClose={() => setSelection(null)}
      >
        <h2 id={dialogTitle}>移除任务并丢弃结果？</h2>
        <p id={dialogDescription}>尚未保存的结果将被丢弃，移除后无法恢复。</p>
        <form method="dialog" className="row" onSubmit={(event) => {
          if ((event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') !== 'remove' || !selection) return;
          event.preventDefault();
          confirmation.current?.close();
          remove(selection);
        }}>
          <button type="submit" value="cancel" autoFocus>取消</button>
          <button type="submit" value="remove" className="danger">丢弃并移除</button>
        </form>
      </dialog>
      {active.length > 0 && (
        <div className="card">
          <h2>队列 · {active.length} 项</h2>
          <div className="row" style={{ marginBottom: 12 }}>
            <span className="hint mono">
              总进度 {(overall * 100).toFixed(0)}% · 运行中 {runningCount}
            </span>
            <span className="grow" />
            <button onClick={onPause} className="ghost">
              {paused ? '继续队列' : '暂停队列（不取新任务）'}
            </button>
          </div>
          <div className="progress" style={{ marginBottom: 14 }}>
            <div style={{ width: `${overall * 100}%` }} />
          </div>
          {active.map((item) => (
            <TaskCard key={item.id} item={item} onRemove={requestRemoval} />
          ))}
        </div>
      )}

      {finished.length > 0 && (
        <div className="card">
          <h2>已完成 · {finished.length} 项</h2>
          <button type="button" onClick={onClear} disabled={clearable === 0} className="ghost" style={{ marginBottom: 12 }}>
            清除已完成
          </button>
          {pending > 0 && <p className="hint">{pending} 项结果待保存，批量清除不会移除这些任务。</p>}
          {finished.map((item) => (
            <TaskCard key={item.id} item={item} onRemove={requestRemoval} />
          ))}
        </div>
      )}
    </>
  );
}
