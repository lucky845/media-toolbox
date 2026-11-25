# 接口契约（Phase 0 交付物 2/8）

> 规则：**先定契约，再写实现**。本文里的签名就是 Phase 1 起的实现目标；改动契约必须先改本文并在 CHANGELOG 记录。
> 版本：`contract/v1`。所有跨语言结构都有稳定的 `serde` 表示，TS 侧由 `scripts/gen-types.mjs` 从 Rust 注释块生成（Phase 1 落地），不做手工同步。

---

## 1. 错误码表（唯一来源 `crates/core/src/common/error.rs`）

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    // ---- 输入与资源限制 ----
    InputTooLarge,      // 文件字节数超阈值
    DimensionLimit,     // 像素数超阈值
    PageLimit,          // PDF 页数超阈值
    DurationLimit,      // 视频时长超阈值
    MemoryLimit,        // 预估峰值内存超阈值（计算得出，非 OOM 后才知道）
    // ---- 格式与编解码 ----
    UnsupportedFormat,
    DecodeFailed,
    EncodeFailed,
    CodecUnsupported,   // 浏览器/FFmpeg 不支持该编码
    // ---- 运行时 ----
    Cancelled,
    Timeout,
    OutOfMemory,
    Io,
    PermissionDenied,
    InvalidParams,
    Internal,
    // ---- 部署与环境（只在特定壳出现）----
    WasmLoadFailed,     // wasm fetch/实例化失败
    WasmMimeMismatch,   // MIME 不是 application/wasm 且降级也失败
    BinaryMissing,      // 桌面 sidecar 不存在
    BinaryVersion,      // ffmpeg configure 行核验失败
    LibreOfficeMissing,
}
```

每条错误码的**中文文案、可重试、是否引导桌面版**在同一文件的 `spec()` 中定义，TS 侧通过 `GET_ERROR_SPEC` 取，不复制：

| 错误码 | 中文（用户可见） | 可重试 | 引导桌面版 | 备注（开发者可见） |
|---|---|---|---|---|
| `INPUT_TOO_LARGE` | 文件超过在线版上限（{{limit}}），请使用桌面版处理 | 否 | 是 | 阈值来自 `limits.rs` |
| `DIMENSION_LIMIT` | 图片像素数超过在线版上限（{{limit}} MP） | 否 | 是 | 20 MP |
| `PAGE_LIMIT` | PDF 页数超过在线版上限（{{limit}} 页） | 否 | 是 | 100 页 |
| `DURATION_LIMIT` | 视频时长超过在线版上限（{{limit}}） | 否 | 是 | 5 分钟 |
| `MEMORY_LIMIT` | 预计需要 {{need}} 内存，超过安全值 {{cap}} | 否 | 是 | 见 §7 峰值模型 |
| `UNSUPPORTED_FORMAT` | 不支持的文件格式：{{detail}} | 否 | 否 | |
| `DECODE_FAILED` | 文件解码失败，可能已损坏或格式不受支持 | 是 | 否 | 桌面版可尝试更多解码器 |
| `ENCODE_FAILED` | 编码失败：{{detail}} | 是 | 否 | |
| `CODEC_UNSUPPORTED` | 当前浏览器不支持 {{codec}} 编码，请改用桌面版或换一种格式 | 否 | 是 | |
| `CANCELLED` | 已取消 | 否 | 否 | 不计入失败统计 |
| `TIMEOUT` | 处理超时（超过 {{sec}} 秒） | 是 | 否 | |
| `OUT_OF_MEMORY` | 内存不足，请减小尺寸或改用桌面版 | 是 | 是 | wasm OOM 时尽力捕获 |
| `IO` | 读写失败：{{detail}} | 是 | 否 | 非 UTF-8 路径在这里体现 |
| `PERMISSION_DENIED` | 没有文件访问权限 | 否 | 否 | 目录句柄失效等 |
| `INVALID_PARAMS` | 参数不合法：{{detail}} | 否 | 否 | |
| `INTERNAL` | 内部错误（{{id}}） | 是 | 否 | `id` 是日志关联 ID，不含内容 |
| `WASM_LOAD_FAILED` | 核心模块加载失败，请刷新页面重试 | 是 | 是 | |
| `WASM_MIME_MISMATCH` | 核心模块 MIME 不正确（{{mime}}），本地服务器可能未识别 .wasm | 是 | 否 | 本地 `http.server` 常见 |
| `BINARY_MISSING` | 桌面组件缺失：{{name}}，请重新安装 | 否 | 否 | 安装包不完整 |
| `BINARY_VERSION` | 桌面组件 {{name}} 版本不匹配（需要 {{need}}） | 否 | 否 | configure 行核验失败 |
| `LIBREOFFICE_MISSING` | 未找到 LibreOffice，Word↔PDF 只能做结构化转换 | 否 | 否 | 降级而非失败 |

**序列化形状**（跨 Rust→TS 一致）：

```rust
pub struct ToolError {
    pub code: ErrorCode,
    pub message: String,        // 已插值的用户文案
    pub detail: Option<String>, // 开发者细节，默认不展示，日志开关打开时展示
    pub retryable: bool,
    pub desktop_hint: bool,
    pub log_id: Option<String>, // "e-<8 hex>"，与内容无关
}
```

**约定**：`message` 必须是中文且已完成插值；`detail` 不得含文件路径或文件内容（Privacy 约束）。

---

## 2. Rust core 公开 API（`crates/core`）

### 2.1 上下文注入（唯一的平台差异入口）

```rust
// crates/core/src/lib.rs
pub struct Ctx<'a> {
    pub parallel: &'a dyn Parallel,
    pub progress: &'a dyn ProgressSink,   // 内部做节流，见 §2.5
    pub cancel:   &'a dyn CancelToken,
    pub limits:   &'a Limits,
}
```

`core` 的所有入口都**必须**接 `&Ctx`，不允许出现不带 ctx 的便捷函数（否则并行与取消会被绕过）。

### 2.2 图片

```rust
// crates/core/src/image/params.rs
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageParams {
    pub resize: Option<Resize>,
    pub crop: Option<Crop>,
    #[serde(default)] pub rotate: Rotation,      // none | cw90 | cw180 | cw270
    #[serde(default)] pub flip: Flip,            // none | h | v | both
    pub adjust: Option<Adjust>,
    #[serde(default = "default_true")] pub apply_exif_orientation: bool,
    #[serde(default)] pub background: Rgba8,     // 透明→不透明格式时的填充色，默认不透明白
}

pub struct Resize {
    pub width: Option<u32>, pub height: Option<u32>,   // 至少给一个；都给时按 mode
    pub mode: ResizeMode,     // fit（保持宽高比塞进框）| fill（保持比例填满并裁剪）| exact（拉伸）
    pub filter: Filter,       // nearest | triangle | catmull_rom | gaussian | lanczos3
    pub allow_upscale: bool,  // 默认 false
}

pub struct Crop { pub x: u32, pub y: u32, pub width: u32, pub height: u32 }

pub struct Adjust { pub brightness: f32, pub contrast: f32, pub saturation: f32 } // 1.0 = 不变；范围 [0,4]

pub struct Rgba8 { pub r: u8, pub g: u8, pub b: u8, pub a: u8 }

// crates/core/src/image/encode.rs
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EncodeOptions {
    pub format: OutFormat,          // jpeg | png | webp | avif | gif | bmp | tiff
    pub quality: u8,                // 1..=100，无损格式忽略
    pub lossless: bool,             // png/webp/avif 有效
    pub keep_metadata: bool,        // 默认 false：默认剥 EXIF/GPS/ICC 以外的元数据
    pub png_optimize: bool,         // 走 oxipng（native 默认 true，wasm 视预算）
}

/// 纯函数：解密后字节进，编码后字节出。不做任何 IO。
pub fn process_image(src: &[u8], params: &ImageParams, enc: &EncodeOptions, ctx: &Ctx)
    -> Result<Vec<u8>, ToolError>;

/// 只读探测：尺寸/格式/EXIF 方向/预估输出大小（不编码）。
pub fn probe_image(src: &[u8]) -> Result<ImageMeta, ToolError>;

pub struct ImageMeta {
    pub width: u32, pub height: u32,
    pub format: String,        // "jpeg" | "png" | ...
    pub has_alpha: bool,
    pub exif_orientation: u8,  // 1..=8
    pub bytes: u64,
    pub peak_memory_estimate: u64, // 见 §7
}
```

**流水线顺序（固定，不得因并行实现改变）**：
`解码 → EXIF 方向规整（旋转+镜像）→ 裁剪 → 旋转/翻转 → 缩放 → 色彩调整 → 背景填充(若目标格式无 alpha) → 编码 → （可选）无损优化`

### 2.3 PDF（结构操作，纯字节）

```rust
pub fn pdf_merge(inputs: &[Vec<u8>], ctx: &Ctx) -> Result<Vec<u8>, ToolError>;
pub fn pdf_split(src: &[u8], ranges: &[PageRange], ctx: &Ctx) -> Result<Vec<(String, Vec<u8>)>, ToolError>;
pub fn pdf_rotate(src: &[u8], pages: &PageSelector, degrees: i32, ctx: &Ctx) -> Result<Vec<u8>, ToolError>;
pub fn pdf_extract_pages(src: &[u8], pages: &PageSelector, ctx: &Ctx) -> Result<Vec<u8>, ToolError>;
pub fn pdf_extract_text(src: &[u8], pages: &PageSelector, ctx: &Ctx) -> Result<String, ToolError>;
pub fn pdf_extract_images(src: &[u8], pages: &PageSelector, ctx: &Ctx) -> Result<Vec<(String, Vec<u8>)>, ToolError>;
pub struct PageRange { pub from: u32, pub to_inclusive: u32 }
pub struct PageSelector { pub ranges: Vec<PageRange>, pub odd_only: bool, pub even_only: bool }
```

### 2.4 视频（**纯函数**：argv 构造 + 进度换算 + 元数据解析，两端共用）

```rust
// crates/core/src/video/args.rs —— Web(ffmpeg.wasm) 与 桌面(sidecar) 都调这一份
pub fn build_transcode_args(p: &TranscodeParams, input: &str, output: &str) -> Vec<String>;
pub fn build_extract_frame_args(p: &FrameParams, input: &str, output: &str) -> Vec<String>;
pub fn build_extract_audio_args(p: &AudioParams, input: &str, output: &str) -> Vec<String>;

// crates/core/src/video/progress.rs —— 解析 ffmpeg -progress pipe:1 的键值流（增量、无缓冲）
pub struct ProgressParser { /* out_time_us, total_us, frame, speed */ }
impl ProgressParser {
    pub fn new(total_duration_us: u64) -> Self;
    pub fn feed_line(&mut self, line: &str) -> Option<Progress>;  // 每行返回增量状态，非每块
}

// crates/core/src/video/meta.rs —— 解析 ffprobe -print_format json 的子集（只取需要的字段，不引完整 JSON 模型）
pub fn parse_ffprobe(json: &str) -> Result<VideoMeta, ToolError>;
```

`build_transcode_args` 的契约：
- 必须包含 `-hide_banner -nostdin -y`；进度由 `-progress pipe:1 -nostats` 驱动。
- 参数**只**来自 `TranscodeParams`，不接受前端透传任意 argv（这是安全边界：桌面版 `Shell::sidecar` 若接受任意参数就成了任意命令执行）。
- 返回 `Vec<String>` 而不是拼接好的字符串，杜绝引号注入。

### 2.5 进度模型

```rust
// crates/ports/src/progress.rs
pub trait ProgressSink: Sync {
    fn report(&self, p: Progress);
}
#[derive(Serialize, Clone, Copy, Debug)]
pub struct Progress {
    pub done: u64,
    pub total: u64,          // 0 表示未知（视频转码未知总量时）
    pub phase: Phase,        // queued|decoding|transforming|encoding|writing|optimizing|finalizing
    pub unit: Unit,          // bytes|pixels|pages|frames|percent
}
```

**节流契约**：`ProgressSink` 的实现（wasm 侧是 `js_sys::Function` 包装，native 侧是 Tauri event）必须
1. 相同 `phase` 下，间隔 ≥ 100 ms 才真正跨边界发送；
2. 任何 `phase` 变化立即发送；
3. `done == total` 的那一次必须发送（不允许被节流吞掉）。
这样 100 页 PDF 也只产生 ≤ 数千条事件，而不是每页每像素一条。

---

## 3. wasm 导出（`crates/wasm`，`--target web`）

```rust
// crates/wasm/src/lib.rs
#[wasm_bindgen(start)] pub fn start(); // 装 panic hook（仅 dev）

#[wasm_bindgen]
pub fn version() -> String;

#[wasm_bindgen]
pub fn get_limits() -> String;                  // Limits 的 JSON
#[wasm_bindgen]
pub fn get_error_spec() -> String;              // 错误码表 JSON（文案+retryable+desktopHint）

#[wasm_bindgen]
pub fn probe_image(input: &[u8]) -> Result<String, JsValue>;   // ImageMeta JSON

#[wasm_bindgen]
pub fn process_image(
    input: &[u8],
    params_json: &str,          // ImageParams
    encode_json: &str,          // EncodeOptions
    on_progress: &js_sys::Function,   // (done: u64, total: u64, phase: &str) => void
) -> Result<Vec<u8>, JsValue>;  // 失败时 JsValue 是 ToolError 的 JSON 字符串

#[wasm_bindgen]
pub fn cancel_token_new() -> CancelHandle;      // 见下
```

**取消的 wasm 实现**：wasm 单线程且 `process_image` 是同步阻塞的，JS 无法在其执行期间调用 `cancel`。因此契约**明确**：

- wasm 侧的取消粒度是**阶段边界**（解码完成、缩放块之间、编码前后），由 worker 侧的 `SharedArrayBuffer` 不可用 → 改用 **`postMessage` 无法打断同步调用** 的现实约束，采取：
1. 长任务切分成多段调用（`process_image_stage(stage_index, ...)`），每段之间 worker 检查 `cancelRequested` 标志；
2. 用户在 UI 点取消 → 主线程 `worker.terminate()`（立即生效，代价是重建 worker ≈ 30–80 ms，可接受）。
- 因此 `capabilities().cancel.hard` 在 Web 端为 **false**，UI 文案是「已取消」而不是「正在停止」。
- 桌面端 `CancelToken` 是 `Arc<AtomicBool>` + 子进程 `kill`，`hard` 为 **true**。

这条差异是**数据**（`capabilities().cancel`），不是代码分支。

**内存权属**：输入 `&[u8]` 由 wasm 从 JS `Uint8Array` 复制一份进线性内存；输出 `Vec<u8>` 由 wasm-bindgen 复制回 JS 后释放。峰值因此在 wasm 侧是 `2×input + 工作区`，§7 的模型要算上这一份。

---

## 4. Tauri commands（`src-tauri`）

命名与参数一律 `snake_case`，返回值统一 `Result<T, ToolError>`（`ToolError` 实现 `serde::Serialize`，前端收到的是结构体而非字符串）。

```rust
#[tauri::command] fn probe_capabilities() -> Result<Capabilities, ToolError>;

// 图片：路径进，路径出（不把大 buffer 过 IPC）
#[tauri::command] async fn image_process(
    input_path: String, output_path: String,
    params: ImageParams, encode: EncodeOptions,
    task_id: String, app: AppHandle,
) -> Result<ImageResult, ToolError>;

// 视频
#[tauri::command] async fn video_transcode(args: VideoTask, task_id: String, app: AppHandle)
    -> Result<VideoResult, ToolError>;
#[tauri::command] async fn video_probe(path: String) -> Result<VideoMeta, ToolError>;

// 文档
#[tauri::command] async fn office_convert(args: OfficeTask, task_id: String, app: AppHandle)
    -> Result<OfficeResult, ToolError>;
#[tauri::command] async fn pdf_convert(args: PdfRenderTask, task_id: String, app: AppHandle)
    -> Result<Vec<OutputFile>, ToolError>;

// 取消
#[tauri::command] fn cancel_task(task_id: String) -> Result<(), ToolError>;
```

**进度事件契约**（`listen` 侧）：

```jsonc
// event: "task://progress"
{ "taskId": "t-1a2b", "done": 4096, "total": 10240,
  "phase": "decoding", "unit": "bytes", "speed": 1.24, "etaSec": 12 }

// event: "task://log"     —— 只在用户打开「显示日志」时订阅
{ "taskId": "t-1a2b", "level": "info", "message": "ffmpeg -progress: out_time_us=..." }
```

**取消的进程树处理**（必须实现，否则会留孤儿进程）：

```
cancel_task(task_id)
  → 查表得到 Child
  → #[cfg(unix)] kill(-pgid, SIGTERM) 后等待 2s，仍在则 SIGKILL
  → #[cfg(windows)] taskkill /PID <pid> /T /F
  → 删除该 task 的临时目录 $TMPDIR/media-toolbox/<task_id>/
  → 向主线程回 progress{phase:"finalizing"} 后 settle 为 E_CANCELLED
```

**临时目录契约**：所有中间文件必须落在 `temp_dir()/media-toolbox/<task_id>/`，任务结束（成功/失败/取消）都删除；启动时清理超过 24 小时的遗留目录。

---

## 5. 前端 Backend 接口（`src/lib/backend/types.ts`）

```ts
export interface Backend {
  readonly kind: 'web' | 'desktop';
  capabilities(): Promise<Capabilities>;
  limits(): Promise<Limits>;

  run<T extends TaskPayload>(
    task: T,
    opts: RunOptions,
  ): Promise<TaskResult<T>>;

  cancel(taskId: string): void;

  /** 桌面端才有意义；Web 端返回空数组 */
  pickFiles(opts: PickOptions): Promise<PickedFile[]>;
  /** 结果落盘：Web 走下载/目录句柄，桌面走本地路径 */
  saveOutputs(outputs: OutputFile[], opts: SaveOptions): Promise<SaveOutcome>;
}

export interface RunOptions {
  taskId: string;
  onProgress: (p: Progress) => void;
  signal: AbortSignal;
  /** 桌面端用它拿 ffmpeg 日志；Web 端忽略 */
  onLog?: (e: LogEntry) => void;
}
```

### 5.1 `Capabilities` 形状（**UI 只认这个**）

```ts
export interface Capabilities {
  kind: 'web' | 'desktop';
  contractVersion: 1;
  image: {
    formats: Format[];            // 可输出去重后的列表
    avif: boolean;                // wasm 端 avif 是否编进包
    maxPixels: number;            // 20_000_000 或 Infinity
    parallel: number;             // 1 或 rayon 线程数
    pngOptimize: boolean;
  };
  video: {
    available: boolean;
    engines: ('webcodecs' | 'ffmpeg-wasm' | 'ffmpeg-sidecar')[];
    decoders: string[];           // 例如 ['avc1.42E01E','vp09.00.10.08','av01.0.05M.08']
    encoders: string[];
    hardwareEncoder: boolean;     // 桌面探测结果
    maxBytes: number; maxDurationSec: number;
  };
  pdf: { render: boolean; edit: boolean; maxPages: number };
  office: { wordToPdf: 'native' | 'structured' | 'none'; pdfToWord: 'native' | 'structured' | 'none' };
  cancel: { hard: boolean };      // false=只能是 terminate 级取消
  fileSystem: { directoryPicker: boolean; savePicker: boolean };
  offline: { serviceWorker: boolean; installed: boolean };
  env: { userAgentMajor: string; crossOriginIsolated: boolean };
}
```

`capabilities()` 的**失败语义**：抛 `ToolError` 时 UI 必须进入「受限模式」（只有 PDF 结构编辑与本地下载可用），不得静默降级成假设全支持。

### 5.2 `TaskPayload` 判别联合（与 Rust 的 `task` 字段一一对应）

```ts
export type TaskPayload =
  | { kind: 'image.process'; input: InputRef; params: ImageParams; encode: EncodeOptions }
  | { kind: 'pdf.merge'; inputs: InputRef[] }
  | { kind: 'pdf.split'; input: InputRef; ranges: PageRange[] }
  | { kind: 'pdf.render'; input: InputRef; pages: PageSelector; dpi: number; format: OutFormat }
  | { kind: 'video.transcode'; input: InputRef; params: TranscodeParams }
  | { kind: 'office.convert'; input: InputRef; direction: 'docx2pdf' | 'pdf2docx' };

export interface InputRef {
  /** Web: 内存里的 File；桌面: 绝对路径。二者互斥，且只允许由用户显式授权产生 */
  file?: File;
  path?: string;
}
```

---

## 6. Worker 消息协议（`src/workers/protocol.ts`）

**传输**：`postMessage`，`Transferable` 用于输入/输出 `ArrayBuffer`，避免结构化克隆的额外复制。

```ts
// 主线程 → worker
type ToWorker =
  | { v: 1; type: 'init'; wasmUrl: string; baseUrl: string }
  | { v: 1; type: 'run'; taskId: string; payload: TaskPayload; transfer: ArrayBuffer[]
      /* input.buffer 已转移，payload 里放的是引用索引 */ }
  | { v: 1; type: 'cancel'; taskId: string }
  | { v: 1; type: 'dispose' };

// worker → 主线程
type FromWorker =
  | { v: 1; type: 'ready'; version: string; limits: Limits }
  | { v: 1; type: 'progress'; taskId: string; p: Progress }
  | { v: 1; type: 'done'; taskId: string; output: ArrayBuffer; meta: OutputMeta }
  | { v: 1; type: 'error'; taskId: string; error: ToolError }
  | { v: 1; type: 'cancelled'; taskId: string }
  | { v: 1; type: 'log'; taskId: string; level: 'info'|'warn'|'error'; message: string };
```

**不变量（测试必须覆盖）**：

1. 一个 `taskId` 在 worker 生命周期内**至多**产生一个终止消息（`done` / `error` / `cancelled`），之后的任何消息都是 bug。
2. `progress` 只在 `run` 之后、终止消息之前出现。
3. 收到未知 `taskId` 的应答必须丢弃并记一条 `warn`，不得抛错（`terminate` 后残留消息是常态）。
4. `v` 字段不匹配 → worker 立刻回 `error{code:'INTERNAL'}`，主线程记录并重建 worker（为将来热更新留出余地）。
5. `transfer` 里的 buffer 在发送后主线程侧必须置空（`byteLength === 0`），否则说明发生了复制。

**Worker 池**：`min(2, hardwareConcurrency-1)`，可降到 1（用户在设置里选）。池调度是**任务级**的（一个 worker 同时只处理一个 task），不做任务内并行（wasm 无多线程）。

---

## 7. 内存峰值模型（阈值不是拍脑袋）

```
decode_peak  = W*H*4                         // RGBA8
transform    = 1.0 * decode_peak             // 双缓冲（读/写各一份）
encode_ws    = 1.5 * decode_peak             // 编码器工作区（jpeg/webp 实测上界）
wasm_copy    = 2 * input_bytes               // 进/出线性内存各一份
total        = decode_peak + transform + encode_ws + wasm_copy + output_bytes
```

代入 20 MP：`80 + 80 + 120 + 2*20 + out ≈ 320 MB`。这是把上限定在 20 MP 的算术依据（留出 4 GB wasm 逻辑上限之外的浏览器实际可用量）。
`probe_image` 返回的 `peak_memory_estimate` 就用这个公式算，超过 `limits.maxMemoryBytes`（Web = 512 MB）时**在开始前**返回 `MEMORY_LIMIT`。

---

## 8. 任务状态机（前端 `store/queue.ts`，两端同一份）

```
                 ┌──────────┐
   入队 ────────▶│  queued  │──────────┐
                 └────┬─────┘          │ 用户移除
        调度器取走     │                ▼
                 ┌────▼─────┐      ┌─────────┐
                 │ running  │      │ removed │（终态，仅内存中消失）
                 └──┬───┬───┘      └─────────┘
          成功 │     │   │ 失败
              ▼     │   ▼
        ┌──────────┐│ ┌────────┐
        │succeeded ││ │ failed │──重试──▶ queued
        └──────────┘│ └────────┘
                    │取消/超时
                    ▼
              ┌───────────┐
              │ cancelled │──重试──▶ queued
              └───────────┘
```

**暂停语义（诚实版）**：

- `queued` 的任务可以「暂停」（实际是标记 `paused`，调度器跳过），**这是唯一真正可暂停的状态**。
- `running` 的任务**不能暂停**，只能取消。原因：wasm 侧同步执行无法冻结；桌面 FFmpeg 有 `SIGSTOP` 但跨平台行为不一致（Windows 无对应语义），做成「半可用」比不做更糟。UI 上 `running` 卡片只给「取消」按钮。
- 因此规格里的「暂停/取消/重试」落地为：队列级暂停（不取新任务）、单任务取消、失败/取消后重试。

**不变量**：
1. `succeeded` 状态必须带 `outputBytes`，`failed` 必须带 `ToolError`。
2. 重试递增 `attempt`，`attempt > 3` 时禁用重试按钮并提示。
3. `cancel()` 幂等：对 `queued` 直接转 `cancelled` 且不启动 worker；对 `running` 发 `cancel` 消息并 `terminate`。
4. 关闭页面前若存在 `running` 任务，注册 `beforeunload`（Web）提示；桌面端不提示（任务在后台进程，但会随窗口关闭而取消，同样提示）。

---

## 9. 最近任务持久化（只存元数据）

```ts
// IndexedDB: db "media-toolbox", store "recent"; 桌面端用 localStorage（同结构）
export interface RecentTask {
  id: string; createdAt: number;
  kind: TaskPayload['kind'];
  fileNames: string[];        // 只存文件名，不存路径，不存内容
  paramsHash: string;         // 用于「用相同参数再跑一次」
  params: unknown;            // 参数快照（不含文件内容）
  outcome: 'succeeded' | 'failed' | 'cancelled';
  inputBytes?: number; outputBytes?: number;
  errorCode?: string;         // 只存码不存 message（避免把文件名拼进文案后落盘）
}
```

**容量**：最多 100 条，超出按 `createdAt` 淘汰；总大小上限 512 KB，超出按条淘汰。写入前做一次 JSON 大小检查。

---

## 10. 一致性测试契约（Phase 6 的验收线）

| 测试 | 输入 | 通过标准 |
|---|---|---|
| `core` 变换单测 | 生成的测试图 | 旋转 4 次回到原图逐字节相等；裁剪/缩放边界不 panic |
| 编解码往返 | 小样本集 | `decode(encode(x))` 的 PSNR ≥ 设定值（有损）/ 逐字节相等（无损） |
| **两端同源** | 同一输入 + 同一参数 | Web(wasm) 与 Desktop(native) 输出**逐字节相等**；做不到的必须白名单 + 写明原因（例如 AVIF 多线程非确定） |
| Worker 协议 | 伪造消息序列 | §6 的 5 条不变量全部成立 |
| 取消路径 | 长任务中途取消 | 3 秒内 settle 为 `CANCELLED`；无残留临时目录；无僵尸进程 |
| 阈值/降级 | 超限输入 | 返回对应错误码且 `desktop_hint === true`；UI 不进入 running |

「两端同源」用**哈希**比对：`blake3(web_out) == blake3(desktop_out)`，CI 里要两个 target 都跑（`cargo test` 与 `wasm-bindgen-test`），所以核心逻辑不能依赖 std 的时间/随机/线程。

---

## 11. 契约变更流程

1. 改本文 + 改 Rust 类型（`serde` 表示）；
2. `scripts/gen-types.mjs` 重新生成 `src/lib/backend/generated.ts`；
3. `tests/backend.contract.test.ts` 必须仍通过（它对两个 mock 实现跑同一套断言）；
4. 破坏性变更升 `contractVersion` 到 2，并在 `docs/PLAN.md` 记一条迁移说明。
