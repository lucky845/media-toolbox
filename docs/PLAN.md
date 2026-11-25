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

## Phase 2 — Web 空壳上 Pages ⬜ 下一步

### 要改的文件

```
public/CNAME              # 已建（media-toolbox.lucky845.top）
public/404.html           # 已建
.github/workflows/deploy-pages.yml   # 已建
README.md                 # 已含在线地址占位
```

Phase 1 已经把部署的前置条件都验证了（MIME、降级加载器、hash 路由）。
Phase 2 主要是**真实的部署链路与 DNS**。

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
DNS 加一条：`CNAME  media-toolbox  lucky845.github.io`。

---

## Phase 3 — Web 图片全量 + 队列 + SW ⬜

- 补齐 `ImagePage` 的裁剪/旋转/色彩调整 UI（core 算法已全部实现并有单测）
- PNG 无损优化（`oxipng`，需先测 wasm 体积增量 → `docs/benchmarks.md` B3）
- AVIF（需先测 → B4）
- Service Worker（当前 UI 已如实显示「尚未缓存」）
- 分包加载：只在进入图片页时拉 `core_image.wasm`

## Phase 4 — Web 轻量视频 + 文档 + 能力页 ⬜

- `crates/core/src/pdf/*`（lopdf 结构操作）
- `crates/core/src/video/{args,progress,meta}.rs`（纯函数，两端共用）
- `src/lib/backend/web/{webcodecs,mux,probe}.ts`
- pdf.js 渲染 + 虚拟化
- Word↔PDF 结构化转换（mammoth + pdf-lib）+ 中文字体子集化
- 站内「能力与限制」页（已有基础版本，需补全 ⚠️ 项）

## Phase 5 — Tauri 全量 ⬜

- FFmpeg sidecar（`fetch-sidecars.mjs` 已写好，macOS 需本地编译）
- LibreOffice headless
- 硬件编码探测（`sidecar.rs` 已实现探测逻辑）
- 三平台打包（`release-desktop.yml` 已写好）

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
