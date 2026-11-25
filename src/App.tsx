import { useEffect, useState } from 'react';
import { Layout } from './components/Layout';
import { ImagePage } from './features/image/ImagePage';
import { PdfPage } from './features/pdf/PdfPage';
import { VideoPage } from './features/video/VideoPage';
import { DocumentsPage } from './features/documents/DocumentsPage';
import { CapabilitiesPage } from './features/help/CapabilitiesPage';

/** hash 路由（规格 §16：不依赖服务端 rewrite） */
const ROUTES: Record<string, () => React.ReactElement> = {
  '#/image': () => <ImagePage />,
  '#/pdf': () => <PdfPage />,
  '#/video': () => <VideoPage />,
  '#/documents': () => <DocumentsPage />,
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
