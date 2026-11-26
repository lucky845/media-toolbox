# 本地多媒体工具箱

浏览器内完成图片、PDF、视频处理。**文件不离开本机**，全部计算在你的设备上完成。

同一份 Rust 核心算法编译成两个目标，套两个壳：

| | 在线版（GitHub Pages） | 桌面版（Tauri 2） |
|---|---|---|
| 形态 | 纯静态站点，免安装 | 安装包，零网络 |
| 定位 | 轻量、随手用、**看得见限制** | 扛重活：大文件、全格式、批量、并行 |
| 核心算法 | 同一份 `crates/core` → wasm | 同一份 `crates/core` → native |

> **在线地址**：https://media-toolbox.lucky845.top/ （占位，需你部署后才生效）
> **桌面版**：`https://github.com/lucky845/media-toolbox/releases`（Phase 5 产出）

---

## 先说清楚三件事

1. **在线版仅分发代码，文件不上传 —— 但仓库与构建产物是公开的。**
   前者是隐私保证，后者是 GitHub Free 计划（Pages 只对公共仓库免费）的直接结果。
   若要保护源码：用「私有源仓库 + Actions deploy key 推 dist 到公共 Pages 仓库」（免费），
   但**站点本身仍然公开**。

2. **在线版有硬限制，并且在开始处理前就拒绝超限文件**，不会「跑到一半崩溃」。
   原因不是没做，而是平台边界：GitHub Pages 无法设置 COOP/COEP 响应头 →
   没有 `SharedArrayBuffer` → wasm 只能单线程。

3. **Word↔PDF 在浏览器内不可能高保真。** 浏览器里没有 LibreOffice，
   只能做结构化转换。UI 会常驻声明「可能丢失排版」，我们**不承诺无损**。

---

## 两种本地部署方式（都能用）

### 方式 A：静态服务打开同一份 `dist`（Web 形态的「本地部署」）

```bash
npm ci
node scripts/build-wasm.mjs          # cargo → wasm-bindgen → 体积报告
mkdir -p public/wasm
cp crates/wasm/pkg/core_image.js public/wasm/
cp crates/wasm/pkg/core_image_bg.wasm public/wasm/
npm run build                        # tsc + vite + SW 编译 → dist/

# 二选一启动静态服务：
npm run preview                      # 推荐：Vite 会给 .wasm 正确的 MIME
python3 -m http.server 5000 --directory dist   # 也可以
```

> **关于 `.wasm` 的 MIME**：GitHub Pages 返回 `application/wasm`（已实测），Vite preview 也是。
> 但部分系统的 `http.server` 可能返回 `application/octet-stream`。
> 我们的加载器实现了三段降级（`instantiateStreaming` → `fetch+arrayBuffer` → 诊断），
> 所以**这种情况仍然能用**，只是控制台会有一条降级日志。

### 方式 B：安装桌面版（桌面形态的「本地部署」）

```bash
# 开发
cargo tauri dev

# 打包（macOS，未签名）
cargo tauri build --target aarch64-apple-darwin
# 产物：src-tauri/target/release/bundle/dmg/*.dmg
```

桌面版**不需要任何服务、不需要联网**，FFmpeg 与 LibreOffice 打包在安装包内。

---

## 能力矩阵

| 能力 | 在线版 | 桌面版 | 在线版为什么是这样 |
|---|---|---|---|
| 图片 压缩/裁剪/旋转/翻转/亮度对比度饱和度/缩放/EXIF 方向 | ✅ ≤20 MP、≤20 MB | ✅ 大图、批量、rayon 并行 | 全部已实现（Phase 3）；单线程 wasm + Worker |
| 图片 格式转换 | ✅ jpeg/png/webp/gif/bmp/tiff | ✅ 加 AVIF | AVIF 编码库（ravif）约 +1.5–2 MB，Web 默认关闭 |
| 视频 压缩/格式转换 | ⚠️ 仅轻量 MP4(H.264)→MP4/WebM，≤200 MB、≤5 分钟 | ✅ FFmpeg sidecar（档位 L：无 libx264，H.264 走系统硬件编码） | 无 COOP/COEP → 单线程；编解码器由浏览器决定 |
| 视频 元数据/首帧 | ✅ mp4box 轻量解析 | ✅ ffprobe | — |
| PDF → 图片 | ✅ ≤100 页、≤200 DPI | ✅ 不限页数、≤400 DPI（复用 pdf.js） | pdf.js 按页渲染 + 虚拟化；阈值由 capabilities 注入 |
| PDF 合并/拆分/旋转/提取 | ✅ | ✅ | Rust `lopdf`，两端同一份 |
| PDF → Word / Word → PDF | ⚠️ 仅结构化（mammoth 读 docx，输出 JSON 段落） | ✅ LibreOffice headless 优先 + 结构化兜底 | 浏览器内没有 LibreOffice，不承诺高保真 |
| 批量队列 | ✅ 1–2 Worker + 总进度/取消/重试 | ✅ rayon + 子进程池 | 队列级暂停；running 只能取消 |
| 离线 | ✅ 首次加载后由 SW 缓存（已实现） | ✅ 完全离线 | 外壳 + wasm 分包预缓存；绝不缓存可选 ffmpeg 包 |
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

---

## 体积与流量预算

### 实测体积（`docs/wasm-size.json` 由构建脚本生成，非手写）

| 产物 | 原始 | gzip | brotli |
|---|---|---|---|
| `core_image.wasm` | 1254 KB | 390 KB | 307 KB |
| 首屏 JS（React + 应用） | — | 82 KB | — |
| CSS | 5 KB | 1.8 KB | — |
| **dist 合计** | **1.51 MB** | — | — |

占 GitHub Pages 1 GB 上限的 **0.15%**。结论：**体积不是本站的约束**。

### 流量（100 GB/月软限）

| 访客画像 | 单次流量 |
|---|---|
| 只打开首页 | ~0.12 MB |
| 用一次图片压缩 | ~0.4 MB（外壳 + wasm） |
| 图片 + PDF + 文档 | ~1.2 MB |
| 用了可选 ffmpeg.wasm 降级 | ~10 MB |

保守估计（人均 0.6 MB）：**≈ 17 万新访客/月**。
最坏情况（人人都点 ffmpeg.wasm）：**≈ 1 万/月**。

这就是为什么 `ffmpeg.wasm`（31 MB 原始 / 9.7 MB gzip）**绝不能默认加载**。

### 部署超时（10 分钟）

| 阶段 | 冷缓存 | 热缓存 |
|---|---|---|
| cargo build wasm | ~210 s | ~40 s |
| wasm-bindgen + 体积报告 | ~20 s | ~15 s |
| vite build | ~5 s | ~5 s |
| 上传 + 部署 | ~60 s | ~60 s |
| **合计** | **~5 min** | **~2 min** |

---

## 构建命令

```bash
# 环境（一次性）
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130 --locked   # 必须与 Cargo.lock 里的版本一致

# Web
npm ci
node scripts/build-wasm.mjs --opt     # --opt 需要 npm i -D binaryen
npm run build
npm run preview

# 桌面
cd src-tauri && cargo tauri dev
cargo tauri build

# 测试（下列数字是本仓库当前实测值）
cargo test --workspace                 # Rust：212 个测试（含 native 真实 ffmpeg 集成测试）
(cd src-tauri && cargo test --lib)      # Tauri command：6 个测试
npx vitest run                         # 前端：16 个测试
node scripts/run-conformance.mjs       # 图片双端一致性：21 个用例，逐字节相等
node scripts/run-pdf-conformance.mjs   # PDF 双端一致性：3 个用例（需先 build 两个程序）
node scripts/benchmark.mjs             # 基准：12 MP lanczos 缩放 native vs wasm（3 次取中位数）
node scripts/verify-single-source.mjs  # 「一处改两端生效」的机器验证
node tests/e2e/smoke.mjs http://localhost:4173  # 真实浏览器端到端（另有 pdf/pdf-render/video/documents/offline/mime-fallback）

# CI 闸门
node scripts/check-core-boundary.mjs   # core 里禁止 rayon/fs/thread
node scripts/check-no-branching.mjs    # features/ 里禁止按壳分支
node scripts/check-external-domains.mjs# dist 里禁止第三方域名
node scripts/check-budget.mjs          # 体积预算
node scripts/check-notices.mjs         # 许可证声明完整性
```

---

## 浏览器兼容矩阵

| 能力 | Chrome/Edge | Firefox | Safari | 不支持时的降级 |
|---|---|---|---|---|
| `WebAssembly.instantiateStreaming` | 57+ | 52+ | 15+ | 三段降级加载器（已实现） |
| Worker（module 类型） | 80+ | 114+ | 15+ | 配置中可退回 iife |
| Service Worker | 40+ | 44+ | 11.1+ | 无离线缓存（Phase 3 启用） |
| `OffscreenCanvas` | 69+ | 105+ | 16.4+ | 退回主线程 canvas |
| `createImageBitmap`（含 resize） | 50+ | 42+ | 15+ | 退回 `<img>` 绘制 |
| File System Access API | 86+ | ❌ | ❌ | 退回 `<a download>`（批量会多次下载） |
| WebCodecs `VideoDecoder` | 94+ | 130+ | 16.4+ | 视频模块提示用桌面版 |
| WebCodecs `VideoEncoder` | 94+ | 130+ | 16.4+（仅 video） | 同上 |
| WebCodecs `AudioEncoder` | 94+ | 130+ | **26+** | Safari < 26 只能处理无声视频 |
| `crossOriginIsolated` | — | — | — | **在 GitHub Pages 上恒为 false** → 无多线程 |

逐浏览器结论：

- **Chrome / Edge 86+**：全部功能可用（阈值内）。批量输出走目录句柄。
- **Firefox 130+**：图片/PDF 全部可用；无 File System Access API，批量导出会触发多次下载。
- **Safari 16.4+**：图片/PDF 可用；WebCodecs 仅 video 部分，**有声视频转码需 26+**。
- **更老版本**：图片与 PDF 结构编辑仍可用，视频模块显示「请用桌面版」。

---

## 目录结构

```
media-toolbox/
├── crates/
│   ├── ports/          # trait：Source/Sink/Progress/Cancel/Parallel/Codec + 阈值 + 错误码
│   ├── core/           # 纯算法：image/color/pdf/video，只处理字节
│   ├── wasm/           # wasm-bindgen 薄包装（单线程）
│   └── native/         # rayon + 文件 IO + 子进程
├── src-tauri/          # Tauri 2 壳：commands / sidecar 探测 / 菜单
├── src/
│   ├── lib/backend/    # Backend 接口 + Web/Desktop 两个实现
│   ├── workers/        # Worker 消息协议 + 图片 Worker
│   ├── features/       # 页面（image / pdf / video / documents / help）
│   ├── components/     # 通用组件
│   └── store/          # Zustand：queue / settings / capabilities
├── tests/              # 单元测试 + 端到端
├── scripts/            # 构建、闸门、一致性验证
├── docs/               # 架构、契约、归属、预算、CI、兼容性、计划
└── .github/workflows/  # ci / deploy-pages / release-desktop
```

架构细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，接口契约见 [docs/CONTRACTS.md](docs/CONTRACTS.md)。

---

## 许可证

- **自有代码**：[MIT](LICENSE)
- **第三方组件**：[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) —— 按 Web / Desktop 两栏逐条列出

关键点（不要含糊）：

- 在线版**默认不含任何 GPL 组件**。
- 可选的 `ffmpeg.wasm` 降级分包：`@ffmpeg/ffmpeg` 包装是 MIT，但 **`@ffmpeg/core` 是 GPL-2.0-or-later**
  （其构建含 `--enable-gpl --enable-libx264`）。**必须用户点击才下载**，点击前会显示许可证说明。
- 桌面版捆绑的 FFmpeg 为 **LGPL-2.1-or-later**（不含 libx264/x265）；
  启动时会读 `ffmpeg -version` 的 configure 行做运行期核验，发现 GPL 开关即标红并禁用视频模块。
- LibreOffice 为 **MPL-2.0**；中文字体 Noto Sans 为 **SIL OFL 1.1**（子集化后分发需保留 OFL 全文）。
- 带 `--enable-nonfree` / `libfdk_aac` 的 FFmpeg 构建**一律禁用**（不可再分发）。

---

## 这个项目的架构赌注

一句话：**「核心算法只写一份」不是口号，是可机器验证的**。

```bash
node scripts/verify-single-source.mjs
```

它会：改一处 `crates/core` 里的重采样核 → 重建 wasm 与 native → 跑同一组输入 →
断言「两端输出**仍然逐字节一致**」且「两端的输出**都变了**」。
做不到就退出码非 0。

这个验证在开发中真实抓到了一个 bug：`f32::sin` 在 wasm 与 native 上有 6e-8 的差异，
导致输出 PNG 完全不同（11 KB vs 6.6 KB）。修复方式是自己实现确定性的三角函数
（`crates/core/src/common/trig.rs`），只用 IEEE-754 精确定义的运算。
修复后 21/21 用例逐字节一致，零白名单。
