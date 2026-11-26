# 体积与流量预算（Phase 0 交付物 5/8）

> 结论先行：**体积不是我们的约束（用掉 1 GB 上限的不到 2%），流量与 10 分钟部署超时才是。** 所以优先级是「分包 + 懒加载 + Service Worker 缓存」，而不是「把 wasm 再压 50 KB」。
> 所有数字标注 **[实测]** / **[推算]** / **[待测]**；待测项在 Phase 1/2 的 CI 里落地成闸门。

---

## 1. 站点体积预算（对 1 GB 上限）

| 产物 | 原始 | gzip | brotli | 来源 | 何时下载 |
|---|---|---|---|---|---|
| 外壳 JS（React 19 + ReactDOM + router + zustand） | 约 190 KB | 约 62 KB | 约 52 KB **[推算]** | Vite build | 首屏 |
| 应用代码（features/store/components 拆包） | 约 220 KB | 约 70 KB | 约 58 KB **[推算]** | Vite build | 首屏 + 按路由懒加载 |
| CSS | 约 45 KB | 约 9 KB | 约 7 KB **[推算]** | Vite build | 首屏 |
| `index.html` + manifest + 图标 | 约 30 KB | 约 12 KB | — **[推算]** | 手写 | 首屏 |
| **`core-image.wasm`**（image+color，jpeg/png/webp/gif/bmp/tiff） | **1254 KB [实测]** | **390 KB [实测]** | **307 KB [实测]** | `crates/wasm --features image` | 进入图片页时 |
| **`core-doc.wasm`**（lopdf 结构操作） | 约 1.5 MB | 约 0.55 MB | **约 0.45 MB [待测]** | `crates/wasm --features doc` | 进入 PDF 编辑时 |
| `pdf.js`（`pdf.min.mjs` + `pdf.worker.min.mjs`） | **1.748 MB [实测]**（474+1272 KB） | **516 KB [实测]**（137+380 KB） | **424 KB [实测]**（113+311 KB） | `pdfjs-dist 6.5.438` | 进入 PDF 渲染时（主线程动态 import） |
| pdf.js 标准字体 10 个 `.pfb`（`standard_fonts/`） | 约 1.3 MB **[实测目录]** | — | 低（PFB 已压缩） | `pdfjs-dist/standard_fonts`，构建期拷入 `dist/pdfjs/` | 渲染未嵌入标准字体的 PDF 时；SW 全量预缓存 |
| `mammoth`（docx 解析） | 约 520 KB | 约 160 KB | 约 130 KB **[推算]** | npm | 进入 Word 相关功能时 |
| `pdf-lib` + `fontkit`（结构化生成 PDF） | 约 1.1 MB | 约 320 KB | 约 260 KB **[推算]** | npm | 同上 |
| 中文字体子集 `NotoSansSC-subset.woff2`（GB2312 6763 字） | 8.3 MB 源 → **1.27 MB woff2 [实测]** | — | 1.27 MB | 构建期 `subset-fonts.mjs` | **仅**「结构化生成含中文的 PDF」时 |
| WebCodecs 转码链（`mp4box` + `mp4-muxer` + `webm-muxer` + `videoBackend` 胶水，实测并入 `index-*.js`） | — | **index chunk 90 KB gzip [实测]**（全站入口，含图片/PDF/视频胶水） | **见 dist 合计** | npm | 进入视频页时（代码随入口一起加载，编解码由浏览器原生执行不占包体） |
| **可选**：`@ffmpeg/core`（单线程） | **31 MB [实测]** | **9.7 MB [实测]** | **6.9 MB [实测]** | `@ffmpeg/core 0.12.10` | **只有用户点「改用 ffmpeg.wasm」才下载** |
| **可选**：`@ffmpeg/ffmpeg` 包装 + worker | 约 120 KB | 约 38 KB | 约 33 KB **[推算]** | npm | 同上 |

**dist 合计**：

| 口径 | 原始 | 首访传输（br） |
|---|---|---|
| **Phase 1 实测（只有图片功能）** | **1.51 MB** | **约 0.39 MB** |
| 全部功能（Phase 4 完成后推算） | 约 14.6 MB | 约 2.0 MB |
| 含可选 ffmpeg（在站点上，但懒加载） | 约 45.6 MB | 同上（不点不下载） |

对照 Pages 上限 1 GB：Phase 1 占 **0.15%**，全部功能占 1.5%。结论：**体积从来不是约束**，
哪怕把 AVIF（+1.5–2 MB br）和 oxipng（+0.3–0.6 MB br）都塞进 wasm 也远没到上限。

> 实测比估算小 5–10 倍。估算偏保守的原因是「把所有可能的功能都算进首屏」，
> 而实际的分包懒加载让首屏只含外壳。这条差异已记入 `docs/benchmarks.md`。

---

## 2. 首访与按需下载的路径

```
首访（只打开首页）
  index.html + 外壳 JS/CSS + 图标                      ≈ 120 KB br
  [SW 注册 + 预缓存外壳]

进入「图片」页
  + core-image.wasm                                    ≈ 1.05 MB br
进入「PDF」页
  + core-doc.wasm (1.4 MB) + pdf.js (424 KB)           ≈ 0.86 MB br
进入「视频」页（WebCodecs 路线）
  + mp4box/mp4-muxer/webm-muxer 胶水                    ≈ 0.09 MB gzip [实测]
  编解码由浏览器原生执行，不下载编解码器 wasm
  [若点「改用 ffmpeg.wasm」→ +9.7 MB gzip / 6.9 MB br]
进入「文档」页
  + mammoth + pdf-lib                                   ≈ 0.39 MB br
  [若需要生成含中文的 PDF → +1.27 MB 字体]
```

关键点：**wasm 与字体都不在首屏**。首屏只有约 120 KB br，这是「回头客零流量」能成立的前提——SW 只需要保住外壳与已用过的分包。

---

## 3. 流量预算（对 100 GB/月的软限）

### 3.1 三种访客画像

| 画像 | 下载内容 | 单次流量 |
|---|---|---|
| A. 只逛首页就走 | 外壳 | 约 0.12 MB |
| B. 用图片压缩（最常见） | 外壳 + core-image.wasm | 约 1.17 MB |
| C. 图片 + PDF + 文档（重度） | 外壳 + image + doc + pdf.js + mammoth/pdf-lib | 约 2.43 MB |
| D. C + 用了 ffmpeg.wasm 降级 | C + 9.7 MB | 约 12.1 MB |

### 3.2 可承载的首访量

按 **Phase 1 实测**口径（只用图片功能 = 0.39 MB）：

```
100 GB = 102 400 MB
102 400 / 0.39 ≈ 262 000 次 / 月
```

按**全部功能**口径（新访客平均 1.5 MB br，即大部分是 B、少量 C；且**不计** SW 缓存带来的回访节省）：

```
102 400 / 1.5 ≈ 68 000 次新访客装载 / 月
```

按**悲观**口径（每个人都点 ffmpeg.wasm，12 MB/人）：

```
102 400 / 12.1 ≈ 8 400 次 / 月
```

即：**正常情况 6–7 万新访客/月，最坏情况 8 千/月**。个人开源工具的体量远低于此，所以 100 GB 不是风险；但这条推算解释了为什么 `ffmpeg.wasm` **绝不能**默认加载或预取——它一个人就能吃掉 80% 的预算。

### 3.3 回访成本（SW 的价值）

Pages 全站 `Cache-Control: max-age=600`（10 分钟）**[实测]**，也就是说纯靠 HTTP 缓存，10 分钟后的回访就要重新验证/下载。SW 用 `cache-first`（内容寻址文件）+ `network-first`（`index.html`）后：

| 场景 | 无 SW | 有 SW |
|---|---|---|
| 10 分钟后回访、只用图片功能 | 重新验证 + 命中 304 或重下 ≈ 0.1–1.2 MB | **0 字节**（`index.html` 走 network-first 若 304 则 0 字节） |
| 首次离线访问 | 不可用 | 可用（外壳 + 已用分包） |

结论：SW 不是「加分项」，它是「100 GB 预算下支撑回头客」的唯一手段。这也是为什么它必须在 Phase 3 就上，而不是留到 Phase 6。

---

## 4. CI 体积闸门（`scripts/check-budget.mjs` 的阈值）

| 项 | 阈值 | 超了怎么办 |
|---|---|---|
| `dist` 总体积（不含可选 ffmpeg） | ≤ 20 MB | fail |
| `dist` 总体积（含可选 ffmpeg） | ≤ 60 MB | fail |
| 首屏关键路径（`index.html` + 入口 chunk + 入口 CSS） | ≤ 300 KB br | fail |
| `core-image.wasm` | ≤ 1.6 MB br | warn（fail 线 2.2 MB） |
| `core-doc.wasm` | ≤ 0.7 MB br | warn |
| 任一 JS chunk | ≤ 400 KB br | warn |
| 字体子集 | ≤ 1.5 MB woff2 | fail（说明子集化没生效） |
| 可选 ffmpeg core 是否被**预取** | 必须为「否」 | fail（检查 HTML 与 SW 预缓存清单里不含它） |

阈值都留了余量：闸门的目标是**发现「有人不小心 import 了整个包」**，不是卡死正常迭代。

### 4.1 部署超时预算（10 分钟）

| 阶段 | 冷缓存 | 热缓存 |
|---|---|---|
| `npm ci` | 约 45 s | 约 15 s |
| `cargo build --release --target wasm32` ×2（image / doc） | 约 210 s | 约 40 s |
| `wasm-bindgen` ×2 + `wasm-opt -Oz` ×2 | 约 50 s | 约 30 s |
| `vite build` + 字体子集化 | 约 40 s | 约 25 s |
| `upload-pages-artifact` + `deploy-pages` | 约 60 s | 约 40 s |
| **合计** | **约 6.7 min** | **约 2.5 min** |

冷缓存 6.7 min 距离 10 min 只有 3 分钟余量，所以：
- 必须用 `Swatinem/rust-cache`（或 `actions/cache` 缓存 `~/.cargo` + `target/`），把冷启动变成一次性；
- **禁止**在部署工作流里做任何「现场编译 native 二进制」的操作（FFmpeg/LibreOffice 只在 `release-desktop.yml` 里，且用预编译下载 + 校验和）；
- 若将来 wasm feature 增多导致超时，则改用「wasm 产物单独 job 构建 + artifact 传递」，把并行度提上去。

---

## 5. 桌面安装包体积预算（对 300–400 MB 的预期）

| 组件 | macOS arm64 | Windows x64 | Linux x64 |
|---|---|---|---|
| Tauri 应用本体（Rust core + WebView 资源） | 约 12 MB | 约 14 MB | 约 14 MB |
| FFmpeg sidecar（LGPL 构建） | 约 55 MB（静态）/ 约 35 MB（动态+so） | 约 70 MB | 约 60 MB |
| ffprobe sidecar | 约 55 MB / 约 35 MB | 约 70 MB | 约 60 MB |
| LibreOffice（若按 §8.2 方案 a 全量捆绑） | 约 286 MB（dmg 体积） | 约 359 MB（msi） | 约 211 MB（tar.gz） |
| 中文字体子集 | 约 1.3 MB | 1.3 MB | 1.3 MB |
| **安装包合计** | **约 210 MB**（若 ffmpeg 动态链接）～ **约 420 MB**（全静态 + LO） | 约 300–520 MB | 约 200–360 MB |

注意 FFmpeg 静态与动态的差别：`-lgpl-shared` 构建是多文件（dll/dylib/so），压缩率高得多，也更符合 LGPL 的「可替换库」精神。**建议用 shared 版**（见 `docs/ARCHITECTURE.md` §8.1）。

> BtbN 的 `-lgpl-shared` 只提供 win64/winarm64/linux64/linuxarm64，**没有 macOS** **[实测]**。macOS 需要自己编（CI 里 `--disable-everything` 按需开编码器，约 15–25 MB）或用 Homebrew 的公式在构建期编。这一条是 Phase 5 的具体风险，已记入 `docs/PLAN.md`。

---

## 6. 需要 Phase 1/2 用真实构建替换的「待测」项

1. `core-image.wasm` 的 brotli 体积（决定 AVIF/oxipng 是否进 Web）。
2. `core-doc.wasm` 的体积（lopdf 的实际开销）。
3. pdf.js 的 10 个标准字体（约 1.3 MB raw）由构建脚本全量拷入并进 SW 预缓存；
   首次访问 PDF 渲染功能时已随 SW install 下载，后续回访零流量。
4. 中文字体子集是否能把 1.27 MB 再压（按 Unicode 区段 + 按实际用到的字符两级子集）。
5. `vite build` 后的首屏关键路径实际大小（`manualChunks` 策略的效果）。

每项测完把 **[待测]** 改成 **[实测]** 并更新本文；`scripts/check-budget.mjs` 的阈值同步调整一次，之后锁死。
