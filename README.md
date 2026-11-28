# 本地多媒体工具箱

[![Release](https://img.shields.io/github/v/release/lucky845/media-toolbox?style=flat-square&label=release&color=2f81f7)](https://github.com/lucky845/media-toolbox/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/lucky845/media-toolbox/ci.yml?style=flat-square&label=ci&branch=main)](https://github.com/lucky845/media-toolbox/actions/workflows/ci.yml)
[![Deploy Pages](https://img.shields.io/github/actions/workflow/status/lucky845/media-toolbox/deploy-pages.yml?style=flat-square&label=pages&branch=main)](https://github.com/lucky845/media-toolbox/actions/workflows/deploy-pages.yml)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![Rust](https://img.shields.io/badge/Rust-1.99-dea584?style=flat-square&logo=rust&logoColor=white)](#架构)
[![WebAssembly](https://img.shields.io/badge/wasm-32bit-654ff0?style=flat-square&logo=webassembly&logoColor=white)](#能力矩阵)
[![Tauri](https://img.shields.io/badge/Tauri-2-24c8d8?style=flat-square&logo=tauri&logoColor=white)](#桌面版)
[![React](https://img.shields.io/badge/React-19.3-61DAFB?style=flat-square&logo=react&logoColor=white)](#技术栈)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6?style=flat-square&logo=typescript&logoColor=white)](#技术栈)
[![Tests](https://img.shields.io/badge/tests-234_passing-6e9f18?style=flat-square&logo=vitest&logoColor=white)](#测试)

浏览器内完成图片、PDF、视频、文档处理。**文件不离开本机** —— 全部计算在你的设备上完成，无后端、无上传、无账号、无遥测。

**🔗 在线使用**：[media-toolbox.lucky845.top](https://media-toolbox.lucky845.top/)
**💾 桌面版（离线全量）**：[GitHub Releases](https://github.com/lucky845/media-toolbox/releases/latest) · Windows / macOS arm64 / Linux 三平台安装包

同一份 Rust 核心算法编译成两个目标，套两个壳：

|  | 在线版（GitHub Pages） | 桌面版（Tauri 2） |
|---|---|---|
| 形态 | 纯静态站点，免安装 | 安装包，零网络 |
| 定位 | 轻量、随手用、**看得见限制** | 扛重活：大文件、全格式、批量、并行 |
| 核心算法 | 同一份 `crates/core` → wasm | 同一份 `crates/core` → native |
| 离线 | 首次加载后由 Service Worker 缓存 | 完全离线 |

> [!NOTE]
> **在线版仅分发代码，文件不上传 —— 但仓库与构建产物是公开的。**
> 前者是隐私保证，后者是 GitHub Free 计划（Pages 只对公共仓库免费）的直接结果。
> 若要保护源码：用「私有源仓库 + Actions deploy key 推 `dist` 到公共 Pages 仓库」（免费），
> 但**站点本身仍然公开**。

> [!IMPORTANT]
> **在线版有硬限制，并且在开始处理前就拒绝超限文件**，不会「跑到一半崩溃」。
> 原因不是没做，而是平台边界：GitHub Pages 无法设置 COOP/COEP 响应头 →
> 没有 `SharedArrayBuffer` → wasm 只能单线程、32 位内存上限 4 GB。
> 超限会直接中止并引导下载桌面版。

---

## ✨ 特性

- **🖼️ 图片全链路** —— 批量压缩 / 裁剪 / 旋转 / 翻转 / 亮度对比度饱和度 / 滤镜 / 缩放 / EXIF 方向；JPEG / PNG / WebP / GIF / BMP / TIFF / QOI / ICO
- **📄 PDF** —— 缩略图拖动重排、AES-256 密码加密 / 解密、批量转图片（DPI / 页码范围 / 长图）、合并 / 拆分 / 旋转 / 提取文本与图片
- **🎬 视频** —— WebCodecs 轻量转码（MP4/H.264 → MP4/WebM）；桌面版 FFmpeg sidecar 全格式 + 硬件编码
- **📝 文档** —— Word↔PDF 结构化转换；桌面版 LibreOffice headless 高保真优先
- **🔒 纯本地** —— 无后端、无上传、无埋点；只经文件选择 / 拖放 / 系统对话框显式授权
- **📦 批量队列** —— 单任务与总进度、暂停 / 取消 / 重试、原图结果对比、体积节省统计
- **⚡ 双前端一后端** —— 一份 features 代码，靠 `capabilities()` 切换形态，零 `if (isTauri)`
- **🧩 机器可验证的一致性** —— 双端输出逐字节比对，图片 21/21、PDF 3/3

---

## v0.2.6 更新

- 图片缩放与裁剪降低中间像素缓冲区占用，桌面端可对比原图和转换结果。
- 修复 WebKit 环境的 PDF.js 预览兼容问题，并清除桌面端旧 Service Worker 缓存。
- 修复在线 MP4 样本解析与降帧时间戳，桌面转码显示输入和输出大小。
- 增加浏览器视频转码 smoke test，验证 B 帧、AAC 音轨、WebM 和降帧输出。

[查看完整更新日志](CHANGELOG.md)

## v0.2.4 更新

- PDF 新增缩略图重排、密码加密 / 解密和多文件图片导出。
- 批量图片导出为每份 PDF 使用独立渲染资源，输出名包含源文件名，单个损坏文件不影响其他文件。
- 修复桌面端图片导入持续显示读取中，以及在线版图片导出文件名错误。
- 使用加密 PDF 进行预览或其他编辑前，请先在「移除密码」中解密；新选文件后需要重新输入密码。

## 桌面版

桌面版在本机处理文件，无需联网。FFmpeg 随安装包分发。高保真 Office 转换需要另行安装 LibreOffice，其余功能可以独立使用。

| 源文件 | 形态 | 说明 |
|---|---|---|
| Windows x64 MSI | `.msi` | [最新版本](https://github.com/lucky845/media-toolbox/releases/latest) |
| macOS arm64 DMG / app archive | `.dmg` / `.app.tar.gz` | [最新版本](https://github.com/lucky845/media-toolbox/releases/latest) |
| Linux x64 deb / AppImage | `.deb` / `.AppImage` | [最新版本](https://github.com/lucky845/media-toolbox/releases/latest) |

> [!WARNING]
> macOS 安装包适用于 Apple 芯片，当前公开版本未经 Apple 公证。双击 DMG 后，将应用拖到「应用程序」，再从那里启动。若 Gatekeeper 阻止启动，先尝试一次，再到「系统设置 → 隐私与安全性」查看是否提供「仍要打开」。该按钮仅适用于可覆盖的未识别开发者/未公证提示；如果 DMG 校验或挂载失败、系统报告已损坏，或按钮不存在，不要绕过安全检查，请从 GitHub Releases 重新下载，或将错误原文和 macOS 版本发给维护者。

从源码构建：

```bash
cd src-tauri
cargo tauri dev      # 开发
cargo tauri build    # 打包（产物在 target/release/bundle/）
```

---

## 两种本地部署方式（都能用）

### 方式 A：静态服务打开同一份 `dist`（Web 形态的「本地部署」）

```bash
npm ci
npm run wasm                                 # cargo → wasm-bindgen → wasm-opt（需 binaryen）
npm run build                                # tsc + vite + SW 编译 → dist/
npm run preview                              # 推荐：Vite 会给 .wasm 正确的 MIME
# 或：python3 -m http.server 5000 --directory dist
```

> **关于 `.wasm` 的 MIME**：GitHub Pages 返回 `application/wasm`（已实测），Vite preview 也是。
> 但部分系统的 `http.server` 可能返回 `application/octet-stream`。加载器实现了三段降级
> （`instantiateStreaming` → `fetch+arrayBuffer` → 诊断），**这种情况仍然能用**，只是控制台会有一条降级日志。

### 方式 B：安装桌面版（桌面形态的「本地部署」）

直接下载上方安装包；或按「桌面版」章节从源码构建。完全离线，无需任何服务。

---

## 能力矩阵

| 能力 | 在线版 | 桌面版 | 在线版为什么是这样 |
|---|---|---|---|
| 图片 压缩/裁剪/旋转/翻转/亮度对比度饱和度/缩放/EXIF 方向 | ✅ ≤20 MP、≤20 MB、每批 ≤50 张 | ✅ 软件不设像素与批量数量上限 | 单线程 wasm + Worker；桌面端 rayon |
| 图片 格式转换 | ✅ JPEG/PNG/WebP/GIF/BMP/TIFF/QOI/ICO | ✅ 同在线版 | ICO 输出每边最多 256 像素；AVIF 编码未启用 |
| 视频 压缩/格式转换 | ⚠️ 仅轻量 MP4(H.264)→MP4/WebM，≤200 MB、≤5 分钟 | ✅ FFmpeg sidecar（档位 L：无 libx264，H.264 走系统硬件编码） | 无 COOP/COEP → 单线程；编解码器由浏览器决定 |
| 视频 元数据/首帧 | ✅ mp4box 轻量解析 | ✅ ffprobe | — |
| PDF → 图片 | ✅ ≤100 页、≤200 DPI | ✅ 不限页数、≤400 DPI（复用 pdf.js） | pdf.js 按页渲染 + 虚拟化；阈值由 capabilities 注入 |
| PDF 合并/拆分/旋转/提取/页面重排 | ✅ | ✅ | Rust `lopdf`，两端同一份；缩略图拖动或按钮调整顺序 |
| PDF 密码加密/解密 | ✅ 支持批量 | ✅ 支持批量 | AES-256；密码不写入任务历史，加解密任务需重新输入密码后再次提交 |
| PDF → Word / Word → PDF | ⚠️ 仅结构化（mammoth 读 docx，输出 JSON 段落） | ✅ LibreOffice headless 优先 + 结构化兜底 | 浏览器内没有 LibreOffice，不承诺高保真 |
| 批量队列 | ✅ 1–2 Worker + 总进度/取消/重试 | ✅ rayon + 子进程池 | 队列级暂停；running 只能取消 |
| 离线 | ✅ 首次加载后由 SW 缓存 | ✅ 完全离线 | 外壳 + wasm 分包预缓存；绝不缓存可选 ffmpeg 包 |
| 大文件 | ❌ 超限中止 + 桌面版引导 | ✅ 流式 | wasm 32 位内存上限 + 峰值内存模型 |

完整的逐项说明（含每个 ⚠️ 的具体原因）见站内「能力与限制」页与 [docs/CAPABILITIES.md](docs/CAPABILITIES.md)。

### 阈值（唯一来源 `crates/ports/src/limits.rs`）

| 项 | 在线版 | 桌面版 |
|---|---|---|
| 图片 | 20 MP 且 20 MB | 不限 |
| 视频 | 200 MB 且 5 分钟 | 不限 |
| PDF | 100 页 | 不限 |
| 峰值内存估算上限 | 512 MB | — |
| 并发 | 2 | 4（可配） |

超限行为：**在解码前中止**，返回带 `desktopHint: true` 的错误，弹窗给出 Releases 链接。

> [!IMPORTANT]
> **Word↔PDF 在浏览器内不可能高保真。** 浏览器里没有 LibreOffice，只能做结构化转换。
> UI 会常驻声明「可能丢失嵌入字体、分栏、浮动图形、表单域、批注、页眉页脚、复杂表格」，
> **不承诺无损**；需要高保真请用桌面版。

---

## 体积与流量预算

### 实测体积（`docs/wasm-size.json` 由构建脚本生成，非手写）

| 产物 | 原始 | gzip | brotli |
|---|---|---|---|
| `core_image.wasm` | 1208 KB | 419 KB | 326 KB |
| `core_doc.wasm` | 1981 KB | 687 KB | 531 KB |
| `pdf.js`（main + worker） | 1748 KB | 516 KB | 424 KB |
| `mammoth`（动态 import） | 298 KB | 87 KB | 74 KB |
| 首屏 JS（React + 应用） | 354 KB | 90 KB | — |
| **dist 合计** | **6.0 MB** | — | — |

占 GitHub Pages 1 GB 上限的 **0.6%**。结论：**体积不是本站的约束**。

### 流量（100 GB/月软限）

| 访客画像 | 单次流量 |
|---|---|
| 只逛首页 | ~0.12 MB |
| 用一次图片压缩 | 依实际缓存资源计算 |
| 图片 + PDF + 文档（重度） | ~2.43 MB |
| 用了可选 ffmpeg.wasm 降级 | ~12.1 MB |

按全功能口径（人均约 1.5 MB，不计 SW 缓存带来的回访节省）：**≈ 6.8 万新访客/月**；
若人人都点 ffmpeg.wasm：**≈ 8400/月**。

这就是为什么 `ffmpeg.wasm`（31 MB 原始 / 9.7 MB gzip）**绝不能默认加载** —— 它只在用户显式点击时才下载，且 GPL 声明常驻。

---

## 技术栈

| 层 | 技术 |
|---|---|
| 核心算法 | Rust（native + wasm32），`image` / `lopdf` / `blake3`，自实现确定性三角函数 |
| 桌面壳 | Tauri 2 + tokio + rayon，FFmpeg / LibreOffice sidecar |
| 前端 | React 19 + TypeScript 5.9 + Zustand + Vite 8（hash 路由） |
| Worker | WebCodecs + mp4box.js + mp4-muxer / webm-muxer；pdf.js 主线程渲染 |
| 样式 | 自研「原理图 / SCHEMATIC SHEET」设计 token，无外部字体/CDN |
| 测试 | Vitest + Playwright + cargo test + 双端一致性 harness |

设计 token 与用户其他项目一致：底 `#0C1216` / 面板 `#121B20` / 强调 `#4EC2C6` / 琥珀 `#D89A3F`。

---

## 架构

```
crates/
├── ports/      # trait：Source/Sink/Progress/Cancel/Parallel/Codec + 阈值 + 错误码
├── core/       # 纯算法：image/color/pdf/video，只处理字节（无路径/网络/线程）
├── wasm/       # wasm-bindgen 薄包装（单线程）
└── native/     # rayon + 文件 IO + 子进程
src-tauri/      # Tauri 2 壳：commands / sidecar 探测 / 菜单
src/
├── lib/backend/  # Backend 接口 + Web/Desktop 两个实现
├── workers/      # Worker 消息协议 + 图片/doc Worker
├── features/     # 页面（image / pdf / video / documents / help）
├── components/   # 通用组件
└── store/        # Zustand：queue / settings / capabilities
scripts/         # 构建、闸门、一致性验证、基准
docs/            # 架构、契约、归属、预算、CI、兼容性、计划、报告
.github/workflows/  # ci / deploy-pages / release-desktop
```

核心约束（违反即不合格）：无后端服务器 / 无云函数 / 文件只经显式授权 / 运行期零第三方域名请求 / 大二进制不进 git / 阈值单一来源。

细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 与 [docs/CONTRACTS.md](docs/CONTRACTS.md)。

---

## 快速开始

```bash
# 环境（一次性）
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130 --locked   # 必须与 Cargo.lock 一致
npm i -D binaryen                                            # wasm-opt 用

# Web
npm ci
npm run wasm
npm run build
npm run preview                                             # http://localhost:4173

# 桌面
cd src-tauri && npm run tauri dev                           # 或 cargo tauri dev
```

需要 Node 22+、Rust 1.82+。

## 测试

```bash
cargo test --workspace                 # Rust 单元与集成测试，含 FFmpeg 集成测试
(cd src-tauri && cargo test --lib)      # 桌面端 Tauri 命令测试
npm test                               # 前端单元测试
node scripts/run-conformance.mjs       # 图片双端一致性：21 个用例，逐字节相等
node scripts/run-pdf-conformance.mjs   # PDF 双端一致性：3 个用例（需先 build 两个程序）
node scripts/benchmark.mjs             # B1 基准：12 MP lanczos native vs wasm（3 次取中位数）
node scripts/verify-single-source.mjs  # 「一处改两端生效」的机器验证
node tests/e2e/smoke.mjs http://localhost:4173  # 真实浏览器端到端（另有 pdf/pdf-render/video/documents/offline/mime-fallback）
```

运行视频 smoke test 前，安装 Chrome 和带 libx264 的 FFmpeg（含 ffprobe）。执行 `npm run build`，启动 `npm run preview`，然后在另一终端运行以下命令。

```bash
npm run smoke:video -- http://localhost:4173
```

CI 闸门（三个 workflow 自动跑）：

```bash
node scripts/check-core-boundary.mjs    # core 里禁止 rayon/fs/thread
node scripts/check-no-branching.mjs     # features/ 里禁止按壳分支
node scripts/check-external-domains.mjs # dist 里禁止第三方域名
node scripts/check-budget.mjs           # 体积预算
node scripts/check-notices.mjs          # 许可证声明完整性
```

## 发布流程

1. 改 `CHANGELOG.md`，确认能力矩阵与文档同步。
2. 本地跑通上面「测试」全部命令。
3. 打 tag 并推送：`git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z`。
4. `release-desktop` workflow 在 Windows / macOS / Linux 三平台构建并上传安装包；
   `deploy-pages` 同步发布在线版。
5. 产物命名：`MediaToolbox-<版本>-<平台>-<架构>.<扩展名>`。

---

## 浏览器兼容矩阵

| 能力 | Chrome/Edge | Firefox | Safari | 不支持时的降级 |
|---|---|---|---|---|
| `WebAssembly.instantiateStreaming` | 57+ | 52+ | 15+ | 三段降级加载器（已实现） |
| Worker（module 类型） | 80+ | 114+ | 15+ | 配置中可退回 iife |
| Service Worker | 40+ | 44+ | 11.1+ | 已实现，首次加载后可离线 |
| `OffscreenCanvas` | 69+ | 105+ | 16.4+ | 退回主线程 canvas |
| `createImageBitmap`（含 resize） | 50+ | 42+ | 15+ | 退回 `<img>` 绘制 |
| File System Access API | 86+ | ❌ | ❌ | 退回 `<a download>`（批量会多次下载） |
| WebCodecs `VideoDecoder` | 94+ | 130+ | 16.4+ | 视频模块提示用桌面版 |
| WebCodecs `VideoEncoder` | 94+ | 130+ | 16.4+（仅 video） | 同上 |
| WebCodecs `AudioEncoder` | 94+ | 130+ | **26+** | Safari < 26 只能处理无声视频 |
| `crossOriginIsolated` | — | — | — | **在 GitHub Pages 上恒为 false** → 无多线程 |

- **Chrome / Edge 86+**：全部功能可用（阈值内）。批量输出走目录句柄。
- **Firefox 130+**：图片 / PDF 全部可用；无 File System Access API，批量导出会触发多次下载。
- **Safari 16.4+**：图片 / PDF 可用；WebCodecs 仅 video 部分，**有声视频转码需 26+**。
- **更老版本**：图片与 PDF 结构编辑仍可用，视频模块显示「请用桌面版」。

---

## 常见问题

**文件会上传吗？** 不会。所有处理在浏览器 / 本机完成，没有后端、没有上传接口。但站点代码与构建产物是公开仓库的一部分（见上方 NOTE）。

**为什么在线版不能处理大文件？** Pages 不支持 COOP/COEP → wasm 单线程且 32 位内存上限 4 GB；超限会在解码前中止并给桌面版链接。

**Word↔PDF 为什么不是无损？** 浏览器里没有 LibreOffice，只能结构化转换；桌面版走 LibreOffice headless 保真度更高，但复杂排版仍可能丢失，不承诺无损。

**ffmpeg.wasm 是 GPL，会默认下载吗？** 不会。它是可选降级，只有用户点击才加载；默认路径是浏览器原生 WebCodecs，无 GPL 义务。

---

## 许可证

- **自有代码**：[MIT](LICENSE)
- **第三方组件**：[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) —— 按 Web / Desktop 两栏逐条列出
- **基准数据**：[docs/benchmarks.md](docs/benchmarks.md) / [docs/benchmark-results.json](docs/benchmark-results.json)

关键点（不要含糊）：

- 在线版**默认不含任何 GPL 组件**。
- 可选 `ffmpeg.wasm`：`@ffmpeg/ffmpeg` 包装是 MIT，但 **`@ffmpeg/core` 是 GPL-2.0-or-later**（构建含 `--enable-gpl --enable-libx264`）。**必须用户点击才下载**。
- 桌面版 FFmpeg 为 **LGPL-2.1-or-later**（无 libx264/x265）；启动读 configure 行核验，发现 GPL 开关即标红并禁用视频模块。
- LibreOffice 为 **MPL-2.0**；Noto Sans 为 **SIL OFL 1.1**（子集化后保留 OFL 全文）。
- 带 `--enable-nonfree` / `libfdk_aac` 的 FFmpeg 构建**一律禁用**。

---

## 这个项目的架构赌注

一句话：**「核心算法只写一份」不是口号，是可机器验证的**。

```bash
node scripts/verify-single-source.mjs
```

它会改一处 `crates/core` 的重采样核 → 重建 wasm 与 native → 跑同一组输入 → 断言两端输出**仍然逐字节一致**且**两端输出都变了**。做不到退出码非 0。

这个验证在开发中真实抓到一个 bug：`f32::sin` 在 wasm 与 native 上有 6e-8 差异，导致输出 PNG 完全不同（11 KB vs 6.6 KB）。修复方式是自实现确定性三角函数（`crates/core/src/common/trig.rs`），只用 IEEE-754 精确定义的运算。修复后 21/21 用例逐字节一致，零白名单。

基准裁决见 [docs/OWNERSHIP.md](docs/OWNERSHIP.md) 与 [docs/benchmarks.md](docs/benchmarks.md)：未测项一律 `[待测]`，不拿「应该更快」当结论。

---

## 贡献

欢迎提 Issue 与 PR。改动核心算法时请同时跑双端一致性脚本；改阈值时只动 `crates/ports/src/limits.rs`，不要硬编码到前端。提交前确认七道 CI 闸门全绿。

## 致谢

- Rust `image` / `lopdf` / `blake3`、Tauri、React、Vite 等开源项目
- pdf.js（PDF 渲染）、mammoth（docx 解析）、mp4box.js / mp4-muxer / webm-muxer（视频容器）
- FFmpeg（LGPL 构建）、LibreOffice（MPL）、Noto Sans（OFL）
