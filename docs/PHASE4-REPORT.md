# Phase 4 完成报告（部分：结构操作 + 保真度声明）

> 目标：Web 轻量视频 + 轻量文档 + 「能力与限制」页完善。
> 本次交付：PDF 结构操作（wasm）、Word↔PDF 结构化转换骨架、**常驻保真度声明**、
> 视频能力探测与 GPL 降级说明。WebCodecs 转码管线标注为 Phase 4b（未接入）；
> pdf.js 按页渲染在 Phase 4b 已接入（见 §7）。

---

## 1. core 新增纯函数模块

| 模块 | 文件 | 测试 | 说明 |
|---|---|---|---|
| PDF 结构操作 | `crates/core/src/pdf/ops.rs` | 10 个 | 合并/拆分/旋转/提取页/提取文本/提取图片/探测；lopdf 0.47，纯字节 |
| 视频 argv + 进度 | `crates/core/src/video/args.rs` | 11 个 | 强类型 argv 构造（杜绝注入）、ProgressParser、ffprobe 解析 |
| 文档结构化 | `crates/core/src/office/mod.rs` | 5 个 | 段落结构化 + 保真度声明文本 |

core 测试总数：**141 → 209**（+68）。

### 关键设计

- `build_transcode_args` 只接受强类型参数，**硬件编码器有白名单**
  （`h264_videotoolbox` / `h264_nvenc` / `libvpx-vp9` 等），防止 argv 注入 —— 桌面端
  Tauri Shell sidecar 若接受任意参数就成了任意命令执行入口。
- `ProgressParser` 逐行解析 `-progress pipe:1`，两端共用（Web ffmpeg.wasm 降级与桌面 sidecar）。
- PDF 页面树按 `/Kids` 递归遍历保持真实页序（`get_pages()` 按 object id 排序不保证页序）。

## 2. wasm 分包

`scripts/build-wasm.mjs --all` 现在产出两个包：

| 包 | feature | raw | gzip | brotli |
|---|---|---|---|---|
| `core_image` | image | 1256 KB | 390 KB | 307 KB |
| `core_doc` | doc,video,office | 1981 KB | 687 KB | **531 KB** |

新增 `scripts/copy-wasm.mjs`（CI/本地统一拷贝）。SW 已把两个包的 wasm 都纳入预缓存。

## 3. 前端页面

| 页面 | 功能 | 状态 |
|---|---|---|
| PDF (`#/pdf`) | 上传探测、旋转、拆分、提取文本/图片、合并 | ✅ e2e 通过 |
| 文档 (`#/documents`) | Word↔PDF 结构化入口 + **常驻保真度声明** | ✅ |
| 视频 (`#/video`) | 能力探测结论、WebCodecs 说明、GPL 降级说明 | ✅（管线 Phase 4b） |
| 能力与限制 (`#/help`) | 逐项真实状态 + 限制原因 | ✅ 已校正不实表述 |

PDF 端到端测试（`tests/e2e/pdf.mjs`）：上传 3 页 PDF → 探测页数 → 旋转 → 生成 802 B 文件，0 错误。

### 诚实性校正

能力页原先写「PDF→图片 ✅」但实际未接 pdf.js 渲染，已改为「⚠️ 渲染管线 Phase 4b 待接入」。
视频写「WebCodecs 管线 Phase 4b」，明确「不假装能转」。

## 4. 许可证与保真度（规格 §15/§24 的硬交付）

- Word↔PDF 页面**常驻**声明：嵌入字体、分栏、浮动图形、页眉页脚、脚注、批注、修订、域、
  复杂表格、目录、公式会丢失；**不承诺无损**。
- 视频页说明：`@ffmpeg/core` 是 **GPL-2.0-or-later**，默认不加载不预取，点击前有说明与源码地址。
- `THIRD_PARTY_NOTICES.md` 的 `check-notices` 闸门继续全绿。

## 5. 验证

```
cargo test --workspace            209 passed
cargo clippy -D warnings (含 --all-features)   0 警告
cargo fmt --check                 ok
npx tsc --noEmit                  0 错误
npx vitest run                    16 passed
一致性                            21/21，0 白名单
五道闸门                          全绿
e2e: smoke / pdf / mime / offline 4 项全通过
```

## 6. 明确未做（Phase 4b 及以后）

- **WebCodecs 转码管线**：4b 接入（当前只探测能力、不执行）
- 可选 ffmpeg.wasm 实际降级按钮（GPL 声明与包已规划，未接执行）
- 完整 mammoth→pdf-lib 的 docx→pdf 文件生成（当前产出结构化 JSON 中间产物）
- 桌面端 LibreOffice 调用（Phase 5）

---

## 7. Phase 4b：PDF → 图片渲染（已接入）

### 7.1 架构决策：为什么不用专用 Worker

最初计划做 `pdfRender.worker.ts`（把 pdf.js 塞进专用 Worker）。在真实 Chromium 中做原型验证
（`/tmp/mt-pdfproto/`）后发现三条死路，已记录在 `src/lib/backend/web/pdfRenderBackend.ts` 顶部注释：

1. pdf.js 6.x ESM 构建强制要求 `GlobalWorkerOptions.workerSrc`，`getDocument` 会在调用方上下文
   里再 `new Worker(pdf.worker.min.mjs, { type:'module' })`。在专用 Worker 内派生嵌套 Worker 后，
   握手消息无法被内部 MessageHandler 消费，`task.promise` **永久挂起**。
2. worker 侧渲染（`rendererSrc`）依赖 `globalThis.document.fonts`，专用 Worker 里没有 document。
3. 默认 `DOMCanvasFactory` 也依赖 `document.createElement("canvas")`。

最终方案：**主线程动态 import pdf.js（独立懒加载 chunk）** + pdf.js 自带的解析 Worker（解析本就在
独立线程，天然不阻塞主线程）+ 逐页渲染到 `OffscreenCanvas` + 页间 `setTimeout(0)` yield +
`IntersectionObserver` 只渲染视口附近页 + ImageBitmap LRU 回收（最多 8 页缓存、12 页本地 DOM）。

### 7.2 交付物

| 文件 | 作用 |
|---|---|
| `scripts/copy-pdfjs.mjs` | 构建期从 npm 依赖拷贝 `pdf.min.mjs` / `pdf.worker.min.mjs` / 10 个标准字体到 `public/pdfjs/`；产物 `.gitignore`，不进 git |
| `src/lib/backend/web/pdfRenderBackend.ts` | 渲染后端：按页渲染、预览 LRU、canvas 池、DPI 限幅、长图拼接、逐页导出、错误映射 |
| `src/features/pdf/PdfPreview.tsx` | 虚拟化预览 UI + 导出控件（DPI / 格式 / 质量 / 页码范围 / 长图） |
| `src/features/pdf/PdfPage.tsx` | 新增「渲染图片」操作入口；底部限制文案已更正 |
| `scripts/build-sw.mjs` / `src/sw.ts` | pdf.js 运行时进 SW 预缓存；`CACHE_VERSION` → `v1-phase4b-pdfjs` |
| `src/features/help/CapabilitiesPage.tsx` | PDF→图片行改为「✅ ≤100 页，按页渲染 + 虚拟化」 |
| `tests/e2e/pdf-render.mjs` | 真实 Chromium：上传 → 渲染 → 画布像素校验 → 导出 PNG 逐页下载 |

### 7.3 实测与踩坑

- pdf.js 实测体积：`pdf.min.mjs` 113 KB br + `pdf.worker.min.mjs` 311 KB br ≈ **424 KB br**，
  与 `docs/BUDGET.md` 估算 415 KB br 基本一致。
- **坑 1**：pdf.js 用静态 `WeakSet` 跟踪「正在渲染的 canvas」。被 `cancel()` 的渲染会延迟一帧才从
  WeakSet 移除，若把该 canvas 放回池里，下一次 render 会抛
  `Cannot use the same canvas during multiple render() operations`。修复：每次 pdf.js render 用
  全新 `OffscreenCanvas`，不回池；池只用于位图→字节转换。
- **坑 2**：`page.render({ viewport })` 必须传 `page.getViewport()` 返回的真实 `PageViewport`
  对象（含 `transform`），不能传 `{width,height}` 普通对象，否则抛 `e.transform is not iterable`。
- **坑 3**：不设置 `GlobalWorkerOptions.standardFontDataUrl` 时标准字体缺失，文字渲染空白。
- 出厂标准字体有 10 个 `.pfb`（约 1.3 MB raw），全部进 SW 预缓存，离线渲染不缺字。
- e2e 实测：3 页 sample.pdf → 画布 1020×1320（真实渲染）→ 导出 `page-001/002/003.png`；
  长图模式导出 `pages-1-3-long.png`；0 个 pageerror / console error。

### 7.4 仍受限制（常驻声明）

- 单次最多 100 页；DPI 200 以上、更高页数、批量导出 → 桌面版。
- 单页像素上限 20 MP、长图总像素上限 40 MP，超限自动降采样。
- 不承诺高保真：表单域、批注、页眉页脚、复杂表格、嵌入字体的还原度有限。
- WebCodecs 转码、ffmpeg.wasm 降级、桌面 LibreOffice 仍属 Phase 4b/5 后续。
