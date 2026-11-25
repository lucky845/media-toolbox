# Phase 1 验收报告

> 交付内容：Rust workspace + `crates/ports` + 双包装（wasm / native），只做「图片压缩」一个算法，
> 两端跑通，并演示「改一处代码两端同时生效」。
> 环境：macOS 26.x / aarch64 / rustc 1.99.1 / Node 26.13.1。

---

## 1. 交付清单

| 项 | 位置 | 状态 | 验证方式 |
|---|---|---|---|
| Rust workspace（4 crate） | `Cargo.toml` + `crates/*` | ✅ | `cargo test --workspace` → **175 通过** |
| ports trait 层 | `crates/ports/src/*` | ✅ | 31 个单测（含节流、并行、阈值、错误码穷举） |
| core 算法层 | `crates/core/src/*` | ✅ | 115 个单测（含编解码往返、EXIF、缩放确定性） |
| wasm 包装 | `crates/wasm/src/*` | ✅ | 12 个单测 + 真实 wasm 构建 |
| native 包装 | `crates/native/src/*` | ✅ | 23 个单测（rayon、原子写、UTF-8 文件名） |
| Tauri 2 壳 | `src-tauri/src/*` | ✅ | `cargo check` 通过（commands + sidecar 探测） |
| 前端（一份代码） | `src/**` | ✅ | `tsc --noEmit` 0 错误 + `vite build` 成功 |
| 端到端 | `tests/e2e/smoke.mjs` | ✅ | 真实 Chromium 跑完整流程，0 console 错误，0 外链 |

---

## 2. 核心验收：一处改动，两端同时生效

### 命令

```bash
node scripts/verify-single-source.mjs
```

### 它做什么

1. 构建 wasm + native，跑一组固定输入，记录两端哈希；
2. 改写 `crates/core/src/image/params.rs` 里的一个常量：
   `const LANCZOS_LOBES: i32 = 3;` → `2`（真实的核函数行为改动，不是注释）；
3. 重新构建两端，再跑同一组输入；
4. 断言：
   - 两端输出**仍然逐字节一致**（说明没有引入平台分叉）；
   - Web(wasm) 输出**变了**；
   - 桌面(native) 输出**变了**；
5. 无论成败都恢复源码并重建产物。

### 实际输出

```
=== 验收结果 ===
两端输出仍然字节一致     : ✓
Web (wasm) 输出发生变化   : ✓
桌面 (native) 输出发生变化: ✓
native 并行度             : 4 线程
输出字节（before → after）: 11335 → 6678

✓ 通过：一处改动（crates/core/src/image/params.rs 的一个常量）
  同时改变了 Web 与桌面的输出，且两端仍然逐字节一致。
  这就是「核心算法只写一份」的机器验证。
```

> 哈希值每次运行会变，但四项判定必须全 `✓`。

### 这个脚本本身踩过的两个坑（值得记录）

**坑一：正则改写太脆。**

第一版用**正则改写 `Filter::Lanczos3` 的表达式**。它失败了两次：

1. `cargo fmt` 重排了缩进 → 正则不匹配；
2. 把 `sin` 换成确定性实现后表达式形态变了 → 正则再次不匹配。

这是典型的「测试代码比被测代码更脆」。修复方式不是写更复杂的正则，而是**在实现里加一个语义明确的常量** `LANCZOS_LOBES`：

```rust
pub const LANCZOS_LOBES: i32 = 3;   // 3 = 经典 Lanczos3；2 = 更柔和
```

它本来就应该存在（而不是散落在核函数里的字面量 `3.0`），顺带让「改一处」变成「改一个数字」。
脚本现在会检查锚点是否存在，不存在就明确报错并说明原因 —— 而不是静默地「补丁未生效」。

**坑二：恢复时只重建了一端。**

`verify-single-source` 最初在 `finally` 里只重建 wasm，漏了 native 的 `conformance` 二进制。
结果：下一次跑一致性测试时，**wasm 是原始版、native 是补丁版**，21 个用例里恰好只有
`resize-lanczos-fit` 失败（其他用例不用 lanczos3）。

这种**假阴性**比直接崩溃更难查：你会以为是浮点问题重演，实际是测试工具自己留了脏产物。
修复：恢复时重建**两端**，且重建失败时把 `failed` 置为 true（不允许「恢复失败但仍报通过」）。

---

## 3. 双端一致性：21/21 逐字节相同

### 命令

```bash
node scripts/run-conformance.mjs
```

### 用例矩阵

3 个 fixture（`gradient.png` 400×300 带透明 / `solid.png` 200×150 / `odd.png` 97×61）×
7 组参数（重编码、lanczos 缩放、nearest 精确缩放、旋转+翻转、裁剪+色彩调整、
fill+catmull_rom、gaussian 缩小）= **21 个用例**。

### 结果

```
通过 21 | 白名单 0 | 失败 0
✓ 所有用例两端逐字节一致
```

**白名单是 0** —— 没有任何「已知差异」。这是刻意的：白名单一旦开了口子，
就会变成「反正有白名单」的垃圾桶。

### 一个真实的 bug（记录在案）

第一轮跑出 20/21，失败的是 `resize-lanczos-fit`：

| 目标 | 输出字节 | 哈希 |
|---|---|---|
| native | 6,597 | `25e27af5…` |
| wasm | 11,335 | `2a73920b…` |

排查过程（这次排查工具本身也成了交付物）：

1. 排除并行：native 用 1 线程 vs 4 线程 → 哈希相同 `25e27af5…`；
2. 定位到核函数：新增 `crates/wasm/src/kernel_probe.rs`，导出 `kernel_samples()`，
   对比发现 `kernel(0.7)` 在 native 是 `0.3358102739`、wasm 是 `0.3358102143`；
3. 根因：`f32::sin` 在 native 走 libm，在 wasm 走 LLVM 的 fdlibm 变体，
   两者都「正确到 1 ULP」，但不保证逐位相同；
4. 修复：`crates/core/src/common/trig.rs` 自己实现确定性的 `sin`/`exp`，
   只用 IEEE-754 精确定义的运算；
5. 复测：21/21 全绿。

详见 `docs/benchmarks.md` B0。

---

## 4. 实测体积

| 产物 | 原始 | gzip | brotli |
|---|---|---|---|
| `core_image_bg.wasm` | 1,254 KB | 390 KB | 307 KB |
| 首屏 JS（React + 应用） | 219 KB + 39 KB | 68 KB + 14 KB | — |
| CSS | 5 KB | 1.8 KB | — |
| **dist 合计** | **1.51 MB** | — | — |

占 GitHub Pages 1 GB 上限的 **0.15%**。预算估算（14.6 MB）偏保守约 10 倍，
原因已记入 `docs/benchmarks.md`（估算把所有 Phase 4 依赖都算进了首屏）。

---

## 5. CI 闸门（全部通过）

```
✓ core 边界检查通过：crates/core 里没有 rayon / fs / net / thread / 平台 cfg
✓ 前端分叉检查通过：features/ 与 components/ 没有按壳分支
✓ 外部域名检查通过（扫描 8 个文件，全部为本站资源或已声明的链接）
✓ 体积预算检查通过
✓ 许可证声明检查通过
```

### 这些检查各自抓到过什么

| 检查 | 实际抓到的真实问题 |
|---|---|
| `check-core-boundary` | 无（但设计上防止「写了几百行后再发现 wasm 编不过」） |
| `check-no-branching` | **抓到 4 处**：`Layout.tsx` 与 `CapabilitiesPage.tsx` 在用 `caps.kind === 'desktop'` 分支。修复方式是新增 `lib/backend/summary.ts` 集中派生展示数据 —— 顺带把「改文案要改 4 处」也解决了 |
| `check-external-domains` | 抓到 `react.dev`（React 错误提示字符串）。加入白名单并写明它是「错误提示 URL，非资源加载」 |
| `check-budget` | 无超限 |
| `check-notices` | **抓到 1 处真实违规**：我在 NOTICES 里把 LibreOffice 用途写成「高保真转换」—— 正是规格 §24 禁止的表述。已改为「不承诺无损」 |

---

## 6. 端到端（真实浏览器）

### 命令

```bash
npm run build && npm run preview &
node tests/e2e/smoke.mjs http://localhost:4173 tests/fixtures/gradient.png
```

### 实际输出

```json
{
  "meta": "尺寸 | 400 × 300（0.12 MP） | 格式 | PNG | 大小 | 102.8 KB | 透明通道 | 有 | EXIF 方向 | 1 | 预计峰值内存 | 1.9 MB",
  "task": "gradient.png | 完成 | 102.8 KB | → | 32.4 KB | 节省 68%：102.8 KB → 32.4 KB | 保存",
  "consoleErrors": [],
  "external": [],
  "pass": true
}
```

验证了：wasm 加载（走 `compileStreaming`）、Worker 通信、文件上传、处理、进度、
体积统计、**零 console 错误、零外部域名请求**。

### 在这条路径上修掉的真实 bug

| bug | 表现 | 修复 |
|---|---|---|
| Zustand 订阅整个 store | React 无限渲染（`Minified React error #185`），页面完全白屏 | 改成单值选择器（`useQueue(s => s.paused)`） |
| `DropZone` 的 `<input>` 没有 `onChange` | 键盘用户与自动化都无法选文件 | 接上 `onChange`，并说明它是「原生文件选择的兜底通道」 |
| Worker URL 路径少一层 `../` | 构建失败 `Cannot resolve entry module src/lib/workers/image.worker.ts` | 改为 `../../../workers/image.worker.ts` |
| `getRegistration() !== undefined` 恒真 | UI 谎称「首次访问后可离线使用」，实际 SW 未实现 | 改为检查 `reg?.active?.state === 'activated'`；未激活时显示「尚未缓存（Service Worker 计划在 Phase 3 启用）」 |

最后一条值得单独说：**它不是崩溃类 bug，而是「说了没做的事」**。
在 Phase 1 就把它改对，比等到 Phase 3 再发现用户体验与实际不符要好。

---

## 7. 两端构建命令（对照验证用）

```bash
# Web
node scripts/build-wasm.mjs               # cargo build --target wasm32 → wasm-bindgen
cp crates/wasm/pkg/core_image*.{js,wasm} public/wasm/
npm run build && npm run preview          # http://localhost:4173

# Desktop
cd src-tauri && cargo tauri dev           # 或 cargo tauri build
```

两个命令跑的是**同一份** `crates/core`。

---

## 8. Phase 1 未做（明确边界）

- 裁剪/旋转/色彩调整的 **UI**（组件已有，`ImagePage` 只暴露了缩放与格式/质量）
- PNG 无损优化（`png-optimize` feature 是空实现）
- AVIF（feature 未启用，需先测体积增量）
- PDF / 视频 / 文档（Phase 4）
- Service Worker（Phase 3）
- 桌面 sidecar 二进制（Phase 5；当前 `fetch-sidecars.mjs` 会打印 macOS 的编译指南）
- Tauri 的实际 GUI 运行（`cargo check` 通过，但受本机环境限制未执行 `tauri dev`）

---

## 9. 下一步（Phase 2）

Web 空壳上 Pages，验证：`base` 注入 / hash 路由 / wasm 加载 fallback / 在线 URL 与本地 preview 都能开。

Phase 1 已经把这些的**前置条件**都验证了（MIME、降级加载器、hash 路由），
Phase 2 主要是部署链路与 DNS。
