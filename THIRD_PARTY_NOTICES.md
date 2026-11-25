# 第三方组件声明（THIRD_PARTY_NOTICES）

本文件按 **Web / Desktop 两栏**列出本项目分发或依赖的全部第三方组件。
「分发」= 会进入 `dist/` 或安装包；「依赖」= 仅在构建期使用。
若两者都不是，不会出现在本表。

> **一句话总结许可证风险**：
> - **Web 站点默认不含任何 GPL 组件**（可选降级的 ffmpeg.wasm 需用户点击才下载，且声明常驻）。
> - **桌面版**捆绑的 FFmpeg 使用 **LGPL-2.1-or-later** 构建（不含 libx264/x265）；LibreOffice 为 **MPL-2.0**；pdfium（若启用）为 BSD-3。
> - 带 `--enable-nonfree` 或 `libfdk_aac` 的 FFmpeg 构建**一律禁用**（不可再分发）。

---

## 一、Web 端（进入 `dist/` 的运行时组件）

| 组件 | 版本 | 用途 | 许可证 | 源码 / 获取地址 |
|---|---|---|---|---|
| Rust `image` | 0.25 | 图片解码与编码（jpeg/png/gif/bmp/tiff/webp） | MIT OR Apache-2.0 | https://github.com/image-rs/image |
| `image-webp` | 0.2 | WebP 解码（经 `image` 的 webp feature） | MIT OR Apache-2.0 | https://github.com/image-rs/image-webp |
| `kamadak-exif` | 0.6 | EXIF 方向读取与元数据剥离 | BSD-2-Clause | https://github.com/kamadak/exif-rs |
| `blake3` | 1.8 | 内容哈希（双端一致性比对、缓存键） | CC0-1.0 OR Apache-2.0 | https://github.com/BLAKE3-team/BLAKE3 |
| `serde` / `serde_json` | 1.0 | 序列化（跨 wasm/IPC 边界的结构） | MIT OR Apache-2.0 | https://github.com/serde-rs/serde |
| `wasm-bindgen` | 0.2.130 | wasm ↔ JS 绑定 | MIT OR Apache-2.0 | https://github.com/rustwasm/wasm-bindgen |
| React | 19.3 | UI 框架 | MIT | https://github.com/facebook/react |
| React DOM | 19.3 | DOM 渲染 | MIT | https://github.com/facebook/react |
| Zustand | 5.1 | 状态管理 | MIT | https://github.com/pmndrs/zustand |
| Vite | 8.3 | 构建工具（产物含少量 runtime） | MIT | https://github.com/vitejs/vite |
| TypeScript | 5.9 | 类型系统（仅构建期） | Apache-2.0 | https://github.com/microsoft/TypeScript |
| binaryen / wasm-opt | 123 | wasm 体积优化（仅构建期） | Apache-2.0 | https://github.com/WebAssembly/binaryen |
| `pdfjs-dist` | 6.5.438 | PDF 按页渲染（PDF→图片） | Apache-2.0 | https://github.com/mozilla/pdf.js |

pdf.js 的 10 个标准字体（Foxit*.pfb，来自 pdf.js 发行包）随构建脚本拷入
`dist/pdfjs/standard_fonts/`，用于补齐 PDF 内未嵌入的标准字体。这些是 **pdf.js 自带的字体资产**，
不是 UI 字体，也不请求外部域名；其许可证随 pdf.js 的 Apache-2.0 一并分发。

**Web 端运行时无 CDN、无统计脚本、无外部字体请求。** 图标为自绘 SVG；若将来引入中文字体，见下方「字体」一节。

### 可选分包：ffmpeg.wasm（**默认不加载**）

| 组件 | 版本 | 用途 | 许可证 | 获取地址 |
|---|---|---|---|---|
| `@ffmpeg/ffmpeg`（wrapper） | 0.12.15 | 浏览器内调用 ffmpeg 的 JS 包装 | MIT | https://github.com/ffmpegwasm/ffmpeg.wasm |
| **`@ffmpeg/core`** | **0.12.10** | **FFmpeg wasm 核心（含编码器）** | **GPL-2.0-or-later** | https://github.com/ffmpegwasm/ffmpeg.wasm |

> ### ⚠️ 关于 `@ffmpeg/core` 的 GPL 义务（必须读）
>
> `@ffmpeg/core` 的 npm 元数据与源码构建脚本表明它以 **GPL-2.0-or-later** 分发，
> 因为其构建启用了 `--enable-gpl --enable-libx264`。
> **它不是 MIT，不能当 MIT 使用**（wrapper 是 MIT，但 core 不是 —— 这两者常被混为一谈）。
>
> 因此本项目的处理方式是：
> 1. **默认不加载、不预取、不预缓存**。用户必须主动点击「改用 ffmpeg.wasm 试试」，才会下载约 31 MB 原始 / 9.7 MB gzip 的分包。
> 2. 点击前弹出许可证说明，明确告知这是 GPL-2.0-or-later 组件，并提供：
>    - 完整对应源码：https://github.com/ffmpegwasm/ffmpeg.wasm （含 `Dockerfile` 与构建脚本）
>    - FFmpeg 上游源码：https://git.ffmpeg.org/ffmpeg.git（对应版本见 core 包的 `package.json`）
>    - 许可证全文：https://www.gnu.org/licenses/old-licenses/gpl-2.0.html
> 3. 站点不在首屏引用它，`scripts/check-budget.mjs` 会断言 `index.html` 不含 ffmpeg 引用。
>
> 若你不接受 GPL 义务，**不使用该按钮即可** —— 视频功能会自动走 WebCodecs（默认路径，无额外义务）。

### 字体

| 组件 | 用途 | 许可证 | 备注 |
|---|---|---|---|
| 系统字体（`-apple-system` / `PingFang SC` / `Segoe UI` 等） | UI 正文 | 各系统自带的字体许可 | **不随站点分发**，只引用字体名，不会产生网络请求 |
| Noto Sans SC（思源黑体，仅「生成含中文的 PDF」时使用） | 结构化 Word→PDF 的中文字形 | **SIL OFL 1.1** | 子集化后 ~1.27 MB woff2；随包分发时保留 `OFL.txt` 与版权声明 |

> OFL 1.1 的两个实际约束（容易忽略）：
> 1. **不得使用保留字体名**：若我们修改了字体（子集化属于修改），不能再叫 "Noto Sans SC"。我们发布时命名为 `MediaToolbox Sans`，并在 `OFL.txt` 旁注明来源。
> 2. **必须随分发提供许可证全文**。仅在 README 里写「用了 Noto」不满足要求。

---

## 二、桌面端（进入安装包的运行时组件）

| 组件 | 版本 | 用途 | 许可证 | 源码 / 获取地址 |
|---|---|---|---|---|
| Tauri | 2.12 | 桌面壳（WebView + IPC） | MIT OR Apache-2.0 | https://github.com/tauri-apps/tauri |
| WRY / TAO | 随 Tauri | WebView 抽象与窗口 | MIT OR Apache-2.0 | https://github.com/tauri-apps/wry |
| `ral`/系统 WebView | 系统自带 | 渲染引擎（WKWebView / WebView2 / WebKitGTK） | 系统组件许可 | 不随包分发 |
| `rayon` | 1.12 | 数据并行 | MIT OR Apache-2.0 | https://github.com/rayon-rs/rayon |
| `tokio` | 1.x | 异步运行时 + 子进程管理 | MIT | https://github.com/tokio-rs/tokio |
| `lopdf` | 0.47 | PDF 结构操作（合并/拆分/旋转/提取） | MIT | https://github.com/J-F-Liu/lopdf |

### 捆绑的 FFmpeg（sidecar）

| 项目 | 内容 |
|---|---|
| 用途 | 视频转码、抽音频、封面帧、GIF、ffprobe 元数据 |
| 构建来源 | Windows/Linux：BtbN/FFmpeg-Builds 的 **`-lgpl-shared`** 变体；macOS：构建机本地编译（`--disable-gpl`，仅启用 VideoToolbox 等系统组件与 BSD 系编码器） |
| 许可证 | **LGPL-2.1-or-later**（构建时未启用 `--enable-gpl` 与 `--enable-nonfree`） |
| 源码获取 | https://git.ffmpeg.org/ffmpeg.git （tag 见 `src-tauri/sidecar/SHA256SUMS` 同目录的版本记录） |
| 构建脚本 | https://github.com/BtbN/FFmpeg-Builds （Windows/Linux）；macOS 的 `configure` 命令行记录在 `scripts/fetch-sidecars.mjs` 的输出里 |
| 合规要点 | ① 动态链接（shared）便于用户替换库；② 安装包内附本文件与 LGPL 全文；③ 提供源码获取地址；④ **不得**把该构建宣称为 MIT |

> ### 什么时候 FFmpeg 会变成 GPL？
>
> 只要构建时加上下列任一开关，产出的二进制即为 **GPL-2.0-or-later**（若同时链接 GPL 库）：
> - `--enable-gpl`（启用 GPL 许可的组件）
> - `--enable-libx264`（H.264 软件编码，GPL-2.0+）
> - `--enable-libx265`（HEVC 软件编码，GPL-2.0+）
> - `--enable-libxvid`、`--enable-libvidstab` 等同样在 `EXTERNAL_LIBRARY_GPL_LIST` 里
>
> 而下列开关会让产物**不可再分发**：
> - `--enable-nonfree`
> - `--enable-libfdk_aac`（要求 `--enable-nonfree`）
>
> 本项目的运行期防线：`src-tauri/src/sidecar.rs` 在启动时读取 `ffmpeg -version` 的 configure 行，
> 若发现上述任一开关，会在「关于」页标红并拒绝启用视频模块 —— 而不是等发布后才被发现。
> CI 的 `scripts/fetch-sidecars.mjs` 也会在拉取后立即核验，失败即中止构建。

**桌面版不启用硬件编码之外的 GPL 编码器**：H.264 编码走系统硬件编码器
（macOS VideoToolbox / Windows NVENC·QSV·AMF / Linux VAAPI），软件编码用 VP9（libvpx，BSD）
与 AV1（SVT-AV1，BSD-2 / libaom，BSD-2）。

### 捆绑的 LibreOffice（headless）

| 项目 | 内容 |
|---|---|
| 用途 | Word→PDF / PDF→Word 的原生转换（优先于结构化兜底）。保真度显著高于结构化路径，但**不承诺无损** |
| 版本 | 26.x（随发布固定） |
| 许可证 | **MPL-2.0**（主体），另含若干其他开源组件 |
| 源码获取 | https://www.libreoffice.org/about-us/source-code/ |
| 许可证全文 | https://www.libreoffice.org/about-us/licenses/ |
| 合规要点 | ① MPL 是**文件级** copyleft：我们未修改其源码，因此无源码公开义务；② 但**必须保留其许可证与版权声明**，安装包内附 `sidecar/THIRD_PARTY_LICENSES`；③ 提供源码获取方式（上述链接）；④ 不得移除其 NOTICE |

> MPL-2.0 与 GPL 的关键区别：MPL 允许与专有代码组合分发，只要求「被修改的 MPL 文件」保持 MPL。
> 我们不修改 LibreOffice，所以只需保留声明。

### pdfium（可选，Phase 5 决定是否启用）

| 项目 | 内容 |
|---|---|
| 用途 | PDF 渲染的备用引擎（当 pdf.js 渲染失败或需要打印级保真时） |
| 许可证 | **BSD-3-Clause** |
| 源码 | https://pdfium.googlesource.com/pdfium/ |
| 说明 | BSD-3 要求保留版权声明、许可条款，且**不得用作者名义背书**。安装包内附全文即可 |

---

## 三、构建期工具（**不随产物分发**，仅列出以示透明）

| 工具 | 用途 | 许可证 |
|---|---|---|
| Rust 工具链 / cargo | 编译 | MIT OR Apache-2.0 |
| wasm-bindgen-cli | wasm 绑定生成 | MIT OR Apache-2.0 |
| binaryen（wasm-opt） | wasm 体积优化 | Apache-2.0 |
| Node.js / npm | 前端构建 | MIT（Node.js） |
| GitHub Actions runners | CI | GitHub 服务条款 |
| Playwright | 端到端测试 | Apache-2.0 |

---

## 四、许可证合规的自检清单

发布前逐项确认（CI 中 `scripts/check-notices.mjs` 会自动校验前 5 项）：

- [ ] 本文件存在，且包含 `@ffmpeg/core → GPL-2.0-or-later` 的声明与源码地址
- [ ] 包含「哪些构建标志会触发 GPL」的说明（`--enable-gpl` / `libx264` / `libx265`）
- [ ] 包含「`--enable-nonfree` / `libfdk_aac` 被禁用」的说明
- [ ] 包含 LibreOffice 的 MPL-2.0 声明
- [ ] 包含 Noto Sans 的 SIL OFL 1.1 声明
- [ ] 桌面安装包内实际包含本文件（`bundle.resources` 里有它）
- [ ] 桌面安装包内包含 FFmpeg 的 LGPL 全文与源码地址
- [ ] 桌面安装包内包含 LibreOffice 的许可证声明
- [ ] 若启用了 ffmpeg.wasm 按钮：点击前的许可证弹窗文案与实际 core 版本一致
- [ ] 未在任何文档中把 GPL 组件描述为 MIT
- [ ] 未在任何 UI 文案中承诺「无损 / 高保真」转换

---

## 五、如何自行核验 FFmpeg 的许可证

```bash
# 1. 看版本与 configure 行
./ffmpeg -hide_banner -version | head -3

# 2. 检查是否含 GPL / nonfree 开关（有输出即为 GPL 或不可再分发）
./ffmpeg -hide_banner -version | grep -E -- '--enable-gpl|--enable-nonfree|libx264|libx265|libfdk'

# 3. 检查是否链接了 GPL 库
ldd ./ffmpeg 2>/dev/null | grep -E 'x264|x265|fdk'
# macOS:
otool -L ./ffmpeg | grep -E 'x264|x265|fdk'
```

本项目的 `scripts/fetch-sidecars.mjs --check` 会自动执行上述第 2 步，失败即中止构建。
