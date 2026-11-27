import { useQueue } from '../../store/queue';
import { useSettings } from '../../store/settings';
import './activity.css';

const formats = [
  ['jpeg', 'JPEG'],
  ['png', 'PNG'],
  ['webp', 'WebP'],
  ['gif', 'GIF'],
  ['bmp', 'BMP'],
  ['tiff', 'TIFF'],
] as const;

const filters = [
  ['lanczos3', 'Lanczos3（锐利）'],
  ['catmull_rom', 'Catmull-Rom'],
  ['gaussian', '高斯（柔和）'],
  ['triangle', '线性（快）'],
  ['nearest', '最近邻（像素风）'],
] as const;

export function SettingsPage() {
  const settings = useSettings();

  return (
    <div className="activity-workspace">
      <section className="activity-section" aria-labelledby="image-defaults-title">
        <h2 id="image-defaults-title">图片默认设置</h2>
        <div className="activity-settings-row">
          <label htmlFor="default-image-format">输出格式</label>
          <select id="default-image-format" value={settings.format} onChange={(event) => {
            const format = formats.find(([value]) => value === event.currentTarget.value);
            if (format) settings.setFormat(format[0]);
          }}>
            {formats.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        <div className="activity-settings-row">
          <div>
            <label htmlFor="default-jpeg-quality">JPEG 质量</label>
            <p className="hint" id="default-jpeg-quality-hint">仅在输出为 JPEG 时生效。</p>
          </div>
          <div className="activity-range">
            <input
              id="default-jpeg-quality"
              type="range"
              min={1}
              max={100}
              value={settings.quality}
              aria-describedby="default-jpeg-quality-hint"
              onChange={(event) => settings.setQuality(event.currentTarget.valueAsNumber)}
            />
            <span aria-hidden="true">{settings.quality}</span>
          </div>
        </div>
        <div className="activity-settings-row">
          <label htmlFor="default-resize-filter">缩放滤波</label>
          <select id="default-resize-filter" value={settings.filter} onChange={(event) => {
            const filter = filters.find(([value]) => value === event.currentTarget.value);
            if (filter) settings.setFilter(filter[0]);
          }}>
            {filters.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
      </section>
      <section className="activity-section" aria-labelledby="queue-preferences-title">
        <h2 id="queue-preferences-title">任务队列</h2>
        <div className="activity-settings-row">
          <label htmlFor="queue-concurrency">同时处理任务</label>
          <select
            id="queue-concurrency"
            value={useQueue((state) => state.concurrency)}
            onChange={(event) => useQueue.getState().setConcurrency(Number(event.currentTarget.value))}
          >
            <option value={1}>1 个（推荐）</option>
            <option value={2}>2 个</option>
          </select>
        </div>
        <p className="hint">降低并发可减少内存占用；正在运行的任务不会中断。</p>
      </section>
      <section className="activity-section" aria-labelledby="history-privacy-title">
        <h2 id="history-privacy-title">隐私</h2>
        <div className="activity-settings-row">
          <div>
            <label htmlFor="record-task-history">保存最近任务</label>
            <p className="hint" id="record-task-history-hint">
              任务记录仅保存在当前设备。关闭后停止保存新记录，已有记录可在<a href="#/tasks/history">最近任务</a>中删除。
            </p>
          </div>
          <input
            id="record-task-history"
            type="checkbox"
            checked={settings.recordHistory}
            aria-describedby="record-task-history-hint"
            onChange={(event) => settings.setRecordHistory(event.currentTarget.checked)}
          />
        </div>
      </section>
    </div>
  );
}
