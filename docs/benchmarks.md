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

**[待测]** —— 需要 Chrome（`OffscreenCanvas` + `drawImage` 缩放在浏览器里走 GPU/Skia）。

计划：
- 输入：12 MP JPEG（4000×3000）
- 操作：缩放到 1600×1200，lanczos3（Rust）/ `drawImage(imageSmoothingQuality='high')`（TS）
- 记录：耗时、峰值内存（`performance.measureUserAgentSpecificMemory` 不可用 → 用 `performance.memory` 近似）、输出 SSIM
- **结论影响**：若 TS 的 canvas 缩放明显更快且质量相当，则**预览路径**改用 TS，
  **导出路径**仍用 Rust（导出必须字节一致）。

## B2. 有损 WebP 编码：Rust vs canvas

**[待测]**

已知约束：`image` 0.25 的纯 Rust WebP 侧以**无损**为主。若无法做有损，则 Web 端
有损 WebP 只能走 `canvas.toBlob('image/webp', q)`（浏览器原生编码器），桌面端仍用 Rust。

- 输入：2000×1500 照片
- 参数：q=75
- 记录：耗时、输出字节、SSIM
- **结论影响**：决定 `docs/OWNERSHIP.md` §1.1 的归属。若走 TS，需在
  `capabilities().image` 里暴露 `webpLossyEngine: 'canvas' | 'rust'`（已知差异，测试中标注）。

## B3. PNG 无损优化：wasm+oxipng vs native+oxipng

**[待测]** —— oxipng 尚未接入（当前 `png-optimize` feature 为空实现）。

- 输入：5 MB PNG
- 记录：耗时、**输出字节数必须相等**（同一优化器、同一参数）
- **结论影响**：若 wasm 侧耗时 > native 的 8 倍，则 Web 默认关闭 `png_optimize`。

## B4. AVIF 编码体积与速度

**[待测]** —— ravif 尚未接入。

- 预期体积增量：+1.5–2 MB brotli（使 wasm 从 309 KB → ~2 MB）
- **结论影响**：决定 Web 是否启用 `avif` feature。当前默认关闭。

## B5. PDF 合并：lopdf(Rust) vs pdf-lib(TS)

**[待测]** —— Phase 4。

- 输入：100 页 PDF
- 记录：耗时、成功率、输出能否被 pdf.js 正常打开
- **结论影响**：若 lopdf 在某类文件上失败率高，Web 侧退回 pdf-lib。

## B6. 视频转码：WebCodecs vs ffmpeg.wasm

**[待测]** —— Phase 4。

- 输入：60s 1080p H.264
- 操作：转 720p
- 记录：耗时、输出质量、峰值内存
- **结论影响**：验证 `docs/ARCHITECTURE.md` §6 的路线裁决。

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
