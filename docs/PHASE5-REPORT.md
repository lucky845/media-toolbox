# Phase 5 报告（视频纵切：档位 L / FFmpeg sidecar）

> 阶段目标：Tauri 桌面全量。本轮按用户决策交付**视频纵切**（先跑通一个完整能力），
> 后续按同一模式铺开 PDF/Office。
>
> 用户三项决策（本轮开工前确认）：
> 1. **FFmpeg 许可档位 L**：LGPL-2.1-or-later，不带 libx264/libx265；H.264 走系统硬件编码
>    （macOS VideoToolbox / Windows NVENC·QSV·AMF / Linux VAAPI）；整包无 GPL，源码提供义务为零。
> 2. **本轮先做视频纵切**：native 进程执行层 + 视频 command + 前端 Backend 接线 + 本机验证。
> 3. **桌面 PDF 渲染复用 webview 内 pdf.js**（本轮不动），桌面端只靠 capabilities 放宽阈值。

---

## 1. 架构落点（与文档一致）

- argv 构造、进度换算、ffprobe 解析仍是 `crates/core/src/video/args.rs` 的**纯函数**，
  桌面与 Web(可选 ffmpeg.wasm 降级) 共用同一份，杜绝参数漂移。
- 新增 `crates/native/src/process.rs`：进程执行层，是 native 侧唯一新模块。
  - `run_with_progress`：spawn → 逐行读 `-progress pipe:1` → `ProgressParser` → `task://progress` 事件；
  - `run_capture`：ffprobe 短命令取完整 stdout；
  - 取消：看门狗线程监视 `TaskCancel`，置位后 `kill -PGID`（unix）/ `taskkill /T /F`（windows），
    一次 kill 整棵进程树，不留孤儿；
  - 错误映射：二进制缺失 → `BinaryMissing`，退出码异常 → `EncodeFailed`，
    detail 只写错误类别与退出码，**不含文件路径或内容**。
- 新增 `src-tauri/src/commands/video.rs`：`video_probe` / `video_transcode` /
  `video_extract_frame` / `video_extract_audio` 四个 command。
- `sidecar.rs` 的 `probe()` 新增 `-encoders` / `-decoders` 探测，`select_encoder` 按档位 L
  优先选系统硬件 H.264 编码器；**无任何硬件编码器且无 libx264 时抛 `CodecUnsupported`**
  （不假装能编码）；`binary_path()` 暴露 sidecar 绝对路径给 command。

## 2. 前端零分叉

- `Backend` 接口新增可选 `probeVideo?(ref)`；Web 实现委托 `getVideoBackend()`（mp4box），
  桌面实现走 `video_probe` command（ffprobe）。
- `VideoPage` 不再 `import` Web 具体实现，统一 `getBackend().probeVideo()` / `backend.run()`；
  形态差异只由 `capabilities()` 数据表达（规格 D3）。
- 桌面 `video.transcode` 已由 Rust 写盘，回传空字节占位；`DesktopBackend.saveOutput` 对空字节
  直接返回 'saved'（不弹保存框）。Web 仍走 `<a download>`。

## 3. 档位 L 的合规验证

- `fetch-sidecars.mjs` 的 `verifyLicense()` 在构建期拒绝 configure 行含
  `--enable-gpl` / `--enable-nonfree` / `libx264` / `libx265` 的二进制；
- 运行期 `sidecar.rs::probe()` 再校验一次，`gpl_risk` 为 true 时「关于」页标红；
- 本机 Homebrew ffmpeg 含 `--enable-gpl --enable-libx264`（档位 G），**仅用于本机集成测试**，
  不随任何分发产物打包；打包始终用脚本拉取的 LGPL 构建。

## 4. 验证

```
cargo test --workspace               212 passed（含 native 真实 ffmpeg 转码集成测试）
cargo clippy --workspace --all-targets -D warnings   0 警告
cargo fmt --all -- --check            ok
cargo test (src-tauri --lib)         4 passed（编码器选择 + ffprobe 真实探测）
npx tsc --noEmit                     0 错误
npx vitest run                       16 passed
npm run build                        ok（desktopBackend chunk 4.89 KB / 2.05 KB gzip）
五道闸门 + check-notices             全绿
e2e smoke/pdf/pdf-render/video/offline/mime-fallback  6/6 pass（无回归）
Tauri 二进制                        cargo build 成功，启动无崩溃
```

## 5. 环境限制（非代码问题）

- 本机只有 Xcode Command Line Tools（无完整 Xcode），`tauri build --bundles dmg` 无法在本机
  执行；CI 的 `release-desktop.yml` 在 macos-14 runner 上有完整 Xcode，负责出 dmg。
- macOS sidecar 无官方 LGPL 构建（BtbN 只提供 win/linux），`fetch-sidecars.mjs` 给出本地
  编译命令（VideoToolbox/系统编码，不引入 GPL），Release workflow 在 CI 上按此执行。
- dependabot 的 glib moderate 漏洞只在 Linux GTK 依赖树；macOS target 依赖树无 glib，
  不影响 macOS 首目标。后续若启用 Linux 产物再处理。

## 6. 本轮未做（按同一模式后续铺开）

- PDF 高 DPI 批量渲染：按用户决策复用 pdf.js，桌面侧只需放宽页数/DPI 阈值（前端 capabilities），
  无需新 sidecar。
- LibreOffice headless Word↔PDF command（`sidecar.rs` 已有探测，command 未接）。
- 三平台 Release 实测出包：需 tag 触发 CI，本轮只保证 workflow 配置正确、二进制可构建。
- 批量队列接入桌面并行（rayon 已在 image command 使用，视频批量尚未）。
