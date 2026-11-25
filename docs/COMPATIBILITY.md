# 浏览器兼容矩阵（Phase 0 交付物 7/8）

> 本表是**能力探测的依据**，不是营销材料。UI 不给「支持/不支持」的红绿灯，而是按 `capabilities()` 决定显示哪些按钮、旁边挂哪句提示（`LimitNotice`）。
> 版本号已核实；未核实的写「未确认」并给出保守降级。

---

## 1. 核心能力

| 能力 | Chrome / Edge | Firefox | Safari | 不支持时的降级 | 对本项目的影响 |
|---|---|---|---|---|---|
| `WebAssembly.instantiateStreaming` | 57+ | 52+ | 15+ | 走 `fetch → arrayBuffer → instantiate`（我们自己的 loader 已实现） | **无阻塞**：Pages 上 MIME 正确；本地服务器可能不正确，靠降级 |
| Worker（module 类型） | 80+ | 114+ | 15+ | 退回 classic worker（打包成 IIFE） | Firefox 114 以下要退；2026 年可忽略，但 Vite 配置里仍保留 `worker.format: 'iife'` 的备选说明 |
| Service Worker | 40+ | 44+ | 11.1+ | 无离线、回访要重新下载 | 影响 100 GB 预算下的回头客，不影响功能本身 |
| `OffscreenCanvas`（2d） | 69+ | 105+ | 16.4+ | 退回主线程 `HTMLCanvasElement` + `toBlob` | 主线程渲染会卡 UI；仅在 PDF 渲染降级时提示 |
| `OffscreenCanvas.convertToBlob` | 69+ | 105+ | 16.4+ | 同上 | — |
| `createImageBitmap`（含 `resizeWidth/Height`） | 50+ / 52+ | 42+ / 105+ | 15+ / 15+ | 退回 `<img>` + canvas 绘制 | 缩略图略慢，无功能缺失 |
| File System Access API（`showSaveFilePicker` / `showDirectoryPicker`） | 86+ | ❌ | ❌ | 退回 `<a download>`（单文件）/ 逐个下载（批量） | 批量输出在 Firefox/Safari 会弹 N 次下载，UI 必须提示「建议用 Chrome/Edge 或桌面版」 |
| `navigator.storage.estimate()` | 52+ | 51+ | 15.2+ | 跳过配额显示 | 仅用于警告「浏览器存储将满」 |
| WebCodecs `VideoDecoder` | 94+ | 130+ | 16.4+ | 视频模块只显示「用桌面版」 | **Safari 16.4 只支持 Web Codecs 的 video 部分**，且 `AudioDecoder/AudioEncoder` 要到 26+；含音频的视频转码在 Safari 上必须降级或拒绝 |
| WebCodecs `VideoEncoder` | 94+ | 130+ | 16.4+（video） | 同上 | 同上 |
| WebCodecs `AudioDecoder` / `AudioEncoder` | 94+ | 130+ | 26+ | 纯视频（无声）或提示不支持 | Safari < 26 上「视频转码」只能处理无声视频，UI 必须明示 |
| `crossOriginIsolated` | — | — | — | **在 GitHub Pages 上恒为 false** | 直接后果：无 `SharedArrayBuffer`、无 wasm threads、`performance.measureUserAgentSpecificMemory()` 不可用 |
| `canvas.toBlob('image/webp')` 编码 | 支持 | 支持（96+） | 支持（14+） | 退回 PNG/JPEG | Web 端有损 WebP 的备选实现（见 `docs/OWNERSHIP.md` §1.1） |
| canvas 解码 `image/avif` | 85+ | 93+ | 16.4+ | 不支持时提示换格式 | 仅影响「显示 avif 预览」，不影响 Rust 侧编解码 |

---

## 2. 逐浏览器的落地结论（写进站内「能力与限制」页）

### Chrome / Edge 86+（**推荐**）
全部功能可用（在阈值内）。批量输出走目录句柄，无「下载 N 次」的问题。

### Firefox 130+
- **可用**：图片全功能、PDF 渲染与结构编辑、视频转码（WebCodecs 自 130 起完整）。
- **受限**：无 File System Access API → 批量导出会触发多次下载（提示「Firefox 不支持选择输出目录」）。
- **受限**：`OffscreenCanvas` 自 105 起可用，更老版本退回主线程。

### Safari 16.4+
- **可用**：图片全功能、PDF 渲染、**无声**视频转码。
- **受限**：WebCodecs 仅 video 部分；`AudioEncoder` 需 26+ → 有声视频的转码必须提示「Safari 暂不支持音频编码，请用桌面版或 Chrome」。
- **受限**：无 File System Access API。
- **受限**：Service Worker 在无痕窗口下行为受限，离线能力不保证。

### Safari < 16.4 / Firefox < 130
- 图片与 PDF 结构编辑仍可用（不依赖 WebCodecs）。
- 视频模块直接显示「当前浏览器不支持，请用桌面版」。

---

## 3. 能力探测怎么写（`src/lib/backend/web/detect.ts` 的设计要点）

```ts
// 逐项探测，任何一项抛错都当作 false，绝不让探测本身把应用打挂
const can = (fn: () => boolean) => { try { return fn(); } catch { return false; } };

const hasVideoEncoder = can(() => 'VideoEncoder' in window);
const hasAudioEncoder = can(() => 'AudioEncoder' in window);
const hasFSAccess     = can(() => 'showSaveFilePicker' in window);
const hasOffscreen    = can(() => 'OffscreenCanvas' in window && 'convertToBlob' in OffscreenCanvas.prototype);
```

**编解码器不靠 UA 猜**，靠 `VideoEncoder.isConfigSupported({codec:'avc1.42E01E', ...})` 逐个问浏览器 —— UA 只能告诉「大致版本」，不能告诉「这台机器上有没有该编码器的硬件实现」。

UA 只用在两处：错误提示文案（「你的 Safari 16.2 不支持…」）与日志，不参与功能分支。

---

## 4. 阈值与降级的交互（必须一起看）

| 情形 | 行为 |
|---|---|
| 文件在阈值内 + 能力齐全 | 正常执行 |
| 文件在阈值内 + 缺能力（如 Safari 无 AudioEncoder） | 该选项 `disabled` + 常驻提示「Safari 不支持音频编码，请用桌面版」；**不**在点了之后才报错 |
| 文件超阈值 | 开始前中止，`DIMENSION_LIMIT`/`INPUT_TOO_LARGE` 等，弹窗给桌面版 Release 链接 |
| `capabilities()` 本身失败 | 进入受限模式：只有「PDF 结构编辑」与「下载」可用，顶部横幅说明 |

---

## 5. 自定义域配置与 DNS 检查清单（Phase 2 部署后核对）

### 5.1 在哪里配（先纠正一个常见误解）

** Actions 部署方式下，`CNAME` 文件不起作用。** GitHub 官方原文：

> If you are publishing from a custom GitHub Actions workflow, **no `CNAME` file is created, and any existing `CNAME` file is ignored and is not required**.
> — [GitHub Docs: Managing a custom domain](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)

我们的 `deploy-pages.yml` 用的是 `actions/deploy-pages`（自定义 Actions 工作流），所以：

| 项 | 在哪配 | 说明 |
|---|---|---|
| 域名绑定 | GitHub 仓库 → Settings → Pages → **Custom domain** 填 `media-toolbox.lucky845.top` → Save → 勾 Enforce HTTPS | 这一步是真正生效的配置 |
| DNS 解析 | DNS 服务商加 `CNAME` 记录：`media-toolbox` → `lucky845.github.io` | **不要**带仓库名；不要写成 `*.lucky845.top` 通配符（有域名接管风险） |
| 仓库里的 `CNAME` 文件 | 保留也行、删掉也行，**被忽略** | 为避免误导，本项目已删除它 |

若哪天改用「从分支部署」（Deploy from a branch），那条路径才会由 GitHub 在仓库根目录创建 `CNAME` 文件 —— 那时它才需要存在。

### 5.2 部署后核对命令

```bash
# 1. CNAME 记录是否生效（可能需要 1–30 分钟）
dig +short CNAME media-toolbox.lucky845.top
# 期望：lucky845.github.io.

# 2. 站点是否走得通（跟随重定向）
curl -sIL https://media-toolbox.lucky845.top/ | head -6
# 期望：HTTP/2 200（首次配置可能先 301 到 http，等证书签发）

# 3. wasm 的 MIME（决定 instantiateStreaming 能否走第一段）
curl -sI https://media-toolbox.lucky845.top/wasm/core_image_bg.wasm | grep -i content-type
# 期望：content-type: application/wasm

# 4. 缓存头（决定「回头客零流量」要依赖 SW 而非 HTTP 缓存）
curl -sI https://media-toolbox.lucky845.top/ | grep -i cache-control
# 期望或实际：cache-control: max-age=600

# 5. 实际页面内容
curl -s https://media-toolbox.lucky845.top/ | grep -o '<title>[^<]*'
# 期望：<title>本地多媒体工具箱</title>
```

若第 1 步无输出：DNS 未生效或记录类型写成了 A/AAAA（自定义域必须用 CNAME）。
若第 3 步不是 `application/wasm`：说明部署的不是 GitHub Pages（或中间有代理），loader 会自动降级（并在日志里留下记录）。

---

## 6. 已知的「避坑」记录（实测/官方 issue）

| 坑 | 现象 | 处理 |
|---|---|---|
| Pages 无法设 `COOP/COEP` | `crossOriginIsolated === false`，`SharedArrayBuffer` 未定义 | 架构上不依赖（见 `ARCHITECTURE.md` D2）；不引入 `coi-serviceworker`（会与自己的 SW 缓存策略冲突，且对已正确的 MIME 无收益） |
| Pages 的 `max-age=600` | 10 分钟后回访重新校验 | 用 SW 做内容寻址文件的 `cache-first` |
| Pages 无 SPA rewrite | 直接访问 `/image` 会 404 | 用 hash 路由；`404.html` 仅作为手输错路径的兜底 |
| `python -m http.server` 的 `.wasm` MIME | 部分版本返回 `application/octet-stream` | loader 的降级路径兜住；README 的「本地预览」章节给出两条命令并说明该差异 |
| Safari 无痕下 SW/存储受限 | 刷新后缓存丢失 | UI 不承诺「安装后离线」，只承诺「曾访问过的页面可离线」 |
| Firefox 无目录句柄 | 批量导出弹多次下载 | 提示改用 Chrome/Edge 或桌面版 |
| `@ffmpeg/core` 的 GPL | 默认加载 = 对所有访客分发 GPL 二进制 | 必须用户点击才下载，且声明常驻（见 `BUDGET.md` §3.2） |
