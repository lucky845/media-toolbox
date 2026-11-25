# 架构结论（Phase 0 交付物 1/8）

> 仓库：`lucky845/media-toolbox`　站点：`https://media-toolbox.lucky845.top/`（自定义域，base=`/`）
> 桌面首目标：macOS（不签名 dmg + 首次打开放行说明），CI 同时出 Windows/Linux 产物但首轮只标 macOS「已验证」。
> 本文只写**已定的决策与理由**。接口契约见 `docs/CONTRACTS.md`，热点归属见 `docs/OWNERSHIP.md`，能力矩阵见 `docs/CAPABILITIES.md`，预算见 `docs/BUDGET.md`，CI 见 `docs/CI.md`，浏览器矩阵见 `docs/COMPATIBILITY.md`，分阶段计划见 `docs/PLAN.md`。

---

## 0. 十条决策（先看这个）

| # | 决策 | 理由（不是偏好） |
|---|---|---|
| D1 | Rust workspace 四 crate：`ports` / `core` / `wasm` / `native`，依赖方向 `core → ports`，`wasm → core`，`native → core` | 平台差异只能出现在 `wasm`/`native` 两个叶子 crate；`core` 只认 trait，编译期就挡住了「顺手 use rayon」 |
| D2 | 并行唯一入口是 `ports::Parallel`，`core` 内**禁止**出现 `rayon` / `cfg(target_arch)` / `thread` | Pages 无 COOP/COEP → 无 SharedArrayBuffer → 无 wasm threads；把并行做成依赖注入是唯一两端同源的办法 |
| D3 | 前端一份，`Backend` 适配器在启动时按**运行时能力探测**选实现；`features/**` 里不允许出现 `if (isTauri)` 分支 | 能力由 `capabilities()` 决定，不是由「打没打成桌面」决定；否则 WebCodecs 不可用的 Chrome 也会走错分支 |
| D4 | wasm 构建链：`cargo build --target wasm32-unknown-unknown` → `wasm-bindgen --target web` → `wasm-opt -Oz`（binaryen 的 npm 版） | 不用 wasm-pack：它联网拉 binaryen/geckodriver，CI 不可复现；npm 的 `binaryen` 是纯本地二进制的替代，版本可锁 |
| D5 | 图片全链路（解码/色彩/重采样/编码/无损优化/EXIF）放 Rust core，两壳同一份 | 逐像素循环 + 单份 >4MB buffer 变换 + 必须复用的算法，命中判据三条 |
| D6 | 视频：WebCodecs + 宽松许可 muxer 为默认；ffmpeg.wasm 是**用户点击才下载**的可选分包（GPL 声明）；桌面走 FFmpeg sidecar | 见 §6 三路线裁决（有数据） |
| D7 | PDF 渲染用 pdf.js（Web）/ pdfium 或 pdf.js（桌面兜底），PDF 结构编辑（合并/拆分/旋转/抽页/抽文本）放 Rust `lopdf` | 渲染是浏览器/PDFium 的强项，415 KB br vs pdfium wasm 1.83 MB br；而结构编辑是字节级重排，正合 Rust |
| D8 | 视频的 **argv 构造** 与 **进度换算** 放 Rust core（纯函数），Web(ffmpeg.wasm) 与桌面(sidecar) 共用 | 这是最容易两端各写一份、然后参数不一致的地方；做成纯函数后天然可单测 |
| D9 | 体积不是本站的主要约束（全量 dist ≈ 14.6 MB，占 1 GB 上限的 1.5%；可选 ffmpeg 另计），**流量与「10 分钟部署超时」才是** | 见 `docs/BUDGET.md` 的三笔账；结论直接决定了「分包懒加载 + SW 缓存」的优先级高于极限压缩体积 |
| D10 | 所有阈值（20 MP / 20 MB / 200 MB / 5 min / 100 页）只写在 `crates/core/src/common/limits.rs`，TS 侧**只能**通过 `capabilities()` 读，禁止硬编码 | 阈值写两处是双形态最常见的漂移源 |

---

## 1. 双形态一张图

```
                       ┌─────────────────────────────────────────────┐
                       │  src/  (一份前端：React 19 + TS + Zustand)   │
                       │  features/  store/  components/  workers/    │
                       └───────────────┬─────────────────────────────┘
                                       │ 只依赖 Backend 接口
                       ┌───────────────▼─────────────────────────────┐
                       │        lib/backend/types.ts  (契约)          │
                       │  capabilities() · limits() · run() · cancel()│
                       └───────┬───────────────────────┬─────────────┘
                    Web 实现   │                       │  Desktop 实现
        ┌──────────────────────▼───────┐     ┌─────────▼──────────────────┐
        │ WebBackend                   │     │ DesktopBackend             │
        │  Worker 池(1–2) + wasm       │     │  invoke() + listen()       │
        │  WebCodecs / pdf.js / FSA    │     │  Tauri 2 commands          │
        └──────────────┬───────────────┘     └─────────┬──────────────────┘
                       │                               │
        ┌──────────────▼───────────┐     ┌─────────────▼────────────────┐
        │ crates/wasm (cdylib)     │     │ crates/native (rlib)         │
        │ wasm-bindgen 薄包装      │     │ rayon / fs / subprocess 包装 │
        │ SerialParallel           │     │ RayonParallel                │
        └──────────────┬───────────┘     └─────────────┬────────────────┘
                       └───────────────┬───────────────┘
                                       │  同一份
                       ┌───────────────▼─────────────────────────────┐
                       │ crates/ports  (trait: Source Sink Progress   │
                       │   CancelToken CodecProvider Parallel Limits) │
                       ├─────────────────────────────────────────────┤
                       │ crates/core   (image color pdf video office  │
                       │   纯 &[u8]/Vec<u8> + 参数 struct，无 IO)     │
                       └─────────────────────────────────────────────┘
```

**「只改 core 一处、两端同时生效」为什么必然成立**：`core` 只依赖 `ports` 的 trait。`wasm` 与 `native` 都不复制算法，只注入不同的 `Parallel` / `ProgressSink` / `CancelToken` 实现。所以任何 `core` 改动被两个 cdylib/rlib 同时编进去，不存在第二条路径。Phase 1 用同一处重采样核改动 + 两端产物哈希对比来证明（验收脚本见 `docs/PLAN.md` P1-4）。

---

## 2. Cargo workspace 分层

### 2.1 依赖方向（编译期约束）

```
ports   → (serde, thiserror)                 无 std 之外的重依赖
core    → ports                              禁 rayon / 禁 std::fs / 禁 std::net / 禁 std::thread
wasm    → core, ports, wasm-bindgen          只允许这里出现 wasm32 专属代码
native  → core, ports, rayon, tokio?         只允许这里出现 fs/subprocess/thread
src-tauri → native, tauri                    只允许出现 Tauri API
```

`core` 的边界用 CI 强制：`scripts/check-core-boundary.mjs` 在 `crates/core/src/**` 里 grep `rayon|std::fs|std::net|std::thread|cfg\(target_`, 命中即 fail。这条规则比口头约定有用得多。

### 2.2 为什么 `ports` 独立成 crate 而不是 `core` 的子模块

因为 `native` 要为 `core` 的类型实现 `Source`/`Sink`，如果 trait 定义在 `core` 里，`native` 就必须 `impl core::Source for native::FileSource` —— 这在 Rust 里是允许的（trait 在 core，类型在 native），但会迫使 `core` 暴露一批 `pub trait` 供外部实现，语义上等同把 ports 公开。独立 crate 更清楚，也让「core 是否能通过边界检查」变成一次 `cargo tree` 的事。

### 2.3 各 crate 的 Cargo.toml 关键依赖（版本已核实）

| crate | 依赖 | 说明 |
|---|---|---|
| `ports` | `serde 1`, `thiserror 2` | 无 `image`，保证 trait 层不被算法库污染 |
| `core` | `image 0.25`（feature 裁剪）, `image-webp 0.2`, `oxipng 10`, `kamadak-exif 0.6`, `lopdf 0.47`, `serde_json 1.0`, `blake3 1.8` | `ravif 0.13` 仅在 `avif` feature 下 |
| `wasm` | `wasm-bindgen 0.2.130`, `js-sys`, `web-sys`, `console_error_panic_hook` | `crate-type = ["cdylib","rlib"]` |
| `native` | `rayon 1.12`, `tokio`, `serde`, `serde_json`, `which` | 子进程用 `tokio::process` |
| `src-tauri` | `tauri 2.12`, `tauri-plugin-shell`, `tauri-plugin-dialog`, `tauri-plugin-fs` | sidecar 走 `bundle.externalBin` |

`image` 的 feature 必须显式裁剪（默认 feature 会带上一堆编码器）：

```toml
image = { version = "0.25", default-features = false, features = ["jpeg","png","gif","bmp","tiff","webp"] }
```

`avif` 不进默认集合：`ravif/rav1e` 是纯 Rust 但体积大（预计 +1.5–2 MB br），且 wasm 端是否启用要看 `docs/benchmarks.md` 的实测。**Phase 1 先只在 native 开 `avif`，wasm 侧 feature 默认关**，测完再定。

---

## 3. 并行与内存的 cfg 分流（双形态最易翻车处）

### 3.1 唯一并行入口

```rust
// crates/ports/src/parallel.rs
pub trait Parallel: Sync {
    /// 本机建议并发度：native = rayon 线程数；wasm = 1。
    fn parallelism(&self) -> usize;

    /// 把 buf 按 chunk_len 切块，每块恰好访问一次。块的划分由 core 决定，实现方不得改动。
    fn for_each_chunk_mut(&self, buf: &mut [u8], chunk_len: usize, f: &(dyn Fn(usize, &mut [u8]) + Sync));

    /// 处理 n 个互相独立的工作单元（PDF 页、视频帧段）。
    fn for_each_unit(&self, n: usize, f: &(dyn Fn(usize) + Sync));
}
```

- wasm 实现 `SerialParallel`：`parallelism()==1`，两个方法都是普通 `for` 循环。
- native 实现 `RayonParallel`：`buf.par_chunks_mut(chunk_len).enumerate().for_each(...)`，线程池可配（`--threads`）。
- **禁止** `core` 直接 `use rayon`；**禁止** `#[cfg(target_arch = "wasm32")]` 出现在 `core`。

### 3.2 确定性：并行不能改变输出字节

契约是「每个输出行只依赖输入行」：

- 重采样（横向分块 / 纵向按行）、色彩调整、裁剪、旋转：行局部，块划分不影响结果。
- 累加类运算：一律 `f64` 累加，且累加顺序固定为按列升序（不因分块改变），避免 `f32` 结合律差异与 FMA 融合差异造成 wasm/native 字节不一致。
- **不做并行**的：zopfli/`oxipng` 的熵编码（该库自带并行开关，我们在 wasm 侧关掉，native 侧开）、任何「需要看全图统计量」的算子（如直方图均衡，先做两遍：统计串行 → 应用并行）。

这条契约直接支撑 Phase 6 的「两端同源一致性测试」：同一输入 → 两端输出**字节相同**；若某编码器做不到，测试报告必须写明差异原因（例如 AVIF 的 rav1e 多线程非确定），而不是「允许不一致」。

### 3.3 内存

- wasm32 线性内存上限 4 GB，浏览器单 tab 实际可用通常远低于此；输入输出各自还要在 JS 堆与 wasm 堆各有一份。
- 峰值模型：`输入字节 + 解码 RGBA(W*H*4) + 编码器工作区(≈1–1.5×RGBA) + 输出字节`。
  20 MP 的 RGBA 是 80 MB，所以 20 MP 图的峰值约 `20MB + 80MB + 80MB + out ≈ 200 MB`。这是阈值定 20 MP 的算术依据，不是拍脑袋。
- native 一律「流式读 + 临时文件 + 子进程」：图片可全量（单图 ≤ 200 MB 时才全量），视频/文档**绝不**全量进内存。

### 3.4 阈值（唯一来源 `crates/core/src/common/limits.rs`）

| 项 | Web | Desktop | 超限行为 |
|---|---|---|---|
| 图片 | ≤ 20 MP 且 ≤ 20 MB | 无硬限（受内存） | 中止 + 桌面版引导弹窗 |
| 视频 | ≤ 200 MB 且 ≤ 5 min | 无硬限 | 同上 |
| PDF | ≤ 100 页 | 无硬限 | 同上 |
| 并发 | 1–2 worker | rayon 自适应 + 子进程池可配 | — |

Web 端「超限」= 拒绝执行 + 明确文案，**不做「先试试看」**。理由：wasm OOM 的表现是 tab 崩溃，用户拿不到任何信息，比拒绝更糟。

---

## 4. Backend 抽象：怎么做到 features/ 零 if 分叉

### 4.1 三个约束

1. `features/**` 只能 `import { backend } from '@/lib/backend'`，禁止 import 任何 `@tauri-apps/*` 或 `wasm` 模块（CI 用 `scripts/check-no-branching.mjs` 拦截）。
2. 差异化只能通过**数据**表达：`capabilities()` 返回的对象决定 UI 渲染什么按钮、显示什么提示、给什么阈值。
3. 同一个 UI 组件在两端渲染同一棵 DOM，只是某些按钮 `disabled` 且旁边挂 `LimitNotice`。

### 4.2 能力探测的时机

启动时（`main.tsx` 渲染前）调用一次 `backend.capabilities()`，结果进 Zustand；之后所有 `limits()` 读缓存。探测内容：

- Web：`'VideoEncoder' in window`、`'showSaveFilePicker' in window`、`navigator.userAgent` 主版本、`navigator.storage.estimate()`、`crossOriginIsolated`（在 Pages 上恒为 false，仍要探测，以便开发者本机用 COOP/COEP 验证）。
- Desktop：`invoke('probe_capabilities')`，返回 sidecar 是否存在/版本、ffmpeg configure 行、硬件编码器探测结果、LibreOffice 是否可用。

**关键点**：`capabilities()` 是异步的且可能失败；UI 必须先渲染「探测中」，不允许 `if (isDesktop)` 兜底。

### 4.3 为什么不做一个「全部 task 都是 RPC」的通用 run

因为两端的取消语义完全不同：Web 是 `worker.terminate()`（立即、不可恢复），桌面是 kill 进程树 + 清临时文件（有延迟、要等 reap）。`Backend.run()` 只承诺「返回一个 `Promise<Result>`，且 `signal.aborted` 后尽快 settle 为 `E_CANCELLED`」，具体保证的**强度**由 `capabilities().cancel.hard` 描述（web=false，desktop=true），UI 文案按这个值调整（「已取消」vs「正在停止…」）。

---

## 5. GitHub Pages 的边界与代价（正面写清）

| 项 | 事实 | 对本项目的后果 |
|---|---|---|
| 自定义响应头 | **不支持**（官方 issue 明确无 ETA） | 无法设 COOP/COEP → `crossOriginIsolated === false` → 无 SharedArrayBuffer → **无 wasm threads / 无 rayon-wasm**。这是 D2 存在的原因 |
| `.wasm` MIME | 实测 Pages 返回 `content-type: application/wasm` | `instantiateStreaming` 可用；但仍必须实现降级（见 §5.1） |
| Cache-Control | 实测全站 `max-age=600`（10 分钟） | 回头客「零流量」不能只靠 HTTP 缓存，**必须靠 Service Worker**（SW 自己控制缓存策略） |
| URL 版本化 | Pages 无法自定义长缓存头 | 用「文件名带 hash」实现内容寻址；`index.html` 走 SW 的 `network-first`，其余 `cache-first` |
| SPA rewrite | 无 | 用 **hash 路由**（`#/image`），选它的原因不是「省事」，而是 `404.html` 兜底在深层路径下会把相对资源路径搞乱 |
| 部署超时 | 10 分钟 | Rust+wasm 全量构建约 2–4 分钟（有缓存时 <1 分钟），安全；但**不能**在部署 job 里现场编译 FFmpeg/LibreOffice |
| 站点体积 | ≤ 1 GB | 全量 dist ≈ 14.6 MB，用掉 1.5%，不是约束；可选 ffmpeg 分包 +31 MB 原始（仅用户点击才下载） |
| 带宽 | 100 GB/月软限 | 真正的约束，见 `docs/BUDGET.md` |
| 构建次数 | 10 次/小时软限（**自定义 Actions 工作流不受此限**） | 无关 |
| 条款 | 明确禁止「在线商业 / 电商 / SaaS」 | 定位个人开源免费工具；无广告、无统计、无支付、无变现组件、无账号 |
| 仓库公开性 | Free 计划 Pages 仅公共仓库 | 源码公开。若要保护源码：私有源仓库 + Actions 用 deploy key 推 dist 到公共 Pages 仓库（免费），但**站点本身仍公开** |

### 5.1 wasm 加载策略（必须在 Phase 2 验证）

`wasm-bindgen --target web` 生成的 `__wbg_init` 本身会在 MIME 不符时回退（内部先 `instantiateStreaming`，失败再 `fetch → arrayBuffer → WebAssembly.instantiate`）。我们的 `src/lib/backend/web/wasmLoader.ts` 仍然**自己实现一遍**显式逻辑，不依赖生成代码的隐式行为：

```
1. 若 (window.crossOriginIsolated 无关) → try WebAssembly.instantiateStreaming(fetch(url), imports)
2. catch → const buf = await (await fetch(url)).arrayBuffer(); WebAssembly.instantiate(buf, imports)
3. 仍失败 → 检查 response.headers['content-type']，错误码 E_WASM_MIME 并给出实际 MIME，便于线上排障
```

理由：Pages 上 MIME 是对的，但本地 `python -m http.server` 会给出 `application/octet-stream`（`http.server` 的 mimetypes 在部分版本/系统上不认识 `.wasm`），这正是「两种本地部署方式」里必然遇到的差异。**一句话：MIME 正确是运气，降级路径才是功能。**

### 5.2 base 与路由

- `vite.config.ts` 里 `base: process.env.VITE_BASE ?? '/'`；当前用自定义域 → `/`。
- 若切回项目页 `<user>.github.io/<repo>/`：设 `VITE_BASE=/<repo>/`，并在 GitHub Settings → Pages → Custom domain 里**删掉**自定义域（Actions 部署不依赖仓库里的 CNAME 文件）。
- 所有资源引用走 `import.meta.env.BASE_URL`，禁止 `"/foo.wasm"` 这种绝对路径。
- 路由用 `hash`，`public/404.html` 只作为「有人手输错路径」的兜底页（不做重定向 hack，避免与 hash 路由冲突）。

---

## 6. Phase 0 必交：Web 视频三路线裁决

| 维度 | A. WebCodecs + muxer | B. ffmpeg.wasm（单线程） | C. 桌面 FFmpeg sidecar |
|---|---|---|---|
| 包体（首访额外流量） | ≈ 0（浏览器自带编解码器）+ muxer 40–60 KB br | core **31 MB 原始 / 9.7 MB gzip / 6.9 MB brotli**（实测数据） | 不占 Web 流量；桌面安装包 +60–90 MB |
| 格式覆盖 | 容器限 MP4/WebM；编码器 = 浏览器/OS 决定的那些（H.264 常见，HEVC/mkv/mov 不保证） | 接近桌面；受单线程速度限制 | 全格式 |
| 速度 | 硬件解码/编码，最快 | 单线程 wasm，通常比原生慢 5–15×，无硬件编码 | 原生，最快 |
| 许可证 | 无额外义务（用 MIT/BSD 的 muxer） | **`@ffmpeg/core` 是 GPL-2.0-or-later**（构建含 `--enable-gpl --enable-libx264`），必须附完整对应源码与声明 | LGPL 或 GPL，取决于 sidecar 构建（见 §8） |
| 维护性 | 浏览器标准，长期 | 低活跃（0.12.10 / 2025-01 后仅文档改动） | 我们自己控制 |
| 失败模式 | 编解码器不支持时**必须**能识别并降级 | 内存与速度 | 子进程 |

**结论（D6）**：A 为默认主路径；B 做成**用户显式点击「改用 ffmpeg.wasm 试试」才下载**的可选分包（不默认加载、不默认 prefetch）；C 只存在于桌面。

三条理由，按权重排序：

1. **许可干净**：A 路线下 Web 站点零 GPL 义务；B 一旦默认加载，等于对所有访客分发 GPL 二进制，声明与源码提供义务立刻变成站点的常驻负担。
2. **流量**：6.9 MB br 的 core 会让「每个新访客平均流量」从约 0.7 MB 涨到 7.6 MB，直接把 100 GB/月 的可承载首访数砍掉一个数量级。
3. **速度**：单线程 wasm 转码在 200 MB 上限内仍然慢到体验不可接受。

B 的降级判定不是猜的，是 `capabilities().video` 里 `decoders/encoders` 由 `VideoDecoder.isConfigSupported()` 逐个探测得出；不支持就直说「本浏览器不支持该编码，请用桌面版」，而不是偷偷下载 7 MB 再失败。

---

## 7. 目录树（完整，Phase 1 起逐步填满）

```
media-toolbox/
├── Cargo.toml                       # [workspace] members = crates/*
├── Cargo.lock                       # 应用仓库，提交
├── rust-toolchain.toml              # channel = "stable", targets = ["wasm32-unknown-unknown"]
├── package.json / package-lock.json
├── vite.config.ts                   # base=VITE_BASE, hash 路由, 分包 manualChunks
├── tsconfig.json / tsconfig.node.json
├── index.html
├── .gitignore                       # target/ dist/ pkg/ *.wasm node_modules/ sidecar 二进制
├── LICENSE                          # MIT（自有代码）
├── README.md
├── THIRD_PARTY_NOTICES.md
├── .cargo/config.toml               # wasm32 rustflags（不启用 threads/atomics）
├── crates/
│   ├── ports/
│   │   ├── Cargo.toml
│   │   └── src/{lib.rs, source.rs, sink.rs, progress.rs, cancel.rs, parallel.rs, codec.rs, limits.rs, error.rs}
│   ├── core/
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── common/{mod.rs, error.rs, fmt.rs, hash.rs, math.rs}
│   │       ├── image/{mod.rs, decode.rs, encode.rs, resize.rs, colorops.rs, geometry.rs, exif.rs, params.rs}
│   │       ├── color/{mod.rs, space.rs, lut.rs}
│   │       ├── pdf/{mod.rs, pages.rs, merge.rs, split.rs, rotate.rs, extract.rs}
│   │       ├── video/{mod.rs, args.rs, progress.rs, meta.rs}   # 纯函数：argv 构造/进度换算/元数据解析
│   │       └── office/{mod.rs, docx_read.rs, pdf_emit.rs}
│   ├── wasm/
│   │   ├── Cargo.toml               # crate-type = ["cdylib","rlib"]
│   │   └── src/{lib.rs, parallel.rs, progress.rs, cancel.rs, convert.rs}
│   └── native/
│       ├── Cargo.toml
│       └── src/{lib.rs, parallel.rs, source.rs, sink.rs, progress.rs, cancel.rs, process.rs, ffprobe.rs, tempdir.rs}
├── src-tauri/
│   ├── Cargo.toml
│   ├── build.rs
│   ├── tauri.conf.json              # bundle.externalBin, resources, macOS min version
│   ├── capabilities/default.json
│   ├── icons/
│   ├── sidecar/README.md            # 说明二进制从哪来，二进制本身 .gitignore
│   └── src/{main.rs, lib.rs, commands/{mod.rs, image.rs, video.rs, pdf.rs, office.rs, probe.rs}, sidecar.rs, progress.rs, cancel.rs, menu.rs, fsx.rs}
├── src/
│   ├── main.tsx / App.tsx / router.tsx
│   ├── lib/
│   │   ├── backend/{types.ts, capabilities.ts, index.ts,
│   │   │           web/{webBackend.ts, workerClient.ts, wasmLoader.ts, webcodecs.ts, mux.ts},
│   │   │           desktop/{desktopBackend.ts, invoke.ts}}
│   │   ├── format.ts / idb.ts / errors.ts / downloads.ts
│   ├── workers/{protocol.ts, image.worker.ts, pdf.worker.ts, video.worker.ts}
│   ├── features/
│   │   ├── image/{ImagePage.tsx, CompressPanel.tsx, ResultCompare.tsx}
│   │   ├── pdf/{PdfPage.tsx, RenderPanel.tsx, EditPanel.tsx}
│   │   ├── video/{VideoPage.tsx, TranscodePanel.tsx}
│   │   ├── documents/{DocumentsPage.tsx}
│   │   ├── help/{CapabilitiesPage.tsx, LimitsPage.tsx}
│   │   └── settings/{SettingsPage.tsx}
│   ├── components/{Layout.tsx, DropZone.tsx, QueuePanel.tsx, TaskCard.tsx, ProgressBar.tsx,
│   │              LimitNotice.tsx, CapabilityBadge.tsx, PreviewCompare.tsx, ErrorBanner.tsx, DesktopCta.tsx}
│   ├── store/{queue.ts, settings.ts, recent.ts, capabilities.ts}
│   ├── styles/{global.css, theme.css}
│   └── sw.ts
├── public/
│   ├── CNAME                        # media-toolbox.lucky845.top
│   ├── 404.html
│   ├── robots.txt                   # 全站 disallow？不：允许，但无 sitemap 也可
│   ├── icons/
│   └── fonts/                       # 子集化 CJK woff2（构建期生成，产物 .gitignore，仅保留 LICENSE）
├── scripts/
│   ├── build-wasm.mjs               # cargo build → wasm-bindgen → wasm-opt → 体积报告
│   ├── check-budget.mjs             # dist 体积预算闸门
│   ├── check-external-domains.mjs   # 扫描 dist 里的外链域名
│   ├── check-core-boundary.mjs      # core 里禁止 rayon/fs/thread
│   ├── check-no-branching.mjs       # features/ 里禁止 import @tauri-apps
│   ├── fetch-sidecars.mjs           # 构建期拉 FFmpeg/LibreOffice，带校验和
│   └── subset-fonts.mjs             # Noto Sans SC → 子集 woff2
├── tests/
│   ├── protocol.test.ts             # Worker 消息协议
│   ├── limits.test.ts               # 阈值与降级
│   ├── backend.contract.test.ts     # 同一 Backend 契约跑两个 mock 实现
│   └── fixtures/                    # 小样本图（≤ 64 KB，可进 git）
├── docs/{ARCHITECTURE.md, CONTRACTS.md, OWNERSHIP.md, BUDGET.md, CI.md, COMPATIBILITY.md, benchmarks.md, PLAN.md}
└── .github/workflows/{ci.yml, deploy-pages.yml, release-desktop.yml}
```

`dist/`、`crates/wasm/pkg/`、`*.wasm`、`src-tauri/sidecar/*` 全部 `.gitignore`；Web 侧 wasm 由 CI 在构建期从**源码**编译并拷进 `dist`，不进仓库、不下载 Release、不引 CDN。

---

## 8. 许可证立场（不打包票，先定原则）

| 组件 | 许可证 | 义务 | 我们的做法 |
|---|---|---|---|
| 自有代码 | MIT | — | — |
| `image` / `oxipng` / `lopdf` / `ravif`(BSD-3) | MIT / Apache-2.0 / BSD | 保留版权与许可声明 | `THIRD_PARTY_NOTICES.md` 自动生成 |
| pdf.js | Apache-2.0 | NOTICE | 同上 |
| mp4-muxer / webm-muxer | MIT | — | 同上 |
| mp4box.js | BSD-3 | — | 同上 |
| mammoth | BSD-2 | — | 同上 |
| pdf-lib | MIT | — | 同上 |
| Noto Sans CJK SC | SIL OFL 1.1 | 保留版权声明 + 改名要求（若做子集需保留 OFL 文本，且不得用保留字体名） | 子集化后随包分发，附 `OFL.txt` |
| `@ffmpeg/core`（可选分包） | **GPL-2.0-or-later** | 分发二进制 → 提供完整对应源码 + 许可 | 不默认加载；点击前弹许可说明；源码地址指向 ffmpeg.wasm 构建脚本与 FFmpeg 版本 |
| 桌面 FFmpeg sidecar | 取决于构建：无 `--enable-gpl/--enable-nonfree` → **LGPL-2.1-or-later**；含 libx264/x265 → GPL | 见 §8.1 | 见 §8.1 决策 |
| 桌面 LibreOffice | **MPL-2.0** | 文件级 copyleft；分发需保留许可与源码获取方式 | 随安装包附 `LICENSE`/`NOTICE`，并在「关于」里给源码地址 |
| pdfium（若采用） | BSD-3 | — | 仅在体积允许时 |

**一律禁用**：带 `--enable-nonfree` / `libfdk_aac` 的 FFmpeg 构建（不可再分发）；被标称 MIT 但 configure 行含 `--enable-gpl` 的 ffmpeg core。

### 8.1 Phase 5 待你决策：桌面 FFmpeg 的许可档位

- **档位 L（推荐）**：LGPL-2.1-or-later，不带 libx264/libx265。H.264 编码走**系统硬件编码器**（macOS VideoToolbox / Windows NVENC·QSV·AMF / Linux VAAPI），软件编码用 BSD 系编码器（libvpx VP9、libaom/SVT-AV1）。好处：整包无 GPL，源码提供义务为零。
- **档位 G**：带 libx264/libx265 的 GPL 构建，覆盖率最好（任何机器都能软编 H.264），但必须提供完整对应源码、且整个 sidecar 按 GPL 分发（不影响我们自己的 MIT 代码，因为是独立进程）。

我的建议是 L，理由：macOS-first 的机器 100% 有 VideoToolbox；而 GPL 会让「安装包里附源码获取地址」变成每次发版都要核对的义务。

### 8.2 Phase 5 待你决策：LibreOffice 的体积

实测下载体积：macOS arm64 `.dmg` ≈ 286 MB、Windows x64 `.msi` ≈ 359 MB、Linux `.tar.gz` ≈ 211 MB；安装后通常是安装包 1.5–2 倍。也就是说桌面安装包会到 **300–400 MB**，安装后 **≈1–1.3 GB**。

三个选项：(a) 全量捆绑（安装包 300–400 MB，满足「不要求预装」最彻底）；(b) macOS 捆绑、Windows/Linux 出「lite」变体（不含 LO，该功能降级为结构化转换并常驻提示）；(c) 全平台都不绑，Word↔PDF 全平台只做结构化转换（保真度与 Web 同档）。

我建议 (a)，因为你的硬约束 4 明确写了「不要求用户预装任何 PDF 软件」，(c) 直接违反它，(b) 会让平台间能力不一致。

---

## 9. 尚存风险（Phase 0 就摊开说）

| 风险 | 影响 | 缓解 |
|---|---|---|
| `image` 0.25 的 WebP **编码**能力有限（纯 Rust 侧以无损为主，有损需另找） | Web 端「WebP 有损压缩」可能只能靠 `canvas.toBlob('image/webp')` | Phase 1 基准裁决：若 Rust 侧只能无损，则 Web 端有损 WebP 走 canvas 编码器（TS），并在热点表里写明「按基准放 TS」 |
| `oxipng` 在 wasm 下的体积与速度 | 可能 +300–600 KB br | Phase 1 实测，超预算就只在 native 开 |
| `ravif` 体积 | 可能 +1.5–2 MB br | 默认 native-only |
| 两端浮点一致性 | resize 输出字节可能不同 | 固定 `f64` 累加 + 固定顺序；测试用「差异 ≤ 1 LSB」作为可接受线，超过即视为 bug |
| Pages 无 `COOP/COEP` | 无多线程 | 已在 D2 固化，不试图绕过（不引 `coi-serviceworker`：它靠 SW 注入 header，会与我们的 SW 缓存策略打架，且对 `instantiateStreaming` 无收益） |
| 自定义域 DNS 未配 | 站点 404 | Phase 2 部署后按 `docs/COMPATIBILITY.md` 末尾的 DNS 检查清单核对 |

---

## 10. Phase 0 结束时的确认清单

Phase 0 的 8 份交付物：

| # | 文件 | 内容 |
|---|---|---|
| 1 | `docs/ARCHITECTURE.md` | 本文：十条决策、分层、目录树、视频三路线裁决、许可证立场、风险 |
| 2 | `docs/CONTRACTS.md` | 错误码表、Rust/wasm/Tauri/TS 接口、Worker 协议、状态机、内存模型、一致性测试契约 |
| 3 | `docs/CAPABILITIES.md` | 规格 §14 的双形态逐项 ✅/⚠️/❌ + 阈值唯一来源 |
| 4 | `docs/OWNERSHIP.md` | 逐模块 Rust/TS 归属与理由、两类坏味道的 CI 防线、基准待办 B1–B6 |
| 5 | `docs/BUDGET.md` | 逐产物体积、四种访客流量画像、100 GB 承载力、部署超时预算、桌面包体积 |
| 6 | `docs/CI.md` | 三个工作流全文、静态检查脚本清单、GitHub 侧设置命令、版本固定策略 |
| 7 | `docs/COMPATIBILITY.md` | 浏览器能力矩阵、逐浏览器结论、能力探测写法、DNS 检查清单、避坑记录 |
| 8 | `docs/PLAN.md` | Phase 0→6 的改文件清单与验收命令、两端构建命令、阶段门禁 |

请确认以下 5 点，我即进入 Phase 1（Rust workspace + ports + 双包装 + 只做图片压缩 + 两端跑通）：

1. 本文 §0 的十条决策（尤其 D2 并行注入、D4 放弃 wasm-pack、D9「体积不是约束」）。
2. `docs/OWNERSHIP.md` 的热点归属表（逐模块 Rust/TS 及理由是否成立）。
3. `docs/CONTRACTS.md` 的接口（Rust struct / wasm 导出签名 / TS 类型 / Worker 协议 / 状态机 / 错误码）。
4. `docs/BUDGET.md` 的体积与流量预算（含 100 GB/月 的承载力推算）。
5. §8.1 FFmpeg 许可档位（建议 L）与 §8.2 LibreOffice 体积方案（建议 a）。
