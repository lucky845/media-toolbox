import { LimitNotice } from '../../components/LimitNotice';

/** 原图 / 结果对比预览。两端同一组件（Web 是 File URL，桌面是文件读取后的 URL）。 */
export function PreviewCompare({
  before,
  after,
}: {
  before: string | null;
  after: string | null;
}) {
  if (!before && !after) return null;

  return (
    <div className="image-comparison">
      {before && <figure>
        <figcaption>原图</figcaption>
        <div className="image-preview-frame">
          <img src={before} alt="原图预览" />
        </div>
      </figure>}
      <figure>
        <figcaption>处理结果</figcaption>
        <div className={`image-preview-frame ${after ? 'is-result' : 'is-empty'}`}>
          {after ? <img src={after} alt="处理结果预览" /> : <span className="hint">处理后在这里预览</span>}
        </div>
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
