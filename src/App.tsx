import { useEffect, useState } from 'react';
import { Layout } from './components/Layout';
import { ImagePage } from './features/image/ImagePage';
import { PdfPage } from './features/pdf/PdfPage';
import { VideoPage } from './features/video/VideoPage';
import { DocumentsPage } from './features/documents/DocumentsPage';
import { CapabilitiesPage } from './features/help/CapabilitiesPage';
import { SettingsPage } from './features/activity/SettingsPage';
import { TaskCenterPage } from './features/activity/TaskCenterPage';
import { resolveRoute, type Route } from './navigation';

function Workspace({ route }: { route: Route }) {
  switch (route.group) {
    case 'image': return <ImagePage section={route.section} />;
    case 'pdf': return <PdfPage action={route.section} />;
    case 'video': return <VideoPage />;
    case 'documents': return <DocumentsPage key={route.section} direction={route.section} />;
    case 'help': return <CapabilitiesPage />;
    case 'tasks': return <TaskCenterPage section={route.section} />;
    case 'settings': return <SettingsPage />;
  }
}

export default function App() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const route = resolveRoute(hash);
  return <Layout route={route}><Workspace route={route} /></Layout>;
}
