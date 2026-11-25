# CI 方案（Phase 0 交付物 6/8）

> 三个工作流，全部只用 GitHub Free + 公共仓库，**零成本**。
> 关键事实（已核实）：公共仓库的 GitHub 托管 runner 分钟数**完全免费**，且不扣 2000 分钟配额；Pages 站点 ≤ 1 GB、带宽 100 GB/月软限、单次部署 10 分钟超时；`upload-pages-artifact` + `deploy-pages` 是当前推荐路径。

---

## 1. `ci.yml` —— 每次 push / PR

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

env:
  CARGO_TERM_COLOR: always
  RUST_BACKTRACE: 1

jobs:
  rust:
    name: rust (native + wasm32)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: wasm32-unknown-unknown
          components: clippy, rustfmt
      - uses: Swatinem/rust-cache@v2
        with: { key: rust-v1 }
      - run: cargo fmt --all -- --check
      - run: cargo clippy --workspace --all-targets -- -D warnings
      - run: cargo test --workspace --release
      - name: build wasm core (image/doc features)
        run: |
          cargo build --release -p media-core-wasm --target wasm32-unknown-unknown --no-default-features --features image
          cargo build --release -p media-core-wasm --target wasm32-unknown-unknown --no-default-features --features doc
      - name: check core boundary (no rayon/fs/thread in crates/core)
        run: node scripts/check-core-boundary.mjs

  web:
    name: web (typecheck + build + budget)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npx tsc --noEmit
      - run: npx vitest run
      - name: build wasm packages
        run: node scripts/build-wasm.mjs --target web
      - run: npm run build
      - name: no third-party domains in dist
        run: node scripts/check-external-domains.mjs
      - name: features/ must not branch on backend kind
        run: node scripts/check-no-branching.mjs
      - name: size budget gate
        run: node scripts/check-budget.mjs

  licenses:
    name: license + notice scan
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npx license-checker-rseidelsohn --production --onlyAllow "MIT;ISC;BSD-2-Clause;BSD-3-Clause;Apache-2.0;0BSD;CC0-1.0;Unlicense;MPL-2.0;SIL-OFL-1.1"
      - uses: EmbarkStudios/cargo-deny-action@v2
        with:
          command: check licenses
      - name: notices must mention optional GPL component
        run: node scripts/check-notices.mjs
```

**为什么 `wasm32` 单独 build 而不在 `cargo test` 里**：`wasm-bindgen-test` 需要浏览器/Node harness，代价大；Phase 6 的双端一致性测试用「native 侧 `cargo test` + 用 node 跑 wasm 产物」的方式，放在 `ci.yml` 的一个独立 job 里（Phase 6 加），而不是一开始就背上浏览器矩阵。

**为什么用 `dtolnay/rust-toolchain` 而不是 `actions-rs/toolchain`**：后者已归档。

---

## 2. `deploy-pages.yml` —— main 分支自动部署

```yaml
name: deploy-pages
on:
  push: { branches: [main] }
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write          # deploy-pages 需要 OIDC

concurrency:
  group: pages
  cancel-in-progress: false   # 部署不可互相取消

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with: { targets: wasm32-unknown-unknown }
      - uses: Swatinem/rust-cache@v2
        with: { key: pages-wasm-v1 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - name: build wasm (wasm-bindgen + wasm-opt)
        run: node scripts/build-wasm.mjs --target web --opt
      - run: npm run build
        env:
          VITE_BASE: /
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with: { path: dist }
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

要点：

1. **`VITE_BASE=/`** 写在环境变量里（当前用自定义域）；换项目页只改这一处。
2. **不引入 `wasm-pack`**：`scripts/build-wasm.mjs` 直接调 `cargo build` + `wasm-bindgen` + `wasm-opt`，版本可锁（`wasm-bindgen` 版本必须与 `crates/wasm/Cargo.toml` 里的 `wasm-bindgen` 依赖**完全一致**，否则运行时报版本不匹配 —— 这是最常见的坑，脚本里要断言）。
3. `wasm-opt` 用 npm 的 `binaryen` 包提供的二进制（`node_modules/.bin/wasm-opt`），避免联网下载。
4. **构建期内不下载任何 native 二进制**（FFmpeg/LibreOffice 只在桌面发布流程里）。
5. `upload-pages-artifact@v3` 会自动 gzip，但对 `.wasm` 是否再压缩取决于服务器；不影响功能。

### 2.1 若切回 GitHub 免费子域（`<user>.github.io/<repo>/`）

只需两步：

```diff
-          VITE_BASE: /
+          VITE_BASE: /media-toolbox/
```
```bash
# 在仓库 Settings → Pages → Custom domain 里删掉自定义域（不需要动文件）
```

其余不变（hash 路由本来就不依赖服务端）。

---

## 3. `release-desktop.yml` —— tag 触发，三平台

```yaml
name: release-desktop
on:
  push:
    tags: ['v*.*.*']
  workflow_dispatch:

permissions:
  contents: write

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - { os: macos-14,      target: aarch64-apple-darwin, label: macos-arm64 }
          - { os: macos-14,      target: x86_64-apple-darwin,  label: macos-x64   }
          - { os: windows-latest, target: x86_64-pc-windows-msvc, label: windows-x64 }
          - { os: ubuntu-22.04,  target: x86_64-unknown-linux-gnu, label: linux-x64 }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with: { targets: "${{ matrix.target }}" }
      - uses: Swatinem/rust-cache@v2
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - name: linux deps
        if: matrix.os == 'ubuntu-22.04'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
      - run: npm ci
      - name: fetch + verify sidecar binaries
        run: node scripts/fetch-sidecars.mjs --target ${{ matrix.target }}
      - run: npm run build          # 前端
      - uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          tagName: ${{ github.ref_name }}
          releaseName: 'media-toolbox ${{ github.ref_name }}'
          releaseBody: '见 CHANGELOG.md。macOS 未签名：首次打开需右键 → 打开，或「系统设置 → 隐私与安全性 → 仍要打开」。'
          args: --target ${{ matrix.target }}
```

要点：

- **macOS 不签名**：`tauri build` 无需 Apple 账号即可产出 dmg；代价是 Gatekeeper 拦截，Release 说明里必须写清放行步骤（这也是规格里「不签名 dmg + 首次打开放行说明」的落点）。
- **Linux 需要 WebKitGTK 4.1 的系统依赖**，`ubuntu-22.04` 是最省事的基线；用 `ubuntu-latest`（24.04）也可以，但 `.deb` 会绑定较新的 glibc，兼容性下降。
- **`fetch-sidecars.mjs` 必须先校验 sha256**，校验失败直接 fail（供应链安全 + 许可证可追溯）。
- 三平台矩阵在**公共仓库免费**；但 macOS runner 单价最高（约 $0.062/min），虽然公共仓库免费，仍应在有 tag 时才跑，而不是每次 push。

---

## 4. 静态检查脚本清单（都在 CI 里跑）

| 脚本 | 检查什么 | 失败示例 |
|---|---|---|
| `check-core-boundary.mjs` | `crates/core/src/**` 里禁止 `rayon`、`std::fs`、`std::net`、`std::thread`、`cfg(target_` | 有人为了「快点」在 core 里 `use rayon::prelude::*` |
| `check-no-branching.mjs` | `src/features/**` 禁止 `@tauri-apps/`、`isTauri`、`window.__TAURI__` | 有人在图片页写 `if (isTauri) invoke(...)` |
| `check-external-domains.mjs` | `dist/**` 里的 `http(s)://` 只允许 `media-toolbox.lucky845.top`、`lucky845.github.io`、`github.com/lucky845/media-toolbox`（Release 链接）；其余一律 fail | 有人引了 CDN 字体 |
| `check-budget.mjs` | `docs/BUDGET.md` §4 的阈值 | `core-image.wasm` 涨到 2.5 MB br |
| `check-notices.mjs` | `THIRD_PARTY_NOTICES.md` 必含 `@ffmpeg/core` 的 GPL 声明与源码地址 | 有人把可选组件从清单删了 |
| `licenses` (cargo-deny) | Rust 依赖许可证白名单 | 引入 GPL crate |

`check-external-domains.mjs` 的白名单要**显式**列出，宁可误报（那就加白名单）也不要漏报一个 CDN。

---

## 5. GitHub 侧一次性设置（你本地要做的操作，我不代劳）

1. 建仓库（公共）：
```bash
gh repo create media-toolbox --public --source=. --remote=origin --push=false
```
2. 推代码：
```bash
git add -A && git commit -m "chore: phase 0 architecture and contracts"
git remote add origin git@github.com:lucky845/media-toolbox.git
git push -u origin main
```
3. Settings → Pages → Source 选 **GitHub Actions**（不是 "Deploy from a branch"）。
4. 自定义域：Settings → Pages → Custom domain 填 `media-toolbox.lucky845.top` → 勾 **Enforce HTTPS**。DNS 侧加一条：
```
类型 CNAME  主机 media-toolbox  值 lucky845.github.io   TTL 自动
```
5. 首次 DNS 生效后（通常 1–30 分钟）确认 `https://media-toolbox.lucky845.top/` 能打开。
   **注意**：我们用 Actions 部署，GitHub 文档明确说「existing CNAME file is ignored」—— 域名**只**在 Settings → Pages → Custom domain 里配，仓库里不需要 CNAME 文件（已加入 .gitignore）。

> 我不会声称这些已经做过 —— 上面是给**你**的命令清单。

---

## 6. 版本与 Action 的固定策略

| 项 | 策略 | 理由 |
|---|---|---|
| `actions/*` | 用主版本标签（`@v4`/`@v5`） | GitHub 官方维护，主版本内不会破坏 |
| `Swatinem/rust-cache` | `@v2` | 事实标准 |
| `tauri-apps/tauri-action` | `@v0` | 官方唯一发布途径，仍为 0.x，锁定后按需升级 |
| Node | `22` LTS | 与本地 `node -v`（26.x）不一致是**故意的**：CI 用 LTS，本地可更新 |
| Rust | `stable`（`dtolnay/rust-toolchain@stable`） | 本机 rustc 1.99.1/1.100.0；`rust-toolchain.toml` 里写 `channel = "stable"` 并在 CI 里不指定具体小版本，避免「本机能编 CI 不能编」 |
| `wasm-bindgen-cli` | 与 crate 依赖**精确同版本**（当前 0.2.130） | 版本不匹配会在运行时报 `it looks like the Rust project used to create this wasm file was linked against version X` |
| `binaryen` | npm 锁定精确版本 | `wasm-opt` 的输出稳定性影响体积闸门 |

---

## 7. 缓存与配额

| 缓存 | 键 | 效果 |
|---|---|---|
| `~/.cargo/registry` + `target/` | `rust-v1` / `pages-wasm-v1` | 冷构建 3–4 min → 热构建 40 s |
| npm（`actions/setup-node` 的 `cache: npm`） | 由 lockfile 派生 | 45 s → 15 s |
| Pages artifact | 每次重建（不缓存，避免脏产物） | — |

Actions 存储配额：公共仓库不限（软限，实际是 5 GB/仓库 + 90 天过期，我们的产物只有几十 MB 且不长期保留）。
