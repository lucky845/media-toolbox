import { useQueue, type QueueItem } from '../store/queue';
import { TaskCard } from './TaskCard';

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
  const overall = useQueue((s) => s.totalProgress);
  const runningCount = useQueue((s) => s.runningCount);

  return (
    <>
      {active.length > 0 && (
        <div className="card">
          <h2>队列 · {active.length} 项</h2>
          <div className="row" style={{ marginBottom: 12 }}>
            <span className="hint mono">
              总进度 {(overall() * 100).toFixed(0)}% · 运行中 {runningCount()}
            </span>
            <span className="grow" />
            <button onClick={onPause} className="ghost">
              {paused ? '继续队列' : '暂停队列（不取新任务）'}
            </button>
          </div>
          <div className="progress" style={{ marginBottom: 14 }}>
            <div style={{ width: `${overall() * 100}%` }} />
          </div>
          {active.map((item) => (
            <TaskCard key={item.id} item={item} />
          ))}
        </div>
      )}

      {finished.length > 0 && (
        <div className="card">
          <h2>已完成 · {finished.length} 项</h2>
          <button onClick={onClear} className="ghost" style={{ marginBottom: 12 }}>
            清除已完成
          </button>
          {finished.map((item) => (
            <TaskCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </>
  );
}
