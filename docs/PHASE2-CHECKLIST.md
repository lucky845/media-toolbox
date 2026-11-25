# Phase 2 验收清单（部署链路）

> 阶段目标：Web 空壳上 GitHub Pages，验证 base / hash 路由 / wasm 加载 fallback /
> 在线 URL 与本地 preview 都能打开。
>
> **我不会声称已经 push 或部署完成** —— 下面所有带「你需要」的步骤都由你本地执行。

---

## 1. 已在本机验证 ✅

| 项 | 命令 | 结果 |
|---|---|---|
| 自定义域 base | `npx vite build`（VITE_BASE 默认 `/`） | `index.html` 引用 `/assets/...`、`/wasm/...` |
| 项目页 base | `VITE_BASE=/media-toolbox/ npx vite build` | 引用 `/media-toolbox/assets/...`、`/media-toolbox/wasm/...` |
| base 静态检查 | `node scripts/check-base.mjs` | ✓ 无硬编码绝对路径 |
| hash 路由 | `node tests/e2e/smoke.mjs http://localhost:4173` | `#/image` 与 `#/help` 都能打开 |
| wasm MIME 正确时 | Vite preview 返回 `application/wasm` | 页面正常工作 |
| **wasm MIME 错误时** | `node tests/e2e/mime-fallback.mjs` | **故意返回 `application/octet-stream`，图片处理仍成功** |
| 404 兜底路径 | 人工检查 | 改为相对路径 `./#/image`，两种 base 都正确 |
| 五道 CI 闸门 | 见 Phase 1 报告 | 全部通过 |

### 关于 CNAME 的重要纠正

GitHub 官方文档明确（[Managing a custom domain](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)）：

> If you are publishing from a custom GitHub Actions workflow, no `CNAME` file is created,
> and any existing `CNAME` file is ignored and is not required.

我们用 `actions/deploy-pages`，所以**仓库里的 CNAME 文件不起作用**。
域名只在 **Settings → Pages → Custom domain** 里配；DNS 由域名服务商配。
已从仓库删除 `public/CNAME` 并加入 `.gitignore`。

---

## 2. 你需要执行的步骤（按顺序）

### 2.1 建仓库并推送

```bash
cd /Users/lucky845/workspace/MyWorkspace/WebProjects/media-toolbox

gh repo create media-toolbox --public --source=. --remote=origin --push=false

git add -A
git commit -m "feat: phase 1-2 — 双端跑通的图片压缩 + 部署链路"
git push -u origin main
```

### 2.2 配置 GitHub Pages

1. 仓库 → **Settings** → **Pages**
2. **Build and deployment → Source** 选 **GitHub Actions**（不是 "Deploy from a branch"）
3. **Custom domain** 填 `media-toolbox.lucky845.top` → Save
4. 勾 **Enforce HTTPS**

### 2.3 配置 DNS

在你的 DNS 服务商（lucky845.top 的解析平台）加一条记录：

| 类型 | 主机记录 | 记录值 |
|---|---|---|
| CNAME | `media-toolbox` | `lucky845.github.io` |

注意：
- 记录值**不带仓库名**（GitHub 官方要求指向 `<user>.github.io`）
- 不要用通配符 `*.lucky845.top`（有域名接管风险）

### 2.4 等 Actions 跑完

```bash
gh run list --workflow deploy-pages.yml
gh run watch            # 选最新的部署 run
```

---

## 3. 部署后核对（你执行）

```bash
# 1. DNS 生效（可能要 1–30 分钟）
dig +short CNAME media-toolbox.lucky845.top
# 期望：lucky845.github.io.

# 2. 站点可访问
curl -sIL https://media-toolbox.lucky845.top/ | head -6
# 期望：HTTP/2 200

# 3. wasm MIME（关键）
curl -sI https://media-toolbox.lucky845.top/wasm/core_image_bg.wasm | grep -i content-type
# 期望：content-type: application/wasm

# 4. 缓存头（决定回头客策略）
curl -sI https://media-toolbox.lucky845.top/ | grep -i cache-control
# 期望：max-age=600

# 5. 页面内容
curl -s https://media-toolbox.lucky845.top/ | grep -o '<title>[^<]*'
# 期望：<title>本地多媒体工具箱</title>

# 6. 端到端（真实浏览器，含文件处理）
node tests/e2e/smoke.mjs https://media-toolbox.lucky845.top tests/fixtures/gradient.png
```

---

## 4. 预期结果与异常处理

| 现象 | 原因 | 处理 |
|---|---|---|
| `dig` 无输出 | DNS 未生效或写成 A 记录 | 等；确认记录类型是 CNAME |
| 站点 404 | Source 选成了 Deploy from a branch | 改成 GitHub Actions |
| `curl` 返回 429 | Pages 限流（软限） | 等几分钟重试 |
| wasm MIME 不是 `application/wasm` | 中间有代理或没部署到 Pages | loader 会降级（已实测），功能不受影响 |
| 页面白屏 | 检查 workflow 里 `VITE_BASE` | 自定义域必须是 `/` |
| 资源 404 | 同名仓库用了项目页 base | `VITE_BASE` 改成 `/media-toolbox/` |

---

## 5. 如果切回免费子域（`<user>.github.io/<repo>/`）

只需三步：

1. `.github/workflows/deploy-pages.yml` 里 `VITE_BASE: /` → `VITE_BASE: /media-toolbox/`
2. GitHub Settings → Pages → Custom domain 里**删掉**自定义域
3. DNS 里的 CNAME 记录删掉（可选）

hash 路由与 `404.html` 的相对路径保证两种形态都能工作 —— 这一点已在本机用两种 base 构建验证。
