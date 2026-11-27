// Backend 契约（`docs/CONTRACTS.md` §5）。
//
// 铁律：`features/**` 只能 import 这个文件，不得 import 任何 @tauri-apps/* 或 wasm 模块。
// 差异化只能通过数据（capabilities/limits）表达，不能通过 if (isTauri) 表达。

/** 与 Rust 侧 `media_ports::ErrorCode` 一一对应 */
export type ErrorCode =
  | 'INPUT_TOO_LARGE'
  | 'DIMENSION_LIMIT'
  | 'PAGE_LIMIT'
  | 'DURATION_LIMIT'
  | 'MEMORY_LIMIT'
  | 'UNSUPPORTED_FORMAT'
  | 'DECODE_FAILED'
  | 'ENCODE_FAILED'
  | 'CODEC_UNSUPPORTED'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'OUT_OF_MEMORY'
  | 'IO'
  | 'PERMISSION_DENIED'
  | 'INVALID_PARAMS'
  | 'INTERNAL'
  | 'WASM_LOAD_FAILED'
  | 'WASM_MIME_MISMATCH'
  | 'BINARY_MISSING'
  | 'BINARY_VERSION'
  | 'LIBREOFFICE_MISSING';

export interface ToolError {
  code: ErrorCode;
  message: string;
  detail?: string;
  retryable: boolean;
  desktopHint: boolean;
  logId?: string;
}

export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'avif' | 'gif' | 'bmp' | 'tiff';

export type Filter = 'nearest' | 'triangle' | 'catmull_rom' | 'gaussian' | 'lanczos3';
export type ResizeMode = 'fit' | 'fill' | 'exact';
export type Rotation = 'none' | 'cw90' | 'cw180' | 'cw270';
export type Flip = 'none' | 'h' | 'v' | 'both';

export interface Resize {
  width: number | null;
  height: number | null;
  mode: ResizeMode;
  filter: Filter;
  allowUpscale: boolean;
}

export interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Adjust {
  brightness: number;
  contrast: number;
  saturation: number;
}

export interface Rgba8 {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface CanvasFill {
  width: number;
  height: number;
  background: Rgba8;
}

export interface ImageParams {
  canvas?: CanvasFill | null;
  resize?: Resize | null;
  crop?: Crop | null;
  rotate: Rotation;
  flip: Flip;
  adjust?: Adjust | null;
  applyExifOrientation: boolean;
  background: Rgba8;
}

export interface EncodeOptions {
  format: ImageFormat;
  quality: number;
  lossless: boolean;
  keepMetadata: boolean;
  pngOptimize: boolean;
}

export interface ImageMeta {
  width: number;
  height: number;
  format: string;
  hasAlpha: boolean;
  exifOrientation: number;
  bytes: number;
  peakMemoryEstimate: number;
}

export interface ImageResultMeta {
  /** 图片格式为 ImageFormat；视频/PDF 任务使用容器名（mp4/webm/pdf） */
  outFormat: ImageFormat | 'mp4' | 'webm' | 'pdf';
  outWidth: number;
  outHeight: number;
  inputBytes: number;
  outputBytes: number;
  outputHash: string;
  savingsRatio: number;
  savingsText: string;
}

export interface Limits {
  maxPixels: number;
  maxBytes: number;
  maxBatch: number;
  maxDurationSec: number;
  maxPages: number;
  maxMemoryBytes: number;
  maxConcurrent: number;
  isRestricted: boolean;
}

export interface ImageCaps {
  formats: ImageFormat[];
  avif: boolean;
  maxPixels: number;
  parallel: number;
  pngOptimize: boolean;
}

export interface VideoCaps {
  available: boolean;
  engines: ('webcodecs' | 'ffmpeg-wasm' | 'ffmpeg-sidecar')[];
  decoders: string[];
  encoders: string[];
  hardwareEncoder: boolean;
  maxBytes: number;
  maxDurationSec: number;
  /** 解封装只支持 ISOBMFF（MP4）；其余容器引导桌面版 */
  inputContainers?: string[];
  /** 在线版可输出的容器 */
  outputContainers?: string[];
  /** AAC 源可直接透传进 MP4，不需要 AudioEncoder */
  audioPassthrough?: boolean;
}

export interface PdfCaps {
  render: boolean;
  edit: boolean;
  /** 单次渲染页数上限；-1 表示不限（桌面端） */
  maxPages: number;
  /** 可用最高 DPI；Web 200、桌面更高（渲染仍走 webview 内 pdf.js） */
  maxDpi?: number;
}

export interface OfficeCaps {
  wordToPdf: 'native' | 'structured' | 'none';
  pdfToWord: 'native' | 'structured' | 'none';
}

export interface Capabilities {
  kind: 'web' | 'desktop';
  contractVersion: 1;
  image: ImageCaps;
  video: VideoCaps;
  pdf: PdfCaps;
  office: OfficeCaps;
  cancel: { hard: boolean };
  fileSystem: { directoryPicker: boolean; savePicker: boolean; nativeFilePicker?: boolean };
  offline: { serviceWorker: boolean; installed: boolean };
  env: { userAgentMajor: string; crossOriginIsolated: boolean };
}

export type Phase =
  | 'queued'
  | 'decoding'
  | 'transforming'
  | 'encoding'
  | 'writing'
  | 'optimizing'
  | 'finalizing';

export type Unit = 'bytes' | 'pixels' | 'pages' | 'frames' | 'percent';

export interface Progress {
  done: number;
  total: number;
  phase: Phase;
  unit: Unit;
}

export interface LogEntry {
  level: 'info' | 'warn' | 'error';
  message: string;
  at: number;
}

export interface RunOptions {
  taskId: string;
  onProgress: (p: Progress) => void;
  signal: AbortSignal;
  onLog?: (e: LogEntry) => void;
}

/** 输入引用：Web 是 File，桌面是绝对路径。二者互斥。 */
export interface InputRef {
  file?: File;
  path?: string;
  name: string;
  size: number;
}

export interface PdfMeta {
  pages: number;
  bytes: number;
  encrypted: boolean;
  version: string;
}

export interface PageRange {
  from: number;
  toInclusive: number;
}

export interface PageSelectorDto {
  ranges: PageRange[];
  oddOnly: boolean;
  evenOnly: boolean;
}

/** PDF→图片渲染参数（Web 侧由 pdf.js 在主线程执行；桌面侧走 pdfium/FFmpeg） */
export interface PdfRenderParams {
  /** 渲染 DPI，72/96/150/200/300 */
  dpi: number;
  /** 页码范围；空数组表示全部页 */
  pages: PageRange[];
  /** 输出格式 */
  format: 'png' | 'jpeg' | 'webp';
  /** jpeg/webp 质量（0–1），png 忽略 */
  quality: number;
  /** 透明背景填充色（PDF 页面默认白底，这里留作显式控制） */
  background: string;
  /** 把所有选中页竖向拼成一张长图 */
  longImage: boolean;
}

/** Web 轻量视频转码参数。
 *
 * 容器决定编码器：mp4 → H.264（AVC），webm → VP9；无硬件编码。
 * 音频仅在「MP4 输出 + 源为 AAC + keepAudio」时以原始码流透传，其他情况无音轨。
 */
export interface VideoTranscodeParams {
  container: 'mp4' | 'webm';
  /** 输出码率，单位 Mbps；0.4–12 */
  bitrateMbps: number;
  /** 尺寸缩放百分比，10–100；保持宽高比 */
  scalePercent: number;
  /** 输出帧率，0 表示沿用源帧率；1–60 */
  fps: number;
  /** 是否尝试保留音轨（见上方约束） */
  keepAudio: boolean;
}

/** 视频探测结果（只解封装，不解码） */
export interface VideoProbeResult {
  codec: string;
  width: number;
  height: number;
  durationSec: number;
  frameRate: number;
  hasAudio: boolean;
  audioCodec?: string;
  /** 源音轨能否在 MP4 输出中无损透传 */
  audioPassthrough: boolean;
}

export type TaskPayload =
  | { kind: 'image.process'; input: InputRef; params: ImageParams; encode: EncodeOptions }
  | { kind: 'video.transcode'; input: InputRef; params: VideoTranscodeParams }
  | { kind: 'pdf.render'; input: InputRef; params: PdfRenderParams }
  | { kind: 'pdf.merge'; inputs: InputRef[] }
  | { kind: 'pdf.split'; input: InputRef; ranges: PageRange[] }
  | { kind: 'pdf.rotate'; input: InputRef; pages: PageSelectorDto; degrees: number }
  | { kind: 'pdf.extract'; input: InputRef; pages: PageSelectorDto; what: 'text' | 'images' | 'pages' }
  | { kind: 'office.structure'; input: InputRef; direction: 'docx2pdf' | 'pdf2docx' }
  /** 桌面端用 LibreOffice headless 原生转换（Web 不支持，UI 按 capabilities 决定） */
  | { kind: 'office.convert'; input: InputRef; direction: 'docx2pdf' | 'pdf2docx' };

export interface TaskResult {
  bytes: Uint8Array;
  meta: ImageResultMeta;
  outputName: string;
  /** 多文件输出（PDF 拆分 / 图片提取）时填充 */
  outputs?: Array<{ name: string; bytes: Uint8Array }>;
  savedOutputs?: Array<{ name: string; path: string; bytes: number }>;
  /** 文本输出（PDF 提取文本）时填充 */
  text?: string;
}

export interface Backend {
  readonly kind: 'web' | 'desktop';
  capabilities(): Promise<Capabilities>;
  limits(): Promise<Limits>;
  run(task: TaskPayload, opts: RunOptions): Promise<TaskResult>;
  cancel(taskId: string): void;
  /** 打开文件选择；Web 用 input，桌面用系统对话框 */
  pickFiles(accept: string, multiple: boolean): Promise<InputRef[]>;
  /** 保存结果：Web 触发下载，桌面写文件 */
  saveOutput(bytes: Uint8Array, name: string, options?: { directDownload?: boolean }): Promise<'downloaded' | 'saved' | 'cancelled'>;
  /** 在系统浏览器中打开 LibreOffice 官方下载页。 */
  openLibreOfficeDownload?(): Promise<void>;
  /** 释放资源（worker / 事件监听） */
  dispose(): void;
  /**
   * 只读探测（不解码像素）。可选：桌面端也可以实现，但 Phase 1 只有 Web 侧用到。
   * 放在接口上而不是让 UI 去 import 具体类是刻意的 —— 否则 features/ 就会依赖 Web 实现。
   */
  probe?(ref: InputRef): Promise<unknown>;
  /** PDF 结构探测：Web 与 Tauri 共用统一页面流程。 */
  probePdf?(ref: InputRef): Promise<PdfMeta>;
  /** PDF 图片预览读取：桌面端从本地路径读取，Web 直接使用 File。 */
  readPdf?(ref: InputRef): Promise<ArrayBuffer>;
  /** 视频探测（只解元数据）：Web 走 mp4box，桌面走 ffprobe。返回 VideoProbeResult。 */
  probeVideo?(ref: InputRef): Promise<VideoProbeResult>;
}

/** 视频转码结果元数据（两端同形状） */
export interface VideoResultMeta {
  outputPath?: string;
  outFormat: 'mp4' | 'webm';
  outWidth: number;
  outHeight: number;
  durationSec: number;
}
