# 热点归属表（Phase 0 交付物 4/8）

> 规则：每个模块必须**先**在这里定归属并写理由；有争议的走 `docs/benchmarks.md` 的基准裁决流程（同样例各跑 3 次取中位，记耗时与内存峰值）。未测前先放 Rust 并保留迁移接口。

判据速查（来自规格 §9）：
- **Rust**：逐像素/逐字节循环、色彩空间转换、卷积/滤波/重采样、编解码与熵编码、单份 >4 MB buffer 变换、PDF 内容流与字体映射解析、需要 SIMD/rayon/确定性数值、两壳都要复用的算法。
- **TS**：仅浏览器有的 API（WebCodecs / File System Access / OffscreenCanvas / MediaRecorder / Service Worker / 拖放）、成熟宽松许可 JS 库的非热点部分、UI 与状态机、任务队列编排、预览胶水、Tauri JS API。

---

## 1. 图片

| 模块 | 归属 | 理由 | 迁移接口 |
|---|---|---|---|
| JPEG/PNG/GIF/BMP/TIFF 解码 | **Rust** | 逐字节/逐像素、熵编码（Huffman/LZW 变长解码），两壳都要 | `core::image::decode` |
| WebP 解码 | **Rust**（`image-webp`） | 同上；纯 Rust，wasm 可用 | 同上 |
| WebP **有损**编码 | **待基准裁决**（默认 Rust，备选 TS） | `image`/`image-webp` 在纯 Rust 侧以**无损**为主，有损编码器缺失或很慢是已知情况；浏览器 `canvas.toBlob('image/webp', q)` 反而是原生实现 | 见 §1.1 |
| WebP 无损编码 | **Rust** | 熵编码 + 预测变换，纯 Rust 实现成熟 | `core::image::encode` |
| PNG 无损优化（oxipng） | **Rust**（native 默认开，wasm 视预算） | zopfli/多轮滤波是纯 CPU 循环；wasm 侧体积 +0.3–0.6 MB br **[待测]** | `EncodeOptions::png_optimize` |
| AVIF 编码（ravif） | **Rust，native-only 起步** | 同样需要熵编码与大量变换；rav1e 体积 +1.5–2 MB br，Web 先关 | `avif` feature flag |
| EXIF 方向读取 | **Rust**（`kamadak-exif`） | 字节级 TIFF IFD 解析，两壳复用 | `core::image::exif` |
| EXIF/GPS 剥离与保留 | **Rust** | 同上；避免 JS 侧再引一个 exif 库 | `EncodeOptions::keep_metadata` |
| 裁剪 | **Rust** | 逐像素拷贝，且要处理 alpha 与 stride | `core::image::geometry` |
| 旋转 / 翻转 | **Rust** | 逐像素 + 缓存局部性优化（按行分块） | `core::image::geometry` |
| **重采样（resize）** | **Rust（核心热点）** | 卷积核 + 逐像素，20 MP 图在 JS 里是秒级；Lanczos3 在 wasm 下仍需优化 | `core::image::resize` |
| 亮度/对比度/饱和度 | **Rust** | 逐像素 + LUT；饱和度要转色彩空间 | `core::image::colorops` |
| 色彩空间转换 / gamma | **Rust** | 需要确定性数值与可能的 SIMD | `core::color` |
| 透明 → 不透明背景填充 | **Rust** | 在解码后的 RGBA buffer 上做，属变换链的一环 | `ImageParams::background` |
| 预览（原图/结果对比） | **TS** | `OffscreenCanvas`/`createImageBitmap`/`transferToImageBitmap` 是浏览器 API，Rust 侧做同样的事只会更慢且有 4 GB 限制 | `lib/preview/*` |
| 缩略图（列表用） | **TS** | 用 `createImageBitmap(blob, {resizeWidth})` 是原生解码器 + GPU，比 wasm 快；且不需要字节一致性 | 同上 |
| 拖放 / 文件读取 | **TS** | 浏览器 API，无替代 | `lib/drop/*` |
| 下载 / 目录句柄写入 | **TS** | File System Access API / `<a download>` | `lib/downloads.ts` |

### 1.1 有争议项：有损 WebP 编码

- **默认放 Rust**（未测前按规格要求），保留 `Encoder` 接口。
- **基准用例**：2000×1500 照片，q=75，各跑 3 次取中位，记耗时 + 峰值内存 + 输出字节数 + SSIM。
- **判定**：若 Rust 侧无法做到有损，或耗时 > canvas 的 1.5 倍，则**放 TS**（canvas 编码器），并在本文与 `benchmarks.md` 写明数据。
- **注意**：放 TS 会引入「两壳不一致」——桌面端不能用 canvas 编码（Tauri 的 WebView 虽然也能 canvas，但图像来源是文件路径，走 canvas 会先整包读进 JS）。所以**桌面仍用 Rust**，Web 用 canvas。这是**允许的差异**，但必须由 `capabilities().image.webpLossy.engine` 暴露，UI 不体现（用户只关心结果），测试里标注为「已知差异」。

> 这条是全集里唯一「同一功能两端用不同实现」的地方，所以单独写清楚：差异是**性能取向**的，不是能力取向的。

---

## 2. 视频

| 模块 | 归属 | 理由 | 迁移接口 |
|---|---|---|---|
| 解码/编码（Web） | **TS（WebCodecs）** | 浏览器原生 + 硬件加速；在 wasm 里重写编解码器是规格明令禁止的坏味道 | `lib/backend/web/webcodecs.ts` |
| 容器封装 mux（MP4/WebM） | **TS（mp4-muxer / webm-muxer）** | 成熟 MIT 库；mux 是字节拼接，不是 CPU 热点（相对编解码可忽略） | `lib/backend/web/mux.ts` |
| 容器解析（元数据/首帧） | **TS（mp4box.js）** | BSD-3，成熟；只解析头部与 moov，不做逐帧处理 | `lib/backend/web/probe.ts` |
| **FFmpeg argv 构造** | **Rust（`core::video::args`）** | 两端共用同一份参数语义；纯函数、可单测、可证伪「前端透传任意参数」 | `build_transcode_args` |
| **FFmpeg 进度换算** | **Rust（`core::video::progress`）** | 解析 `-progress pipe:1` 的键值流，是逐行字节处理；两端共用，避免各写一份正则 | `ProgressParser` |
| **ffprobe JSON 解析** | **Rust（`core::video::meta`）** | 只取需要的字段；两壳共用，桌面 native 直接用，Web 侧 ffmpeg.wasm 降级时也能用同一份 | `parse_ffprobe` |
| 帧级处理（缩放/裁切/滤镜链） | **TS（WebCodecs VideoFrame 参数）** | WebCodecs 自带 `VideoFrame` 裁剪与缩放，交给它即可；Rust 侧做等价物要先 `copyTo` 再传回，纯亏损 | `webcodecs.ts` |
| 音频（Web） | **TS（WebCodecs AudioEncoder/Decoder）** | 同编码器理由 | — |
| 桌面 FFmpeg 子进程管理 | **Rust（`crates/native`）** | 进程/管道/信号是 OS 能力 | `native::process` |
| 桌面 ffprobe 调用 | **Rust** | 同上 | `native::ffprobe` |
| 桌面硬件编码探测 | **Rust** | 调 ffmpeg `-encoders` + 平台 API | `tauri::commands::probe` |
| 预览播放器 | **TS** | `<video>` 元素 / `MediaSource` | `features/video` |
| 取消视频任务（Web） | **TS** | `worker.terminate()`；WebCodecs 侧要 `close()` 所有 `VideoFrame` | `webcodecs.ts` |

**为什么不把 mux 放 Rust**：mux 的输入是编码后的 `EncodedVideoChunk`，它们只在 JS 侧存在。要在 Rust 里 mux，就得把每个 chunk（每帧几 KB～几百 KB，200 MB 视频约数千帧）来回过边界，IPC/边界拷贝成本远大于 mux 本身的 CPU。规格也明确把「手写 MP4 muxer」列为禁项，除非基准证明更快。

---

## 3. PDF

| 模块 | 归属 | 理由 | 迁移接口 |
|---|---|---|---|
| 页面渲染（Web） | **TS（pdf.js）** | 浏览器 Canvas + 字体渲染是原生；wasm 重写渲染器无意义。415 KB br 比 pdfium wasm 1.83 MB br 小 4 倍 **[实测]** | `features/pdf/render` |
| 页面渲染（桌面） | **TS（pdf.js）优先，pdfium 兜底（待定）** | 桌面也不需要自研渲染器；pdfium 仅在 pdf.js 渲染失败/需要打印级保真时启用，Phase 5 再定 | `capabilities().pdf.renderer` |
| 虚拟化 / 缓冲池回收 | **TS** | DOM 与内存管理是前端职责；规格明确「禁止全部页留在 DOM」 | `features/pdf/PageVirtualizer` |
| **PDF 结构操作（合并/拆分/旋转/抽页）** | **Rust（lopdf）** | 纯字节层面重排 xref/对象流，正是 Rust 的强项；比 pdf-lib 快且可流式 | `core::pdf::*` |
| **PDF 文本抽取** | **Rust（lopdf）** | 内容流解析 + 字体映射（ToUnicode CMap）是字节级工作，命中判据 | `core::pdf::extract` |
| **PDF 图片抽取** | **Rust（lopdf）** | 从 XObject 里取原始流并重新封装 | `core::pdf::extract` |
| PDF 表单填写（若做） | **TS（pdf-lib）** | 成熟库，非热点 | — |
| PDF 生成（结构化 Word→PDF） | **TS（pdf-lib + fontkit）** | 生成是「排版 + 写对象」，未测前按规格先用成熟库；中文字体子集化在构建期做，运行期只做 glyph 映射 | `features/documents` |

**争议点**：`lopdf` vs `pdf-lib` 做合并/拆分。选 `lopdf` 的理由是**双壳复用**（桌面也用它，避免桌面调 Node 版 pdf-lib 或再写一份 JS）；若 Phase 3 实测 `lopdf` 在某类文件上失败率高，则 Web 侧退回 `pdf-lib` 并记入基准。

---

## 4. 文档（Word ↔ PDF）

| 模块 | 归属 | 理由 |
|---|---|---|
| docx 解析（Web，结构化） | **TS（mammoth）** | BSD-2、成熟；解析 docx 是解 zip + XML 映射，非性能瓶颈 |
| 结构化 PDF 生成（Web） | **TS（pdf-lib + fontkit）** | 排版逻辑与字体嵌入，成熟库；热点（字形定位）在 fontkit 内部 |
| 中文字体子集化 | **构建期（Node，fonttools 或 harfbuzzjs）** | 一次性的构建步骤，不进运行期 |
| LibreOffice headless 调用（桌面） | **Rust（`crates/native`）** | 子进程 + 临时目录；且要处理 LO 的 profile 隔离（`-env:UserInstallation`） |
| 转换结果校验（页数/是否为空） | **Rust** | 复用 `core::pdf` 的读取能力，两端一致 |
| 保真度声明 UI | **TS** | 纯展示 |

**为什么不把 docx→pdf 结构化转换放 Rust**：docx 是 zip+XML，Rust 侧要引入 XML 解析 + 排版引擎，工作量与维护成本远超收益，而且 Web 端本来就必须用 JS 库（不能把 mammoth 移植进 wasm 而只为省 130 KB）。规格的判据明确要求「成熟宽松许可 JS 库的非热点部分」放 TS。

---

## 5. 通用基础设施

| 模块 | 归属 | 理由 |
|---|---|---|
| 队列 / 调度 / 重试 / 状态机 | **TS（Zustand）** | 纯 UI 状态，零计算 |
| Worker 池 | **TS** | 浏览器并发模型 |
| Service Worker 缓存策略 | **TS** | 浏览器 API |
| 拖放、文件选择、目录句柄 | **TS** | 浏览器 API |
| 最近任务持久化（IndexedDB） | **TS** | 浏览器 API |
| Tauri dialog / fs 插件调用 | **TS（`@tauri-apps/plugin-*`）** | 官方 JS API |
| 阈值常量（20 MP / 200 MB / 100 页） | **Rust（`core::common::limits`）** | 唯一来源；TS 通过 `capabilities()/limits()` 读取 |
| 错误码与中文文案 | **Rust（`core::common::error`）** | 唯一来源；TS 通过 `get_error_spec()` 读取 |
| 哈希（内容指纹，用于缓存键/去重） | **Rust（blake3）** | 逐字节；且在两端算出的哈希必须一致（同源一致性测试会用到） |
| 单位/字节格式化 | **TS** | 纯展示，2 行代码；放 Rust 反而多一次边界调用 |
| 日志（本地、可开关） | **TS**（Web） / **Rust**（桌面写文件） | 桌面要落盘，Web 只在内存环形缓冲 |

---

## 6. 两类坏味道的防线（CI 强制）

| 坏味道 | 防线 | 失败表现 |
|---|---|---|
| 为「全 Rust」在 wasm 里重写 WebCodecs 或手写 MP4 muxer | 人工评审 + 本文表格；`scripts/check-budget.mjs` 的 wasm 体积闸门会先炸 | 体积超阈值 |
| 为省事把像素循环写进 TS Worker（导致两壳两份实现） | `scripts/check-core-boundary.mjs`（core 边界）+ 代码评审：任何 `for (let i = 0; i < w*h*4; i++)` 出现在 `src/worker*/**` 都需在 PR 里引用本文条目 | review 拒绝 |
| `core` 里 `use rayon` / `cfg(target_arch)` | `scripts/check-core-boundary.mjs` 直接 fail | CI 红 |
| `features/**` 里 `if (isTauri)` / `import '@tauri-apps'` | `scripts/check-no-branching.mjs` 直接 fail | CI 红 |

---

## 7. 基准待办（Phase 1/3/6 各一批）

| # | 用例 | 对手 | 记录项 | 结论影响 |
|---|---|---|---|---|
| B1 | 20 MP JPEG → resize 50% lanczos3 | Rust/wasm vs TS（`OffscreenCanvas` 的 `drawImage` 缩放） | 耗时、峰值内存、输出 SSIM | 若 TS 更快且质量相当 → 预览路径用 TS，导出路径仍 Rust（导出要字节一致） |
| B2 | WebP 有损 q=75 | Rust vs `canvas.toBlob` | 耗时、字节数、SSIM | 决定 §1.1 |
| B3 | PNG 无损优化 5 MB | wasm+oxipng vs native+oxipng | 耗时、输出字节数（**必须相等**） | 若耗时 > 8×，wasm 侧默认关闭 `png_optimize` |
| B4 | AVIF 编码 12 MP | ravif/wasm vs ravif/native | 耗时、体积、br 体积增量 | 决定 Web 是否开 `avif` feature |
| B5 | PDF 合并 100 页 | lopdf(Rust) vs pdf-lib(TS) | 耗时、成功率、输出可被 pdf.js 打开 | 决定 §3 的争议点 |
| B6 | 视频 60s 1080p H.264 → 720p | WebCodecs vs ffmpeg.wasm（单线程） | 耗时、输出质量、峰值内存 | 验证 §6 的路线结论 |

每项结果写进 `docs/benchmarks.md`，格式固定：`用例 / 环境（机型+浏览器版本+wasm 构建配置）/ 3 次原始数据 / 中位数 / 结论 / 是否改变归属表`。
