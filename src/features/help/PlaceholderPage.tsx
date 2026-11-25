export function PlaceholderPage({
  title,
  phase,
  description,
}: {
  title: string;
  phase: string;
  description: string;
}) {
  return (
    <div className="card">
      <h2>{title}</h2>
      <p className="hint">{description}</p>
      <div className="notice info" style={{ marginTop: 14 }}>
        <span aria-hidden="true">ℹ️</span>
        <div>
          <strong>这一部分计划在 {phase} 交付</strong>
          <div className="hint" style={{ marginTop: 4 }}>
            当前是 Phase 1：只做图片压缩，但两端（Web wasm / Tauri native）已经完整跑通，
            核心算法只有一份。<a href="#/help">查看当前能力与限制</a>
          </div>
        </div>
      </div>
    </div>
  );
}
