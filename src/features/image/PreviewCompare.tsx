import { LimitNotice } from '../../components/LimitNotice';

/** 原图 / 结果对比预览。两端同一组件（Web 是 File URL，桌面是文件读取后的 URL）。 */
export function PreviewCompare({
  before,
  after,
}: {
  before: string | null;
  after: string | null;
}) {
  if (!before) return null;

  return (
    <div className="row" style={{ alignItems: 'flex-start', gap: 18 }}>
      <figure style={{ margin: 0, flex: '1 1 260px', minWidth: 0 }}>
        <figcaption className="hint mono" style={{ marginBottom: 6 }}>
          / 原图
        </figcaption>
        <img
          src={before}
          alt="原图预览"
          style={{
            width: '100%',
            maxHeight: 260,
            objectFit: 'contain',
            background: 'var(--panel-2)',
            border: '1px solid var(--line)',
            borderRadius: 2,
            display: 'block',
          }}
        />
      </figure>

      <figure style={{ margin: 0, flex: '1 1 260px', minWidth: 0 }}>
        <figcaption className="hint mono" style={{ marginBottom: 6 }}>
          / 结果
        </figcaption>
        {after ? (
          <img
            src={after}
            alt="处理结果预览"
            style={{
              width: '100%',
              maxHeight: 260,
              objectFit: 'contain',
              background: 'var(--panel-2)',
              border: '1px solid var(--cyan-dim)',
              borderRadius: 2,
              display: 'block',
            }}
          />
        ) : (
          <div
            style={{
              height: 180,
              display: 'grid',
              placeItems: 'center',
              background: 'var(--panel-2)',
              border: '1px dashed var(--line)',
              borderRadius: 2,
            }}
          >
            <span className="hint mono">/ 等待处理</span>
          </div>
        )}
      </figure>
    </div>
  );
}

export function BackgroundNotice() {
  return (
    <LimitNotice kind="fidelity" title="透明图转 JPEG/BMP">
      不支持 alpha 的格式会用背景色填充透明区域；默认不透明白。
    </LimitNotice>
  );
}
