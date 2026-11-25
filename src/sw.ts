/// <reference lib="webworker" />

// Service Worker：应用外壳 + 按功能分包缓存（规格 §18）。
//
// 设计要点：
// 1. **只缓存本站资源**。install/activate 里不预取 wasm —— 新访客不该为没用的功能付费。
// 2. wasm 与 JS chunk 内容寻址（文件名带 hash）→ cache-first；
//    index.html network-first（拿 304 即 0 字节）。
// 3. **绝不缓存 URL 含 ffmpeg 的资源** —— 那是用户点击才下载的 GPL 可选分包，
//    缓存它会让它变成「默认分发」，违背许可与流量预算。
// 4. 版本化 CACHE_VERSION：改一次，旧缓存全清。
// 5. GitHub Pages 全站 cache-control: max-age=600 —— 回头客零流量只能靠这里。

// 由 scripts/build-sw.mjs 在构建时注入：dist/assets 下全部 JS/CSS（含 worker chunk）。
// 这些文件不在 index.html 的 <script> 标签里，解析 HTML 拿不到，必须显式预缓存。
declare const self: ServiceWorkerGlobalScope & { __MT_EXTRA_ASSETS__?: string[] };

const CACHE_VERSION = 'v1-phase4b-pdfjs';
const SHELL_CACHE = `mt-shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = `mt-runtime-${CACHE_VERSION}`;

const sw = self as unknown as ServiceWorkerGlobalScope;
// 自定义域 → '/'；项目页 → '/<repo>/'
const BASE = sw.registration.scope;

/** 始终走网络的应用外壳入口 */
const SHELL_ENTRY = new URL('index.html', BASE).href;

/** 是否是要缓存的同源资源 */
function isSameOrigin(url: string): boolean {
  return url.startsWith(self.location.origin) || url.startsWith(BASE);
}

/** 禁止缓存的路径（GPL 可选分包等） */
function mustNotCache(url: string): boolean {
  return /ffmpeg/i.test(url) || url.includes('/api/');
}



sw.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);

      // 关键坑：SW 是在 window.load 之后才注册的，首屏 JS/CSS 在注册之前就加载完了，
      // fetch 事件不会「重放」那些请求 —— 如果只靠 fetch 事件缓存，离线刷新会白屏
      // （实测：缓存里只有 index.html + wasm，没有 JS chunk）。
      //
      // 所以 install 时要主动预缓存整个应用外壳：
      //   1. 抓 index.html，解析出它引用的 script/style；
      //   2. 连同入口一起 addAll；
      //   3. wasm 不在这里预取（新访客不该为没用的功能付费；进入图片页时由 fetch 缓存）。
      try {
        const res = await fetch(SHELL_ENTRY, { cache: 'reload' });
        if (res.ok) {
          const html = await res.text();
          const urls = new Set<string>([SHELL_ENTRY]);

          // 匹配 Vite 产出的 <script src="..."> 与 <link rel=... href="...">
          // 只取同源、非 ffmpeg 的资源
          for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
            const u = new URL(m[1]!, SHELL_ENTRY).href;
            if (isSameOrigin(u) && !mustNotCache(u)) urls.add(u);
          }
          // 构建期注入的 assets（含 worker chunk）
          for (const rel of self.__MT_EXTRA_ASSETS__ ?? []) {
            const u = new URL(rel, BASE).href;
            if (isSameOrigin(u) && !mustNotCache(u)) urls.add(u);
          }

          // Promise.allSettled：某个 chunk 404 不让整个 install 失败
          await Promise.allSettled(
            [...urls].map((u) => cache.add(new Request(u, { cache: 'reload' }))),
          );
          // index.html 可能已被 addAll 之外的方式改动，确保缓存的是最新版
          await cache.put(SHELL_ENTRY, new Response(html, {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          }));
        }
      } catch {
        // 完全拿不到入口也不能让 install 失败；下次访问 network-first 会补
      }

      await sw.skipWaiting();
    })(),
  );
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith('mt-') && k !== SHELL_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k)),
      );
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  if (!isSameOrigin(req.url) || mustNotCache(req.url)) return;
  const url = new URL(req.url);

  // 导航请求（含 hash 路由的页面刷新）：network-first，拿到 304 即 0 字节
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const network = await fetch(req);
          if (network.ok) {
            const cache = await caches.open(SHELL_CACHE);
            await cache.put(SHELL_ENTRY, network.clone());
          }
          return network;
        } catch {
          return (
            (await caches.match(SHELL_ENTRY)) ??
            (await caches.match(req)) ??
            Response.error()
          );
        }
      })(),
    );
    return;
  }

  // 静态资源（js/css/wasm/svg/字体）：cache-first
  // 用 URL 字符串显式匹配而不是 caches.match(req)：
  // 离线 reload 后，同一资源的 Request 可能带不同的 mode/destination，
  // 严格 Request 匹配会漏掉，导致本该命中的缓存变成 ERR_FAILED（实测踩过）。
  event.respondWith(
    (async () => {
      const cached =
        (await caches.match(req, { ignoreSearch: true })) ??
        (await caches.match(new Request(url.href), { ignoreSearch: true }));
      if (cached) return cached;

      try {
        const network = await fetch(req);
        if (network.ok && network.type === 'basic') {
          const cache = await caches.open(RUNTIME_CACHE);
          // 必须 await cache.put：如果只 `void cache.put(...)` 就返回，
          // 主线程会立刻读取 network.body，导致 clone 出的流被一起消费，
          // 缓存里留下一个 body 长度为 0 的空壳（实测 glue.js bodyLen=0，
          // 离线时动态 import 报 "Failed to fetch dynamically imported module"）。
          await cache.put(req, network.clone());
        }
        return network;
      } catch {
        return Response.error();
      }
    })(),
  );
});

// 让 TypeScript 认识 addEventListener 的类型
export {};
