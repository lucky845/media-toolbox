import { useEffect, useRef, useState } from 'react';
import { QueuePanel } from '../../components/QueuePanel';
import { formatBytes } from '../../lib/errors';
import type { ActivityRoute } from '../../navigation';
import { isActive, TASK_LABELS, useQueue } from '../../store/queue';
import { clearTasks, deleteTask, listTasks, onRecentChange, type RecentTask } from '../../store/recent';
import { useSettings } from '../../store/settings';
import './activity.css';

const outcomes = { succeeded: '成功', failed: '失败', cancelled: '已取消' };
const taskLabels: Readonly<Partial<Record<string, string>>> = TASK_LABELS;
const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });

export function TaskCenterPage({ section }: { section: ActivityRoute['section'] }) {
  return (
    <div className="activity-workspace">
      <nav className="activity-nav" aria-label="任务中心视图">
        <a href="#/tasks/queue" aria-current={section === 'queue' ? 'page' : undefined}>任务队列</a>
        <a href="#/tasks/history" aria-current={section === 'history' ? 'page' : undefined}>最近任务</a>
      </nav>
      {section === 'queue' ? <TaskQueue /> : <TaskHistory />}
    </div>
  );
}

function TaskQueue() {
  const items = useQueue((state) => state.items);
  const paused = useQueue((state) => state.paused);
  const setPaused = useQueue((state) => state.setPaused);
  const clearFinished = useQueue((state) => state.clearFinished);

  return (
    <div className="activity-queue">
      {items.every((item) => !isActive(item)) && (
        <div className="activity-section row">
          <p>{paused ? '队列已暂停。' : '新任务会自动开始。'}</p>
          <button type="button" className="ghost" onClick={() => setPaused(!paused)}>
            {paused ? '继续队列' : '暂停队列（不取新任务）'}
          </button>
        </div>
      )}
      <QueuePanel
        active={items.filter(isActive)}
        finished={items.filter((item) => !isActive(item))}
        paused={paused}
        onPause={() => setPaused(!paused)}
        onClear={() => clearFinished()}
      />
      {items.length === 0 && (
        <div className="activity-section activity-empty">
          <h2>队列中暂无任务</h2>
          <p className="hint">从工具栏目选择一项工具并开始处理，任务会显示在这里。</p>
        </div>
      )}
    </div>
  );
}

function TaskHistory() {
  const [entries, setEntries] = useState<RecentTask[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [mutationError, setMutationError] = useState(false);
  const recordHistory = useSettings((state) => state.recordHistory);
  const confirmRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let request = 0;
    const refresh = async () => {
      const current = ++request;
      const tasks = await listTasks();
      if (current === request) setEntries(tasks);
    };
    const unsubscribe = onRecentChange(() => { void refresh(); });
    void refresh();
    return () => {
      request++;
      unsubscribe();
    };
  }, []);

  async function changeHistory(operation: () => Promise<void>) {
    setSaving(true);
    setMutationError(false);
    try {
      await operation();
      headingRef.current?.focus({ preventScroll: true });
    } catch {
      setMutationError(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="activity-section" aria-labelledby="task-history-title">
      <div className="activity-history-header">
        <div>
          <h2 id="task-history-title" ref={headingRef} tabIndex={-1}>本机任务记录</h2>
          <p className="hint">{recordHistory ? '记录文件名、任务类型和处理结果。' : '已暂停记录新任务。'} <a href="#/settings">隐私设置</a></p>
        </div>
        {Boolean(entries?.length) && (
          <button
            type="button"
            className="danger"
            disabled={saving}
            onClick={() => confirmRef.current?.showModal()}
          >清空历史</button>
        )}
      </div>
      {mutationError && <p className="notice danger" role="alert">无法删除历史记录，请重试。</p>}
      {entries === null && <p className="hint" role="status">正在读取任务记录…</p>}
      {entries?.length === 0 && <p className="hint" role="status">暂无历史记录。</p>}
      {!!entries?.length && (
        <ul className="activity-history-list">
          {entries.map((entry) => (
            <li key={entry.id}>
              <div className="activity-history-entry">
                <h3>{entry.fileNames.join('、') || '未命名文件'}</h3>
                <div className="activity-history-meta hint">
                  <span>{taskLabels[entry.kind] ?? entry.kind}</span>
                  <time dateTime={new Date(entry.createdAt).toISOString()}>{dateFormat.format(entry.createdAt)}</time>
                  {entry.inputBytes !== undefined && <span>输入 {formatBytes(entry.inputBytes)}</span>}
                  {entry.outputBytes !== undefined && <span>输出 {formatBytes(entry.outputBytes)}</span>}
                  {entry.errorCode && <span>{entry.errorCode}</span>}
                </div>
              </div>
              <span className="activity-outcome" data-outcome={entry.outcome}>{outcomes[entry.outcome]}</span>
              <button
                type="button"
                className="ghost"
                aria-label={`删除记录：${entry.fileNames.join('、') || '未命名文件'}`}
                disabled={saving}
                onClick={() => { void changeHistory(() => deleteTask(entry.id)); }}
              >删除</button>
            </li>
          ))}
        </ul>
      )}
      <dialog ref={confirmRef} className="activity-dialog" aria-labelledby="clear-history-title" aria-describedby="clear-history-description">
        <h2 id="clear-history-title">清空历史记录？</h2>
        <p className="hint" id="clear-history-description">所有本机任务记录都会被删除。</p>
        <form className="activity-dialog-actions" method="dialog" onSubmit={(event) => {
          const submitter = (event.nativeEvent as SubmitEvent).submitter;
          if (submitter?.getAttribute('value') === 'clear') {
            void changeHistory(clearTasks);
          }
        }}>
          <button type="submit" value="cancel" autoFocus>取消</button>
          <button type="submit" value="clear" className="danger">清空历史</button>
        </form>
      </dialog>
    </section>
  );
}
