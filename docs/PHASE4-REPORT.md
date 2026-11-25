# Phase 4 完成报告（部分：结构操作 + 保真度声明）

> 目标：Web 轻量视频 + 轻量文档 + 「能力与限制」页完善。
> 本次交付：PDF 结构操作（wasm）、Word↔PDF 结构化转换骨架、**常驻保真度声明**、
> 视频能力探测与 GPL 降级说明。WebCodecs 转码管线与 pdf.js 渲染标注为 Phase 4b（未接入）。

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
- **pdf.js 按页渲染 + 虚拟化缓冲池**：4b 接入（当前 PDF 页只做结构操作）
- 可选 ffmpeg.wasm 实际降级按钮（GPL 声明与包已规划，未接执行）
- 完整 mammoth→pdf-lib 的 docx→pdf 文件生成（当前产出结构化 JSON 中间产物）
- 桌面端 LibreOffice 调用（Phase 5）
