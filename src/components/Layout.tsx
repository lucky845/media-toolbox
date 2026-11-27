import { useEffect, useRef, useState } from 'react';
import { TOOL_GROUPS, type Route, type ToolRoute } from '../navigation';
import { useCapabilities } from '../store/capabilities';
import { BrandMark } from './BrandMark';
import { ToolIcon } from './ToolIcon';

export function Layout({ route, children }: { route: Route; children: React.ReactNode }) {
  const mainRef = useRef<HTMLElement>(null);
  const group = TOOL_GROUPS.find((item) => item.id === route.group);
  const tool = group?.tools.find((item) => item.id === route.section);
  const toolGroupId = group?.id;
  const workspaceTitle = tool?.label
    ?? (route.group === 'tasks' ? '任务中心' : route.group === 'settings' ? '设置' : '能力与限制');
  const [expanded, setExpanded] = useState<Partial<Record<ToolRoute['group'], boolean>>>({});
  const [mobileGroup, setMobileGroup] = useState<ToolRoute['group'] | null>(group?.id ?? null);
  useEffect(() => {
    if (!toolGroupId) {
      setMobileGroup(null);
      return;
    }
    setExpanded((current) => ({ ...current, [toolGroupId]: true }));
    setMobileGroup(toolGroupId);
  }, [toolGroupId, route.section]);
  useEffect(() => {
    mainRef.current?.scrollTo(0, 0);
  }, [route.group, route.section]);
  const { status, summary, error, load } = useCapabilities();

  useEffect(() => {
    void load();
  }, [load]);

  // Service Worker 激活是异步的，通常晚于首次 load()。
  // 激活后重新取一次能力，让「离线」状态从不实变为准确。
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const sw = navigator.serviceWorker;
    let stopped = false;
    let watched: ServiceWorker | null = null;
    const onStateChange = () => {
      if (!stopped && watched?.state === 'activated') void load();
    };
    const observe = (worker: ServiceWorker | null) => {
      watched?.removeEventListener('statechange', onStateChange);
      watched = worker;
      watched?.addEventListener('statechange', onStateChange);
      onStateChange();
    };
    const onControllerChange = () => observe(sw.controller);
    sw.addEventListener('controllerchange', onControllerChange);
    onControllerChange();
    // ready also covers active registrations that have not claimed this page.
    void sw.ready.then((reg) => {
      if (!stopped && !sw.controller) observe(reg.active);
    });
    return () => {
      stopped = true;
      sw.removeEventListener('controllerchange', onControllerChange);
      watched?.removeEventListener('statechange', onStateChange);
    };
  }, [load]);

  return (
    <div className="layout">
      <header className="topbar">
        <a className="brand" href="#/image">
          <BrandMark />
          <span>多媒体工具箱</span>
        </a>
        <div className="topbar-actions">
          <div className="runtime-status" aria-live="polite">
            {status === 'loading' && <span className="badge">正在探测能力…</span>}
            {status === 'ready' && summary && (
              <span className={`badge ${summary.tone}`}>{summary.label}</span>
            )}
            {status === 'failed' && <span className="badge err">能力探测失败</span>}
          </div>
          <nav className="workspace-links" aria-label="工作区">
            <a className="help-link" href="#/tasks/queue" aria-current={route.group === 'tasks' ? 'location' : undefined}>
              任务中心
            </a>
            <a className="help-link" href="#/settings" aria-current={route.group === 'settings' ? 'page' : undefined}>
              设置
            </a>
            <a className="help-link" href="#/help" aria-current={route.group === 'help' ? 'page' : undefined}>
              能力与限制
            </a>
          </nav>
        </div>
      </header>

      <div className="workspace-shell">
        <nav className="tool-sidebar" aria-label="工具栏目">
          <ul className="mobile-tool-groups">
            {TOOL_GROUPS.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="tool-group-trigger"
                  aria-controls={`tools-${item.id}`}
                  aria-expanded={mobileGroup === item.id}
                  aria-current={route.group === item.id ? 'true' : undefined}
                  onClick={() => setMobileGroup((current) => current === item.id ? null : item.id)}
                >
                  <span className="tool-group-icon"><ToolIcon name={item.id} /></span>
                  <span>{item.label}</span>
                  <span className="tool-chevron" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          {TOOL_GROUPS.map((item) => {
            const isCurrent = route.group === item.id;
            const isExpanded = expanded[item.id] ?? isCurrent;
            return (
              <div className="tool-group" key={item.id}>
                <h2 className="tool-group-heading">
                  <button
                    type="button"
                    className="tool-group-trigger"
                    aria-controls={`tools-${item.id}`}
                    aria-expanded={isExpanded}
                    aria-current={isCurrent ? 'true' : undefined}
                    onClick={() => setExpanded((current) => ({
                      ...current,
                      [item.id]: !(current[item.id] ?? isCurrent),
                    }))}
                  >
                    <span className="tool-group-icon"><ToolIcon name={item.id} /></span>
                    <span>{item.label}</span>
                    <span className="tool-chevron" aria-hidden="true" />
                  </button>
                </h2>
                <ul
                  id={`tools-${item.id}`}
                  className="tool-list"
                  data-expanded={isExpanded}
                  data-mobile-expanded={mobileGroup === item.id}
                >
                  {item.tools.map((entry) => (
                    <li key={entry.id}>
                      <a
                        href={`#/${item.id}/${entry.id}`}
                        aria-current={isCurrent && route.section === entry.id ? 'page' : undefined}
                      >
                        <ToolIcon name={entry.id} />
                        <span>{entry.label}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </nav>
        <main ref={mainRef} className="workspace-main" aria-labelledby="workspace-title">
          <div className="workspace-content">
            {group && <p className="workspace-category">{group.label}</p>}
            <h1 id="workspace-title">{workspaceTitle}</h1>
            {status === 'failed' && (
              <div className="notice danger capability-error">
                <span aria-hidden="true">✕</span>
                <div>
                  <strong>核心模块未能加载，已进入受限模式。</strong>
                  <div className="hint">{error?.message ?? '未知原因'}</div>
                  {error?.detail && <div className="mono">{error.detail}</div>}
                </div>
              </div>
            )}
            {children}
            <footer className="footer">所有处理都在你的设备上完成，文件不会上传。</footer>
          </div>
        </main>
      </div>
    </div>
  );
}
