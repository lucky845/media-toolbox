# 更新日志

## v0.2.3

- 图片工作区支持多文件暂存后批量处理；单个文件失败不会阻断同批其他任务。
- 新增 QOI 与 ICO 编解码，Web 与桌面能力矩阵保持一致；ICO 输出尺寸限制为每边 256 像素。桌面与 Web 都不提供 AVIF 编码。
- 新增裁剪、旋转、缩放与色彩滤镜的组合处理，以及黑白、柔和、鲜明滤镜预设。
- 新增 JPEG 体积优先、均衡、质量优先压缩预设；输出格式改为读取运行时能力，不再展示未启用的 AVIF。
- 增加生产构建批量回归测试，覆盖损坏文件隔离、QOI 重导入和 ICO 输出。

## v0.2.2

- 新增统一任务中心，支持图片、PDF、视频和文档任务的排队、进度、取消、重试与结果保存。
- 新增最近任务历史，可按设置关闭记录、删除单条或确认后清空。
- 新增队列并发设置并记住选择，队列可暂停接收新任务。
- 改进文件拖放导入，支持桌面端系统拖放与文件格式筛选。

## v0.2.1

- 工具箱导航增加图片、PDF、视频和文档图标，大分类可折叠，小分类使用缩进层级和当前项高亮。
- 图片工作区拆分为变换、压缩、填充、色彩和组合处理入口，切换入口时保留文件、参数和预览状态。
- 统一导入区、透明预览、源文件信息和窄屏布局的视觉层级，并完善键盘焦点提示。
- 画布填充由 Web 与桌面共用 Rust 核心处理，支持纯色或透明背景；JPEG 质量设置按编码器能力启用。

## v0.2.0

- Web 和桌面版支持按页码提取 PDF、调整合并顺序和导出 TXT。
- 桌面版通过 Tauri 调用共享 Rust 核心完成 PDF 旋转、合并、拆分和提取，预览与页面渲染继续使用 PDF.js。
- Web 拆分可下载全部结果，并在执行前校验页码范围。
- 修复 Apple 芯片安装包的 FFmpeg 外部依赖和应用签名完整性，更新圆角应用图标。macOS 安装包采用 ad hoc 签名，未经 Apple 公证。
- 桌面版新增本机能力说明，视频页使用系统文件选择器并展示实际探测到的 FFmpeg 能力。
- 桌面文档转换未检测到 LibreOffice 时，提供官方下载入口和安装后重启提示。

## v0.1.0（首个桌面发布候选）

Web 在线版与桌面版共用同一份 Rust 核心算法，分别编译为 wasm32 与 native。
本版本是 Phase 0–6 的完整交付，三平台安装包由 CI 在打 tag 时自动产出。

### Web 在线版

- 图片：压缩 / 裁剪 / 旋转 / 翻转 / 亮度对比度饱和度 / 缩放（多种滤波）/ EXIF 方向；
  jpeg/png/webp/gif/bmp/tiff 格式转换；批量队列、进度、取消、对比预览。
- PDF：按页渲染图片（≤100 页 / ≤200 DPI、虚拟化、长图拼接）；合并 / 拆分 / 旋转 /
  提取文本与图片；Word↔PDF 结构化转换（常驻「不承诺高保真」声明）。
- 视频：WebCodecs 轻量转码（MP4/H.264 → MP4/WebM，≤200 MB / ≤5 分钟），
  mp4box.js 解封装 + mp4-muxer/webm-muxer 封装。
- 离线：Service Worker 缓存外壳与分包；首次在线加载后可离线使用。
- 限制：GitHub Pages 无法设置 COOP/COEP → wasm 单线程；文件不上传，但仓库与构建产物公开。

### 桌面版

- 图片：大图 / 批量 / rayon 并行；支持 JPEG / PNG / WebP / GIF / BMP / TIFF，PNG 无损处理。
- 视频：FFmpeg sidecar（档位 L：LGPL-2.1-or-later，无 libx264/libx265）；
  H.264 优先走系统硬件编码（macOS VideoToolbox / Windows NVENC / Linux VAAPI）。
- 文档：LibreOffice headless 优先 + 结构化兜底；完全离线。
- PDF：复用 webview 内 pdf.js，阈值放宽到不限页数 / ≤400 DPI。
- 二进制随包分发，不需用户预装 FFmpeg/LibreOffice。

### 工程质量

- Rust 核心 212 单测 + 6 个 Tauri command 测试 + 16 前端测试；
  双端一致性：图片 21/21、PDF 3/3 逐字节相等（blake3）。
- 基准实测 B1（12 MP lanczos）：native ≈220 ms、wasm ≈408 ms（1.85×），逐字节一致；
  详见 `docs/benchmarks.md` 与 `docs/benchmark-results.json`。
- 七道 CI 闸门（core 边界 / 零分叉 / 外部域名 / 体积 / base / 许可证 / 一致性）全绿。

### macOS 未签名说明

首发不签名（零成本约束：Apple 开发者账号 $99/年）。首次打开方法：
在「应用程序」里右键 → 打开，或到「系统设置 → 隐私与安全性」点「仍要打开」。

### 许可证

自有代码 MIT。第三方组件按 Web / Desktop 两栏列于 `THIRD_PARTY_NOTICES.md`；
FFmpeg 档位 L（LGPL-2.1-or-later，不含 GPL/nonfree 编码器），LibreOffice MPL-2.0，
中文字体 Noto Sans SIL OFL 1.1。可选的 ffmpeg.wasm 降级包为 GPL-2.0-or-later，默认不加载。
