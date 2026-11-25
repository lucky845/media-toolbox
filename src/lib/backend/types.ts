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

export interface ImageParams {
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
  outFormat: ImageFormat;
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
}

export interface PdfCaps {
  render: boolean;
  edit: boolean;
  maxPages: number;
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
  fileSystem: { directoryPicker: boolean; savePicker: boolean };
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

export interface PageRange {
  from: number;
  toInclusive: number;
}

export type TaskPayload =
  | { kind: 'image.process'; input: InputRef; params: ImageParams; encode: EncodeOptions }
  | { kind: 'pdf.merge'; inputs: InputRef[] }
  | { kind: 'pdf.split'; input: InputRef; ranges: PageRange[] }
  | { kind: 'video.transcode'; input: InputRef; params: unknown };

export interface TaskResult {
  bytes: Uint8Array;
  meta: ImageResultMeta;
  outputName: string;
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
  saveOutput(bytes: Uint8Array, name: string): Promise<'downloaded' | 'saved' | 'cancelled'>;
  /** 释放资源（worker / 事件监听） */
  dispose(): void;
  /**
   * 只读探测（不解码像素）。可选：桌面端也可以实现，但 Phase 1 只有 Web 侧用到。
   * 放在接口上而不是让 UI 去 import 具体类是刻意的 —— 否则 features/ 就会依赖 Web 实现。
   */
  probe?(ref: InputRef): Promise<ImageMeta>;
}
