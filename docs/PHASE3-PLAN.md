# Phase 3 — Web 图片全量 + 批量队列 + 进度/取消 + 分包懒加载 + Service Worker

> 前置：Phase 1（双端跑通的图片压缩）与 Phase 2（部署链路本机验证）已完成。
> 本阶段的硬要求：**features/ 里不出现按壳分支**（CI 已强制），所有 UI 复用同一份。

---

## 0. 视觉风格统一（本阶段开始时完成 ✅）

用户要求 GitHub Pages 风格与主页 / 博客 / 前端工具箱统一。已侦察三个项目的共享设计令牌：

| 令牌 | 值 | 来源 |
|---|---|---|
| `--bg` | `#0C1216` | 主页 `global.css`、博客 `schematic.css` dark |
| `--panel` | `#121B20` | 同上 |
| `--ink` | `#CEDFE3` | 同上 |
| `--soft` / `--dim` | `#A7BCC2` / `#6B8189` | 同上 |
| `--line` / `--line-soft` | `#1F2C33` / `#18252C` | 同上 |
| `--cyan`（强调） | `#4EC2C6` | 主页、博客、前端工具箱（GradientTool/ColorTool 默认值） |
| `--amber`（次强调） | `#D89A3F` | 主页 `h1 em`、博客 dark accent |
| 点阵底纹 | `26px 26px` radial-gradient | 主页与博客一致 |
| 字体 | 系统 sans + ui-monospace | 三者一致，**无外部字体请求** |

已改文件：
- `src/styles/global.css` — 全量替换为「原理图 / SCHEMATIC SHEET」令牌
- `src/styles/components.css` — 面板上沿青线+短竖标（主页 readout 记号）、`§` 标题前缀、导航 `/` 前缀、切角主按钮
- `src/components/Layout.tsx` — `media-toolbox▌` 光标标识、左侧刻度尺、角十字记号、schematic 页脚

已验证：`npx tsc --noEmit`、`vite build`、e2e smoke 全通过；截图存于 `/tmp/mt-image.png`。

> 备注：「动漫时间表」项目的源码本机未找到（在别的机器或仓库），但其域名同属 `lucky845.top`，
> 上述令牌来自另外三个同域项目，已是当前可用的统一基线。若你之后把那个项目也放进本机，
> 我再核对是否有额外记号。

---

## 1. 本阶段目标

| 项 | Phase 1 状态 | Phase 3 目标 |
|---|---|---|
| 图片变换 | core 已全部实现（裁剪/旋转/翻转/色彩/EXIF/5 种滤波），UI 只暴露缩放+格式+质量 | UI 全量暴露，参数可组合 |
| 批量队列 | 骨架已有（queue store、去重、重试） | 完整验证：单任务/总进度、暂停、取消、重试、覆盖确认 |
| 进度 | worker 已上报 | 节流验证（100ms）、phase 变化立即发送、100% 必达 |
| 取消 | `worker.terminate()` | 3 秒内 settle、无残留 worker、UI 文案与 `cancel.hard` 一致 |
| 分包 | 单一 `core_image.wasm` | 进入图片页才拉 wasm（不与首屏一起加载） |
| SW | 未实现，UI 如实显示「尚未缓存」 | 实现并激活，UI 改为「已缓存，可离线使用」 |

---

## 2. 要改的文件

```
src/features/image/ImagePage.tsx        # 加裁剪/旋转/翻转/色彩/背景/EXIF 开关 UI
src/features/image/PreviewCompare.tsx   # 新：原图/结果对比（同一组件两壳共用）
src/components/QueuePanel.tsx           # 新：总进度 + 批量操作
src/components/TaskCard.tsx             # 新（从 ImagePage 内抽出来）
src/store/queue.ts                       # 补覆盖确认、命名规则、保存回调
src/store/recent.ts                      # 新：IndexedDB，只存文件名+参数
src/lib/backend/web/workerPool.ts        # 新：Worker 池（1–2）
src/sw.ts                                # 新：应用外壳 + 分包缓存
public/manifest.webmanifest              # 新
src/main.tsx                             # 注册 SW
tests/{protocol,limits,cancel,sw}.test.ts
```

core 与 Backend 接口**不改**（Phase 1 已验证稳定）。

---

## 3. 分包策略（规格 §18）

当前构建已满足「分包」的一半：`core_image.wasm` 由 Worker 在 `init` 时 fetch，
不在首屏模块图里（vite 产物可见它在 `public/wasm/`，不在 JS chunk 里）。

本阶段补强：

1. **首屏不加载 wasm**：`getBackend()` 在 App 启动时只做能力探测（不需要 wasm），
   wasm 只在 `ImagePage` 第一次 `probe()`/`run()` 时由 worker 加载。
2. **SW 预缓存应用外壳**：`index.html` + 入口 JS/CSS + 图标；
   **不预缓存** wasm（避免新访客多下 307 KB，也避免把可选 ffmpeg 包缓存进去）。
3. **SW 运行时缓存分包**：用户进入图片页后，`core_image.wasm` 与胶水按 URL 缓存；
   内容寻址文件名带 hash，用 cache-first。
4. **版本化**：`CACHE_VERSION` 常量写在 `src/sw.ts`，改一次全量失效一次。
5. **回头客零流量**：外壳 network-first（拿 304 即 0 字节），分包 cache-first。

## 4. Service Worker 注册时机

`main.tsx` 里：

```ts
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
  });
}
```

只在 PROD 注册：开发期 Vite HMR 与 SW 缓存会打架（这是真实踩过的坑）。
注册成功后 `capabilities().offline.installed` 才会变 true，UI 文案同步更新 —— Phase 1 已把
这个「诚实性」逻辑做好，这里只要让事实追上文案。

---

## 5. 验收命令

```bash
npx tsc --noEmit && npx vitest run
npx vite build
node tests/e2e/smoke.mjs http://localhost:4173
node tests/e2e/sw-check.mjs         # 期望 hasReg:true, state:'activated'
node tests/e2e/mime-fallback.mjs
# 手动：
#   - 首页 Network 里不应出现 core_image_bg.wasm
#   - 进入图片页才出现；切 offline 后刷新仍可用
#   - 拖 10 张图 → 单任务与总进度都推进；取消一张不影响其他
#   - 取消 → 3 秒内变「已取消」，worker 数归零
```

## 6. 门禁

- `check-no-branching` 必须继续通过（UI 不得按壳分支）
- SW **不缓存**任何 URL 含 `ffmpeg` 的资源（避免把 GPL 组件变成默认分发）
- IndexedDB 只存文件名+参数，写入前检查 JSON 大小（≤512 KB / ≤100 条）
