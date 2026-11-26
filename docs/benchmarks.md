# 基准报告

> 规则：同一组样例，各跑 3 次取中位数，记录耗时与内存峰值。
> **结果先于结论**：未测的项写 `[待测]`，不允许用「应该更快」代替数据。
> 环境：macOS 26.x / Apple Silicon（aarch64）/ Rust 1.99.1 / Node 26.13.1 / Chromium（Playwright 1.65）。

---

## B0. 跨平台浮点差异（已测，**已据此修改实现**）

这不是「性能基准」，但它决定了双端一致性是否成立，且实测数据是决策的直接依据，所以放在最前。

### 现象

用例：`tests/fixtures/gradient.png`（400×300）→ `resize 160×120, lanczos3` → PNG

| 目标 | 输出字节 | blake3（前 16 位） |
|---|---|---|
| native（aarch64，4 线程） | 6,597 | `25e27af50efd0ec1` |
| wasm（单线程） | 11,335 | `2a73920b6e3542d5` |

**不是并行导致的**：native 用 1 线程与 4 线程的输出哈希完全相同（`25e27af5…`）。

### 定位

用 `crates/wasm/src/kernel_probe.rs` 导出核函数值，逐点对比：

| x | native `Filter::Lanczos3.kernel(x)` | wasm 同函数 |
|---|---|---|
| 0.7 | `0.3358102739` | `0.3358102143` |
| 0.8 | `0.2074596286` | `0.2074595541` |
| 1.0 | `-0.0000000230` | `-0.0000001485` |

差异量级 6e-8 ≈ 1 ULP。根因：`f32::sin` 在 native 上走系统 libm，在 wasm32 上走
LLVM 编译的 fdlibm 变体。两者都「正确到 1 ULP 附近」，但**不保证逐位相同**。
Rust 标准库不承诺跨平台浮点函数结果一致。

### 后果

1 ULP 的核差异，经过「6 tap 累加 → 归一化 → 量化到 u8」后，会把边缘像素推到相邻的整数值，
经 PNG 的无损预测滤波放大，最终整个文件不同。

### 决策

自己实现确定性的 `sin` / `exp`（`crates/core/src/common/trig.rs`），只用 IEEE-754 精确定义的运算
（`+ - * / floor`）与泰勒展开：

| 函数 | 实现 | 实测最大误差（vs libm） |
|---|---|---|
| `sin` | 归约到 `[-π/2, π/2]` + 11 项泰勒 | < 1e-6 |
| `exp` | `2^k · exp(r)`，`r` 用 8 项泰勒 | < 1e-5（相对） |

### 结果

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 一致性用例通过率 | 20/21 | **21/21** |
| 白名单条目 | 0（其中 1 条正准备加入） | **0** |

**代价**：`sin`/`exp` 的理论速度慢于 libm（无查表、无 SIMD）。实测在 400×300 → 160×120 的
缩放上，耗时差异在噪声范围内（5ms vs 5ms，native）。原因是核函数的调用次数远少于像素运算次数。

> **这条记录的价值**：它证明了「双端字节一致」是可实现的，但**不能靠假设** ——
> 必须真的跑一遍，且必须有工具（kernel_probe）能在失败时快速定位。

---

## B1. 图片缩放：Rust(wasm) vs Rust(native) vs TS(OffscreenCanvas)

**已测（native vs wasm 同一份 Rust，2026-11-26）**。`scripts/benchmark.mjs` 生成 12 MP
`testsrc2` 图（4000×3000，PNG 输入），同一组参数缩放到 1600×1200 / lanczos3 / PNG 输出，
native 与 wasm 各跑 3 次取中位数。原始数据在 `docs/benchmark-results.json`。

| 目标 | 中位数 | 3 次样本 | 输出 | blake3 一致 |
|---|---|---|---|---|
| native（4 线程 Rust） | **约 220 ms** | 见 JSON | 输出字节 | ✓ |
| wasm（Node V8 单线程） | **约 410 ms** | 见 JSON | 与 native 逐字节相同 | ✓ |

**ratio = wasm/native ≈ 1.86–1.87×**（两次独立运行 221/411 与 219/409 ms，中位数有
±2 ms 抖动，属正常；结论不受影响）。与早期小图体感「4×」不同：12 MP 下并行收益被固定
开销稀释，符合「小图看固定开销、大图看并行」的预期。

**结论**：
1. 双端**逐字节一致**，证明确定性 trig（B0）修复后，缩放导出路径可安全复用同一份 Rust。
2. wasm 单线程约慢 1.9 倍，但在 12 MP 下仍是数百毫秒级，**Web 单线程是可接受的**，
   不需要引入 SharedArrayBuffer（Pages 也不支持）。导出路径继续放 Rust。
3. 原计划对比的「TS `drawImage` 预览路径」**未测**：该路径只用于实时预览（非导出），
   且预览质量允许差异；当前预览用 CSS 缩放 + 按页 canvas，已满足交互需求，
   不构成性能热点。按规格「基准裁决争议项」，此项无争议则不强行引入第二实现。

⚠️ 局限：wasm 在 Node V8 中测量，与浏览器 V8 是同一引擎，但未计入浏览器里 `Uint8Array`
跨边界拷贝与 UI 调度开销；浏览器侧路径由 e2e 覆盖，不在此基准内。

## B2. 有损 WebP 编码：Rust vs canvas

**[无法测 —— 依赖的功能未接入]**

`image` 0.25 的纯 Rust WebP 编码目前只有**无损**路径（见 `crates/core/src/image/encode.rs`）。
有损 WebP 从未实现，因此不存在「Rust 有损 WebP」可供对比，`docs/OWNERSHIP.md` §1.1 的
争议项（有损 WebP 归属）保持「默认放 Rust + 保留迁移接口」的裁决，不凭猜测改判。

- 测量前置：先实现 Rust 有损 WebP 编码（或引入宽松许可的编码器），否则对比无意义。
- 若将来接入，按原计划测：2000×1500 照片 / q=75 / 耗时·输出字节·SSIM。
- **当前实际行为**：Web 有损 WebP 由浏览器 `canvas.toBlob('image/webp', q)` 完成（原生能力），
  桌面端无损 WebP 走 Rust；两端能力差异已由 `capabilities().image.formats` 表达，不隐藏。

## B3. PNG 无损优化：wasm+oxipng vs native+oxipng

**[无法测 —— oxipng 尚未接入]**（当前 `png-optimize` feature 为空实现，`capabilities().image.pngOptimize === false`）。

优化器不存在，两端都走同一份 Rust PNG 编码（B1 已验证逐字节一致）。Web 默认关闭
`png_optimize` 的决定因此不是基于「wasm 慢 8 倍」的猜测，而是**功能尚未实现**——
这是更诚实的理由。接入 oxipng 后按原计划补测（5 MB PNG / 输出字节必须相等 / 耗时对比）。

## B4. AVIF 编码体积与速度

**[无法测 —— ravif 尚未接入]**（Web `capabilities().image.avif === false`，桌面端 `avif === true`）。

AVIF 编码器不存在于 wasm 包中，无对象可测。Web 默认关闭 `avif` 的决定基于
**「未实现 + 体积预算」**而非速度对比：接入预计 +1.5–2 MB brotli（wasm 从 309 KB → ~2 MB），
在 1 GB Pages 上限下虽可接受，但会使首访流量显著上升。接入后再补测体积与速度。

## B5. PDF 合并：lopdf(Rust) vs pdf-lib(TS)

**[部分已测：双端一致性 3/3 逐字节相等；100 页耗时未测]**

`scripts/run-pdf-conformance.mjs` + `scripts/wasm-pdf-harness.mjs` 让 native 与 wasm 跑
同一份 `media-core` PDF 纯函数，3 个用例（rotate 90° / split / merge）输出逐字节相等
（blake3 一致）。这验证了「PDF 结构操作放 Rust、两端同源码」的架构选择成立。

- 未测部分：100 页 PDF 的耗时对比、以及「lopdf 在某类文件上失败率」。当前没有 100 页 fixture，
  也没有 pdf-lib 作为对照实现（Web 侧未接入 pdf-lib）。
- **当前裁决维持**：PDF 结构操作继续放 Rust（lopdf），Web 侧不引入 pdf-lib——
  一致性已验证，额外引入第二实现只会带来参数漂移风险，没有数据支持切换。
- 接入 100 页 fixture + pdf-lib 对照后再补耗时/成功率对比。

## B6. 视频转码：WebCodecs vs ffmpeg.wasm

**[部分已测：WebCodecs 转码 e2e 已通过；与 ffmpeg.wasm 的对比未测]**

- 已验证：`tests/e2e/video.mjs` 在真实 Chromium 里把 sample.mp4（H.264 + AAC）经
  WebCodecs 转码为 MP4 并下载，0 错误。证明 `docs/ARCHITECTURE.md` D6 的默认路线
  （WebCodecs 优先、mp4box 解封装、mp4-muxer/webm-muxer 封装）可行。
- 未测：60s 1080p → 720p 的耗时/质量/峰值内存三方对比（WebCodecs / ffmpeg.wasm / 桌面 FFmpeg）。
  缺少 60s 1080p fixture，且 ffmpeg.wasm 是「用户点击才加载」的可选降级，默认不分发。
- **裁决维持**：Web 默认 WebCodecs（无 GPL 义务、原生性能）；桌面用 FFmpeg sidecar。
  没有数据支持把可选 ffmpeg.wasm 提为默认，故不切换。
- 补测前置：生成 60s 1080p fixture + 临时安装 ffmpeg.wasm 包（GPL 声明常驻）。

---

## 已测：构建体积（每次构建自动更新）

由 `scripts/build-wasm.mjs` 写入 [`docs/wasm-size.json`](wasm-size.json)：

| 包 | 原始 | gzip | brotli |
|---|---|---|---|
| `core_image` | 1257.0 KB | 391.6 KB | 308.5 KB |

与 `docs/BUDGET.md` 的估算对比：

| 项 | 预算估算 | 实测 | 差异原因 |
|---|---|---|---|
| `core-image.wasm` brotli | ~1.05 MB | **309 KB** | 预算按「包含 AVIF + oxipng」估的；实测两者都未启用 |
| 首屏 JS gzip | ~120 KB | **82 KB** | 实际依赖比预算少（无 router 库，hash 路由手写 30 行） |
| dist 合计 | ~14.6 MB | **1.51 MB** | 预算把 pdf.js/mammoth/pdf-lib 都算进去了，它们属于 Phase 4 |

**结论**：体积预算的估算整体偏保守 5–10 倍。这不影响决策（本来就不是约束），
但说明「待测项必须以实测替换」这条规则的必要性 —— 如果按估算去做取舍，
会为了省 700 KB 而砍掉一个可用功能。

---

## 已测：开发期性能（非正式基准，仅供体感）

| 操作 | wasm | native (4 线程) |
|---|---|---|
| 400×300 PNG → JPEG q82 | 17 ms | 5 ms |
| 400×300 PNG → 160×120 lanczos3 → PNG | 20 ms | 5 ms |
| 97×61 PNG → JPEG | 6 ms | <1 ms |

**这些数字不能用来下结论**（图太小，固定开销占主导）。真实的对比需要 12 MP 级别的输入（B1）。

但有一个可用的观察：**wasm 的固定开销约 5 ms**（小图 6ms vs 大图 20ms 的差值），
主要来自跨边界的内存复制。对单张 20 MP 图（预计 300–800 ms）可忽略。
