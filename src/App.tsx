import { useEffect, useState } from 'react';
import { Layout } from './components/Layout';
import { ImagePage } from './features/image/ImagePage';
import { CapabilitiesPage } from './features/help/CapabilitiesPage';
import { PlaceholderPage } from './features/help/PlaceholderPage';

/** hash 路由（规格 §16：不依赖服务端 rewrite） */
const ROUTES: Record<string, () => React.ReactElement> = {
  '#/image': () => <ImagePage />,
  '#/pdf': () => (
    <PlaceholderPage
      title="PDF 工具"
      phase="Phase 4"
      description="PDF → 图片、合并、拆分、旋转、提取文本与图片。核心算法（lopdf）与渲染器（pdf.js）将在 Phase 4 接入。"
    />
  ),
  '#/video': () => (
    <PlaceholderPage
      title="视频工具"
      phase="Phase 4"
      description="WebCodecs 优先的轻量转码 + 可选 ffmpeg.wasm 降级。桌面版走 FFmpeg sidecar。"
    />
  ),
  '#/documents': () => (
    <PlaceholderPage
      title="文档转换"
      phase="Phase 4"
      description="Word ↔ PDF。在线版只做结构化转换；桌面版用 LibreOffice headless。"
    />
  ),
  '#/help': () => <CapabilitiesPage />,
};

function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash || '#/image');
  useEffect(() => {
    const onHash = () => setHash(window.location.hash || '#/image');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return hash;
}

export default function App() {
  const hash = useHashRoute();
  const page = ROUTES[hash] ?? ROUTES['#/image']!;

  return <Layout>{page()}</Layout>;
}
