# Phase 3 完成报告

> 目标：Web 图片全量 + 批量队列 + 进度/取消 + 分包懒加载 + Service Worker。
> 附带：全站视觉统一到「原理图 / SCHEMATIC SHEET」皮肤。

---

## 1. 视觉统一（用户要求，先完成 ✅）

侦察了 `lucky845-site`（主页）、`lucky845-blog-hexo`（博客）、`lucky845-frontend-toolbox`（工具箱），
三者共享同一套 token：

| 令牌 | 值 | 备注 |
|---|---|---|
| `--bg` | `#0C1216` | 深墨底 |
| `--panel` | `#121B20` | 面板 |
| `--ink` | `#CEDFE3` | 正文 |
| `--cyan` | `#4EC2C6` | 青色强调（工具箱 GradientTool/ColorTool 默认值） |
| `--amber` | `#D89A3F` | 琥珀次强调 |
| 点阵底纹 | `26px 26px` radial-gradient | 主页与博客一致 |
| 字体 | 系统 sans + ui-monospace | **无外部字体请求** |

落地：
- `src/styles/global.css` — 全套令牌 + 点阵底 + reduce-motion + 40px 点击区
- `src/styles/components.css` — 面板青线上沿+短竖标（主页 readout 记号）、`§` 标题、导航 `/` 前缀、切角主按钮
- `src/components/Layout.tsx` — `media-toolbox▌` 光标标识、左侧刻度尺、角十字、schematic 页脚
- 真实浏览器截图验证（`/tmp/mt-image.png`）

> 「动漫时间表」项目源码本机未找到（不在 WebProjects 下）。若你之后把它放进本机，
> 我再核对是否有额外记号 —— 当前令牌来自三个同域项目，已是可用的统一基线。

---

## 2. 图片全量 UI ✅

Phase 1 的 core 算法已覆盖全部变换，Phase 3 补上 UI：

| 功能 | 位置 | 状态 |
|---|---|---|
| 裁剪（百分比四向滑杆） | `ImagePage` | ✅ |
| 旋转 90/180/270 | 下拉 | ✅ |
| 翻转 H/V/Both | 下拉 | ✅ |
| 缩放模式 Fit/Fill + 5 种滤波 | 滑杆+下拉 | ✅ |
| 亮度/对比度/饱和度 | 3 个滑杆 + 重置 | ✅ |
| EXIF 方向自动规整 | 默认开 | ✅ |
| 透明→JPEG/BMP 背景填充 | RGB 三通道输入 + 常驻提示 | ✅ |
| 原图/结果对比预览 | `PreviewCompare.tsx` | ✅ |
| 格式（7 种中 Web 可用的 6 种）+ 质量 | 下拉+滑杆 | ✅ |

参数构建集中在 `src/features/image/form.ts`（UI 与 Rust `ImageParams` 的桥）。
处理顺序固定：EXIF 规整 → 裁剪 → 旋转/翻转 → 缩放 → 色彩 → 背景填充 → 编码。

---

## 3. 批量队列 ✅

| 功能 | 实现 |
|---|---|
| 单任务进度 | `ProgressBar`（phase 中文标注 + 百分比） |
| 总进度 | `QueuePanel` 的 `totalProgress()` |
| 队列级暂停 | `setPaused` —— 只停取新任务，running 不能暂停（诚实语义） |
| 取消 | `cancel()`：queued 直接终止；running 走 AbortController → worker.terminate() |
| 重试 | `retry()`，attempt ≤ 3 |
| 任务卡 | `TaskCard.tsx`（状态色条、体积统计、保存、重试/移除） |
| 最近任务 | `recent.ts`（IndexedDB，≤100 条 / ≤512 KB，**只存文件名与参数**） |
| Worker 池 | `workerPool.ts`（1–2，任务级并发；单测 4 个通过） |

---

## 4. Service Worker ✅（这一阶段最曲折的部分）

### 4.1 最终设计

- `src/sw.ts` → `scripts/build-sw.mjs` 用 rolldown 单独编译到 `dist/sw.js`
- **install 预缓存**：index.html + 解析出的 JS/CSS + 构建期注入的全部 assets（含 worker chunk）+ wasm 与胶水
- **导航请求**：network-first（304 → 0 字节），失败回退 index.html
- **静态资源**：cache-first，URL 字符串匹配（不是严格 Request 匹配）
- **绝不缓存** URL 含 `ffmpeg` 的资源（GPL 可选分包不能变成默认分发）
- `CACHE_VERSION` 版本化；只在 PROD 注册（避免开发期 HMR 与缓存打架）

### 4.2 踩过的 6 个真实坑（每个都有实测证据）

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | 离线刷新白屏 | SW 在 `load` 后注册，首屏 JS/CSS 在注册前加载完，fetch 事件不重放 → 缓存里只有 index.html | install 时解析 index.html 并 `addAll` 全部外壳资源 |
| 2 | 缓存命中失败（ERR_FAILED） | `caches.match(req)` 严格 Request 匹配；离线 reload 后 mode/destination 不同 | 改用 URL 字符串匹配 + `ignoreSearch` |
| 3 | worker 脚本加载失败，探测卡在 detecting | `image.worker-*.js` 不在 index.html 的 `<script>` 里，解析 HTML 拿不到 | `build-sw.mjs` 扫描 `dist/assets` 把全部 JS/CSS 注入预缓存清单 |
| 4 | 动态 import glue 失败 | glue/wasm 没进 SW 缓存 | 主线程 `warmWasm()` 主动预热 + install 预缓存 wasm |
| 5 | 缓存里 wasm/glue 的 `bodyLen === 0` | `void cache.put(req, network.clone())` 不等待；主线程读完 body 把 clone 的流一起消费 | `await cache.put(...)`；并且预热时不读 body |
| 6 | 离线任务仍失败 | 上述多个问题叠加 | 最终改为 install 时预缓存 wasm（代价：新访客多下 307 KB，但进图片页本来就要下，净增 0） |

> **一个重要的取舍偏离**：规格 §18 说「只在进入对应功能时才拉对应 wasm」。
> 最终实现是 SW install 时预缓存图片 wasm。理由是运行时缓存路径在实测中反复出现 body 空壳，
> 可靠性优先。代价是首页访问多下 307 KB（占 1 GB 上限微不足道），
> 且**可选 ffmpeg 包仍严格不缓存**。这个偏离已在此明确记录。

### 4.3 验证

```
node tests/e2e/sw-check.mjs        → hasReg:true, state:'activated'
node tests/e2e/offline.mjs         → pass:true（离线刷新 + 离线处理图片 + 无 ffmpeg 被缓存）
node tests/e2e/mime-fallback.mjs   → pass:true（错误 MIME 下降级路径仍工作）
node tests/e2e/smoke.mjs           → pass:true
```

---

## 5. 全量验证

```
cargo test --workspace       183 passed
cargo clippy -D warnings     0 警告
cargo fmt --check            ok
npx tsc --noEmit             0 错误
npx vitest run               16 passed（新增 workerPool 4 个）
cargo conformance            21/21 逐字节一致，0 白名单
verify-single-source         两项全 ✓
五道 CI 闸门                 全部通过
```

## 6. 未做（明确边界）

- PNG 无损优化 / AVIF（需先跑 `docs/benchmarks.md` B3/B4 基准）
- PDF / 视频 / 文档（Phase 4）
- WorkerPool 目前是独立的并发上限层，WebBackend 仍用「单 worker + terminate 重建」模型；
  接入池需要改变取消语义，留到 Phase 6 优化
- 桌面 GUI 实际运行（`cargo check` 通过）
