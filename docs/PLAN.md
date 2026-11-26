# 分阶段实施计划与进度

> 规则：**每个 Phase 结束必须能实际运行**，且有可复现的验收命令。
> 写不出验收命令的阶段，等于没做完。

---

## Phase 0 — 架构与契约 ✅ 完成

| 交付物 | 文件 | 状态 |
|---|---|---|
| 架构结论（分层 + Backend 抽象 + 并行 cfg 分流 + 视频三路线裁决） | [ARCHITECTURE.md](ARCHITECTURE.md) | ✅ |
| 接口契约（Rust / wasm / Tauri / TS / Worker 协议 / 状态机 / 错误码） | [CONTRACTS.md](CONTRACTS.md) | ✅ |
| 能力矩阵（逐项 ✅/⚠️/❌ + 原因 + 阈值） | [CAPABILITIES.md](CAPABILITIES.md) | ✅ |
| 热点归属表（逐模块 Rust/TS + 理由） | [OWNERSHIP.md](OWNERSHIP.md) | ✅ |
| 体积与流量预算 | [BUDGET.md](BUDGET.md) | ✅ |
| CI 方案 | [CI.md](CI.md) | ✅ |
| 浏览器兼容矩阵 | [COMPATIBILITY.md](COMPATIBILITY.md) | ✅ |

---

## Phase 1 — Rust workspace + 双包装 + 图片压缩 ✅ 完成

**验收报告见 [PHASE1-REPORT.md](PHASE1-REPORT.md)。**

### 交付

```
crates/ports/   31 个单测：Source/Sink/Progress/Cancel/Parallel/Codec/Limits/ErrorCode
crates/core/   115 个单测：decode/encode/resize/geometry/colorops/exif/pipeline/hash/trig
crates/wasm/    12 个单测 + 可用的 wasm 产物（1254 KB raw / 307 KB brotli）
crates/native/  23 个单测：rayon / 原子写 / UTF-8 文件名 / 任务取消表
src-tauri/      Tauri 2 壳：4 个 command + sidecar 探测（cargo check 通过）
src/            一份前端：Backend 接口 + Web 实现 + 图片页 + 能力页
```

### 验收命令与结果

```bash
cargo test --workspace            # 8 个测试组，175 个测试全绿
npx tsc --noEmit                  # 0 错误
npx vitest run                    # 12 个测试通过
node scripts/build-wasm.mjs       # 1254 KB → 307 KB brotli
node scripts/verify-single-source.mjs   # ✓ 三项判定全过
node scripts/run-conformance.mjs        # ✓ 21/21 逐字节一致，0 白名单
node tests/e2e/smoke.mjs http://localhost:4173   # ✓ pass:true，0 错误 0 外链
```

### 在 Phase 1 抓到的真实问题

| 问题 | 性质 | 处理 |
|---|---|---|
| `f32::sin` 在 wasm 与 native 有 6e-8 差异 → 输出 PNG 完全不同 | **架构级** | 自实现确定性 `sin`/`exp`（`common/trig.rs`） |
| Zustand 订阅整个 store → React 无限渲染白屏 | 实现 bug | 改单值选择器 |
| `getRegistration() !== undefined` 恒真 → 谎称可离线 | **诚实性 bug** | 检查 `reg?.active?.state === 'activated'` |
| `DropZone` 的 `<input>` 没有 onChange | 可访问性 bug | 接上 onChange |
| `check-no-branching` 抓到 4 处按壳分支 | 架构漂移 | 新增 `lib/backend/summary.ts` 集中派生 |
| `check-notices` 抓到「高保真转换」表述 | **合规 bug** | 改为「不承诺无损」 |
| `verify-single-source` 的正则被 `cargo fmt` 打破 | 测试脆弱 | 改为「改一个具名常量」 |

---

## Phase 2 — Web 空壳上 Pages 🟡 本机验证完成，部署待你执行

### 已完成（本机）✅

```
scripts/check-base.mjs              # base 注入静态检查（两种形态）
tests/e2e/mime-fallback.mjs         # 故意返回错误 MIME，验证降级路径
public/404.html                     # 链接改为相对路径 ./#/image
.github/workflows/deploy-pages.yml  # VITE_BASE=/ + Actions 部署
docs/PHASE2-CHECKLIST.md            # 完整部署与核对清单
```

**已删除** `public/CNAME`（Actions 部署忽略它），并加入 `.gitignore`。
域名只在 GitHub 仓库 Settings → Pages → Custom domain 配。

本机实测：
- 两种 base 构建都正确（`/assets/...` vs `/media-toolbox/assets/...`）
- 错误 MIME 下图片处理仍成功（`node tests/e2e/mime-fallback.mjs`）
- hash 路由与 404 兜底路径正确

### 待你执行（部署与 DNS）

见 [PHASE2-CHECKLIST.md](PHASE2-CHECKLIST.md) 第 2、3 节。
**我不声称已 push 或部署。**

### 验收

```bash
# 1. 本地两种静态服务都能开（已验证）
npm run build && npm run preview          # http://localhost:4173
python3 -m http.server 5000 --directory dist

# 2. 部署后核对
dig +short CNAME media-toolbox.lucky845.top          # 期望 lucky845.github.io.
curl -sI https://media-toolbox.lucky845.top/ | head -3
curl -sI https://media-toolbox.lucky845.top/wasm/core_image_bg.wasm | grep -i content-type
#   期望 application/wasm

# 3. hash 路由：/ 与 /#/help 都能开；/help 走 404.html（预期，不是 bug）

# 4. 真实浏览器
node tests/e2e/smoke.mjs https://media-toolbox.lucky845.top
```

### 你需要做的（我不代劳，也不声称已完成）

```bash
gh repo create media-toolbox --public --source=. --remote=origin --push=false
git add -A && git commit -m "feat: phase 1 — 双端跑通的图片压缩"
git push -u origin main
```

然后 GitHub 仓库 Settings → Pages → Source 选 **GitHub Actions**（不是 Deploy from a branch），
Custom domain 填 `media-toolbox.lucky845.top`，勾 Enforce HTTPS。
DNS 加一条：`CNAME  media-toolbox  lucky845.github.io`（不带仓库名）。
注意：Actions 部署下 **仓库里的 CNAME 文件被 GitHub 忽略**，不要再把「CNAME 文件一致性」当检查项 —— 域名只在 Settings → Pages → Custom domain 里配。

---

## Phase 3 — Web 图片全量 + 队列 + SW ✅ 完成

**完整报告见 [PHASE3-REPORT.md](PHASE3-REPORT.md)。**

### 交付

- 视觉统一到「原理图」皮肤（主页/博客/工具箱同款 token）
- 图片全量 UI：裁剪、旋转、翻转、缩放、5 种滤波、色彩、EXIF、背景填充、对比预览
- 批量队列：`QueuePanel`/`TaskCard`、总进度、暂停、取消、重试、IndexedDB 最近任务
- Worker 池（1–2，任务级并发）+ 4 个单测
- Service Worker：外壳 + 全部 assets + wasm 预缓存；离线刷新与离线处理均验证通过
- CI 已接入 SW 构建与 base 检查

### 阶段门禁

| 门禁 | 状态 |
|---|---|
| `check-no-branching` 继续通过 | ✅ |
| SW 不缓存 ffmpeg | ✅（`ffmpegCached: []`） |
| IndexedDB 只存文件名+参数 | ✅ |
| 离线可用 | ✅ |
| 错误 MIME 降级 | ✅ |

### 一个明确记录的偏离

SW 改为 install 时预缓存图片 wasm（规格 §18 说「进入功能才拉」）。
原因：运行时缓存在实测中反复出现 body 空壳（详见 PHASE3-REPORT §4.2 的 6 个坑），
可靠性优先。代价是首页多下 307 KB，净增接近 0（进图片页本来就要下）。

---

## Phase 4 — Web 轻量视频 + 文档 + 能力页 🟡 结构操作完成，渲染/转码管线留 Phase 4b

**报告见 [PHASE4-REPORT.md](PHASE4-REPORT.md)。**

已完成：
- core 新增 PDF 结构操作（lopdf，10 测试）、视频 argv/进度（11 测试）、文档结构化（5 测试）→ core 共 209 测试
- wasm 第二个分包 `core_doc`（531 KB brotli）+ 统一拷贝脚本
- PDF 页：探测/旋转/拆分/提取/合并，e2e 通过
- 文档页：Word↔PDF 结构化入口 + **常驻保真度声明**
- 视频页：能力探测 + GPL 降级说明（不假装能转）
- 能力页校正：PDF→图片与视频转码如实标为 Phase 4b 待接入

Phase 4b（待做）：WebCodecs 转码管线、pdf.js 按页渲染+虚拟化、可选 ffmpeg.wasm 执行、完整 docx 文件生成。

---

## Phase 5 — Tauri 全量 🔶 进行中（视频纵切已交付）

- [x] 决策：档位 L（LGPL 无 libx264）/ 先做视频纵切 / PDF 渲染复用 pdf.js（见 `PHASE5-REPORT.md`）
- [x] native 进程执行层 `crates/native/src/process.rs`（进度换算 / 进程树 kill / 中文错误）
- [x] 视频 command `src-tauri/src/commands/video.rs`（probe/transcode/extract_frame/extract_audio）
- [x] 档位 L 硬件编码选择 + sidecar 编解码器探测
- [x] 前端零分叉：`Backend.probeVideo` + VideoPage 走 getBackend（不再 import Web 实现）
- [x] 本机验证：212 Rust 测试 / 4 Tauri command 测试 / 6 e2e / Tauri 二进制构建+启动
- [ ] PDF 高 DPI 阈值放宽（复用 pdf.js，仅 capabilities 调整）
- [ ] LibreOffice headless Word↔PDF command
- [ ] 三平台 Release 实测出包（tag 触发 CI，本机无完整 Xcode 不出 dmg）
- [ ] 视频批量队列接入桌面并行

## Phase 6 — 一致性、基准、许可证、README ⬜

- 全部 6 项基准（B1–B6）填入 `docs/benchmarks.md`
- 一致性测试扩展到 PDF/视频
- README 与能力页的最终校对

---

## 阶段门禁

| 门禁 | 位置 | 当前状态 |
|---|---|---|
| 改 `core` 一处两端同时生效 | Phase 1 | ✅ `verify-single-source.mjs` |
| 两端输出逐字节一致 | Phase 1 | ✅ 21/21，0 白名单 |
| `check-external-domains` 0 失败 | Phase 1 起 | ✅ |
| `check-budget` 0 失败 | Phase 1 起 | ✅ |
| `check-core-boundary` 0 失败 | Phase 1 起 | ✅ |
| `check-no-branching` 0 失败 | Phase 1 起 | ✅ |
| `check-notices` 0 失败 | Phase 1 起 | ✅ |
| Pages 上真的能打开 + wasm MIME 正确 | Phase 2 | ⬜ 待部署 |
| 取消路径 3 秒内 settle | Phase 3 | ⬜ |
| 「能力与限制」页覆盖全部 ⚠️ 项 | Phase 4 | 部分（基础版已有） |
| sidecar 的 configure 行无 GPL/nonfree | Phase 5 | ⬜（脚本已就绪） |
| 一致性测试无「无解释的差异」 | Phase 6 | ✅（已提前达成） |
