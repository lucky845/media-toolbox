import type { Progress } from '../lib/backend/types';

const PHASE_LABEL: Record<Progress['phase'], string> = {
  queued: '排队中',
  decoding: '解码',
  transforming: '变换',
  encoding: '编码',
  writing: '写入',
  optimizing: '优化',
  finalizing: '收尾',
};

export function ProgressBar({ progress }: { progress: Progress | null }) {
  if (!progress) {
    return <div className="hint">等待中…</div>;
  }
  const pct =
    progress.total > 0 ? Math.min(100, (progress.done / progress.total) * 100) : 0;
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 5 }}>
        <span className="hint">{PHASE_LABEL[progress.phase]}</span>
        <span className="hint mono">
          {progress.total > 0 ? `${pct.toFixed(0)}%` : '处理中'}
        </span>
      </div>
      <div
        className="progress"
        role="progressbar"
        aria-valuenow={progress.total > 0 ? Math.round(pct) : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="任务进度"
      >
        <div style={{ width: `${progress.total > 0 ? pct : 30}%` }} />
      </div>
    </div>
  );
}
