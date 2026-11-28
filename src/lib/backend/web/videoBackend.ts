/** Web 轻量视频转码后端（WebCodecs + mp4box.js + mp4-muxer/webm-muxer）。
 *
 * 设计约束（见 docs/ARCHITECTURE.md D6 / docs/OWNERSHIP.md）：
 * 1. 解封装只支持 ISOBMFF（MP4），因为 mp4box.js 只解 MP4；mkv/mov/HEVC 明确引导桌面版。
 * 2. 编码走浏览器原生 VideoEncoder（无硬件编码、无 ffmpeg.wasm 自动下载）；容器为 MP4(H.264) 或 WebM(VP9)。
 * 3. 音频只在「MP4 输出 + 源 AAC(mp4a.40.2) + keepAudio」时以原始码流透传，
 *    其余情况输出无音轨并在 UI 常驻提示；不假装支持 AudioEncoder 重编码。
 * 4. 文件不离开本机；取消时关闭解码器/编码器、停止解封装并抛出 CANCELLED；
 *    所有错误映射为中文 ToolError，需要桌面版的置 desktopHint=true。
 *
 * 性能：解码/编码由浏览器内部线程完成；帧回调用 Promise 链串行化并做编码队列背压，
 * 每帧结束 close()，避免大量 VideoFrame 常驻内存。
 */

import * as MP4Box from 'mp4box';
import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from 'mp4-muxer';
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from 'webm-muxer';
import type {
  ErrorCode,
  InputRef,
  RunOptions,
  TaskResult,
  ToolError,
  VideoProbeResult,
  VideoTranscodeParams,
} from '../types';

function toolError(code: ErrorCode, message: string, detail?: string, desktopHint = false): ToolError {
  return { code, message, detail, retryable: false, desktopHint };
}

function asToolError(e: unknown): ToolError {
  if (e && typeof e === 'object' && 'code' in e && 'message' in e) return e as ToolError;
  return toolError('INTERNAL', '视频转码失败', String(e));
}

interface RawSample {
  cts: number;
  dts: number;
  duration: number;
  timescale: number;
  data: Uint8Array;
  isKey: boolean;
}

interface ParsedMp4 {
  buffer: ArrayBuffer;
  mp4: MP4Box.ISOFile;
  movie: MP4Box.Movie;
  video: MP4Box.Track;
  audio?: MP4Box.Track;
}

interface Demuxed extends ParsedMp4 {
  videoDescription?: Uint8Array;
  videoSamples: RawSample[];
  audioSamples: RawSample[];
}

/** 从 mp4box 的私有 AVC configuration box 拼出 WebCodecs 需要的 avcC 记录。 */
function avcDescription(mp4: MP4Box.ISOFile, trackId: number, buffer: ArrayBuffer): Uint8Array | undefined {
  // mp4box 的 onReady 里拿到的 Track（movie.videoTracks[0]）是「拍平」的元数据对象，
  // 没有 mdia/minf/stbl/stsd 盒子树；必须从 ISOFile.getTrackById 取原始 track 才能访问 avcC。
  const t = mp4.getTrackById(trackId) as unknown as {
    mdia?: { minf?: { stbl?: { stsd?: { entries?: Array<{ avcC?: { start: number; size: number } }> } } } };
  };
  const box = t.mdia?.minf?.stbl?.stsd?.entries?.[0]?.avcC;
  if (!box || box.size <= 8) return undefined;
  const from = box.start + 8;
  const to = box.start + box.size;
  if (from < 0 || to > buffer.byteLength || to <= from) return undefined;
  return new Uint8Array(buffer.slice(from, to));
}

function isMp4Name(name: string): boolean {
  return /\.mp4$/i.test(name) || /video\/mp4/i.test(name);
}

/** Race an asynchronous stage with interruption, even when the browser API has no signal support. */
function waitForVideoStep<T>(step: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    void step.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error) => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

/** 解析容器（不解码），供 probe 与 run 共用。 */
async function parseMp4(file: File, signal?: AbortSignal): Promise<ParsedMp4> {
  if (!isMp4Name(file.name)) {
    throw toolError(
      'UNSUPPORTED_FORMAT',
      '在线版只能读取 MP4 文件',
      'mp4box.js 仅解封装 ISOBMFF；MKV/MOV/HEVC 请用桌面版。',
      true,
    );
  }
  const read = file.arrayBuffer();
  const buffer = await (signal ? waitForVideoStep(read, signal) : read);
  signal?.throwIfAborted();
  const mp4 = MP4Box.createFile();
  let resolveReady!: (m: MP4Box.Movie) => void;
  let rejectReady!: (e: unknown) => void;
  const ready = new Promise<MP4Box.Movie>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  mp4.onError = (e: unknown) => rejectReady(toolError('DECODE_FAILED', 'MP4 解析失败', String(e), true));
  mp4.onReady = (m: MP4Box.Movie) => resolveReady(m);
  // mp4box 给 ArrayBuffer 加了 fileStart 属性（offset）来定位 append 位置。
  const mp4Buffer = buffer as ArrayBuffer & { fileStart: number };
  mp4Buffer.fileStart = 0;
  mp4.appendBuffer(mp4Buffer as unknown as Parameters<MP4Box.ISOFile['appendBuffer']>[0]);
  mp4.flush();
  const movie = await (signal ? waitForVideoStep(ready, signal) : ready);
  const video = movie.videoTracks[0];
  if (!video) {
    throw toolError('INVALID_PARAMS', '文件里没有视频轨道', '请使用包含 H.264 视频的 MP4。', true);
  }
  if (!/^avc[13]\./i.test(video.codec)) {
    throw toolError(
      'CODEC_UNSUPPORTED',
      `在线版只能转码 H.264(AVC) 视频，当前为 ${video.codec}`,
      'HEVC/AV1/VP9 源请用桌面版 FFmpeg。',
      true,
    );
  }
  return { buffer, mp4, movie, video, audio: movie.audioTracks[0] };
}

/** 提取视频/音频样本（压缩码流，尚未解码）。
 *  mp4box 的 `start()` 是异步分批回调 onSamples 的，必须等所有样本收齐（或超时）再返回，
 *  否则会拿到空数组导致「视频轨为空」。
 */
function extractSamples(parsed: ParsedMp4, signal: AbortSignal, timeoutMs = 10_000): Promise<Demuxed> {
  signal.throwIfAborted();
  const { buffer, video, audio } = parsed;
  const videoSamples: RawSample[] = [];
  const audioSamples: RawSample[] = [];
  const wantVideo = video.nb_samples || 0;
  const wantAudio = audio?.nb_samples || 0;
  let resolveDone!: (d: Demuxed) => void;
  let rejectDone!: (e: unknown) => void;
  const done = new Promise<Demuxed>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  const finish = () => {
    if (!videoSamples.length) {
      rejectDone(toolError('DECODE_FAILED', '视频轨为空', 'MP4 中没有可提取的视频样本。', true));
      return;
    }
    resolveDone({
      ...parsed,
      videoDescription: avcDescription(extractor, video.id, parsed.buffer),
      videoSamples,
      audioSamples,
    });
  };

  // mp4box 的样本回调发生在 appendBuffer/flush 处理数据时。parseMp4 已经把数据 append+flush
  // 过一遍（只为拿 onReady 元数据），那个实例不会再产出样本；必须用新实例在 onReady 里
  // 设置提取选项 + start()，再重新 append 数据，onSamples 才会被触发。
  const extractor = MP4Box.createFile();
  extractor.onError = (e: unknown) => rejectDone(toolError('DECODE_FAILED', '视频样本提取失败', String(e), true));
  extractor.onSamples = (id, _user, samples) => {
    const dest = id === video.id ? videoSamples : id === audio?.id ? audioSamples : null;
    if (!dest) return;
    for (const s of samples) {
      if (!s.data) continue;
      dest.push({
        cts: s.cts,
        dts: s.dts,
        duration: s.duration,
        timescale: s.timescale,
        data: new Uint8Array(s.data),
        isKey: s.is_sync === true,
      });
    }
    // 两个轨道都收齐后结束；无音轨时只等视频。
    const videoReady = wantVideo > 0 ? videoSamples.length >= wantVideo : videoSamples.length > 0;
    const audioReady = !audio || (wantAudio > 0 ? audioSamples.length >= wantAudio : audioSamples.length > 0);
    if (videoReady && audioReady) finish();
  };
  extractor.onReady = () => {
    extractor.setExtractionOptions(video.id, null, { nbSamples: 1000 });
    if (audio) extractor.setExtractionOptions(audio.id, null, { nbSamples: 1000 });
    extractor.start();
  };
  const mp4Buffer = buffer as ArrayBuffer & { fileStart: number };
  mp4Buffer.fileStart = 0;
  // 兜底：某些 MP4 的 nb_samples 不可靠，超时后用已收到的样本继续。
  const timer = setTimeout(finish, timeoutMs);
  const result = waitForVideoStep(done, signal).finally(() => {
    clearTimeout(timer);
    extractor.stop();
  });
  try {
    extractor.appendBuffer(mp4Buffer as unknown as Parameters<MP4Box.ISOFile['appendBuffer']>[0]);
    extractor.flush();
  } catch (error) {
    rejectDone(error);
  }
  return result;
}

function sampleUs(s: RawSample): { timestamp: number; duration: number } {
  const scale = s.timescale > 0 ? s.timescale : 1_000_000;
  return {
    timestamp: Math.round((s.cts * 1_000_000) / scale),
    duration: Math.max(1, Math.round((s.duration * 1_000_000) / scale)),
  };
}

const AUDIO_PASSTHROUGH_CODECS = new Set(['mp4a.40.2', 'mp4a.40.5']);

/** 供 capabilities() 使用：探测本浏览器实际支持的编解码器（不打开文件）。 */
export async function videoCodecSupport(): Promise<{ decoders: string[]; encoders: string[] }> {
  const check = async (api: 'VideoDecoder' | 'VideoEncoder', codec: string) => {
    if (!(api in globalThis)) return false;
    try {
      const ctor = (globalThis as unknown as Record<string, {
        isConfigSupported: (c: Record<string, unknown>) => Promise<{ supported: boolean }>;
      }>)[api]!;
      return (await ctor.isConfigSupported({
        codec,
        width: 640,
        height: 360,
        ...(api === 'VideoEncoder' ? { bitrate: 800_000, framerate: 30 } : {}),
      })).supported;
    } catch {
      return false;
    }
  };
  const decodeCandidates = ['avc1.42E01E', 'avc1.4D401F', 'avc1.640028', 'vp09.00.10.08', 'vp8', 'av01.0.04M.08'];
  const encodeCandidates = ['avc1.42E01E', 'avc1.4D401F', 'avc1.640028', 'vp09.00.10.08', 'vp8'];
  const decoders = (await Promise.all(decodeCandidates.map(async (c) => (await check('VideoDecoder', c)) ? c : null)))
    .filter((c): c is string => c !== null);
  const encoders = (await Promise.all(encodeCandidates.map(async (c) => (await check('VideoEncoder', c)) ? c : null)))
    .filter((c): c is string => c !== null);
  return { decoders, encoders };
}

function probe(file: File): Promise<VideoProbeResult> {
  return parseMp4(file).then(({ movie, video, audio }) => {
    const durationSec = movie.timescale > 0 ? movie.duration / movie.timescale : 0;
    const videoSec = video.timescale > 0 ? video.duration / video.timescale : 0;
    const denom = videoSec > 0 ? videoSec : durationSec;
    return {
      codec: video.codec,
      width: video.track_width || video.video?.width || 0,
      height: video.track_height || video.video?.height || 0,
      durationSec,
      frameRate: denom > 0 ? Math.round((video.nb_samples / denom) * 100) / 100 : 0,
      hasAudio: Boolean(audio),
      audioCodec: audio?.codec,
      audioPassthrough: Boolean(audio && AUDIO_PASSTHROUGH_CODECS.has(audio.codec)),
    };
  });
}

/** 选择浏览器实际支持的编码器配置（按兼容性优先）。 */
async function chooseEncoder(container: 'mp4' | 'webm', width: number, height: number, fps: number, bitrate: number, signal: AbortSignal) {
  const candidates = container === 'mp4'
    ? ['avc1.42E01E', 'avc1.4D401F', 'avc1.640028']
    : ['vp09.00.10.08', 'vp8'];
  const failures: string[] = [];
  for (const codec of candidates) {
    signal.throwIfAborted();
    const config: VideoEncoderConfig = {
      codec, width, height, bitrate,
      framerate: fps || 30,
      latencyMode: 'quality',
    };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) return { codec, config };
      failures.push(codec);
    } catch {
      failures.push(codec);
    }
  }
  throw toolError(
    'CODEC_UNSUPPORTED',
    container === 'mp4' ? '当前浏览器不支持 H.264 编码' : '当前浏览器不支持 VP9/VP8 编码',
    `尝试过：${failures.join(' / ')}。请换 Chrome/Edge，或用桌面版。`,
    true,
  );
}

interface AnyMuxer {
  addVideoChunk(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata, timestamp?: number): void;
  finalize(): void;
}

function shortHash(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 97) {
    h ^= bytes[i] ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const sleep0 = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** 执行转码：解封装 → 解码 → 可选缩放/降帧 → 编码 → 封装。 */
async function transcode(file: File, params: VideoTranscodeParams, opts: RunOptions): Promise<TaskResult> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(toolError('CANCELLED', '任务已取消'));
  if (opts.signal.aborted) onAbort();
  else opts.signal.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(
    toolError('TIMEOUT', '转码超时（120 秒）', '请缩短视频或使用桌面版。', true),
  ), 120_000);
  try {
    return await transcodeVideo(file, params, { ...opts, signal: controller.signal });
  } catch (error) {
    throw asToolError(controller.signal.aborted ? controller.signal.reason : error);
  } finally {
    clearTimeout(timeout);
    opts.signal.removeEventListener('abort', onAbort);
  }
}

async function transcodeVideo(file: File, params: VideoTranscodeParams, opts: RunOptions): Promise<TaskResult> {
  const { signal } = opts;
  signal.throwIfAborted();
  const fileBytes = file.size;
  // 视频阈值独立于图片：≤200 MB、≤5 分钟（规格 §13；caps.video.maxBytes 为唯一来源）。
  const VIDEO_MAX_BYTES = 200 * 1024 * 1024;
  if (fileBytes > VIDEO_MAX_BYTES) {
    throw toolError(
      'INPUT_TOO_LARGE',
      '视频超过 200 MB，在线版无法处理',
      `当前 ${(fileBytes / 1024 / 1024).toFixed(1)} MB。请用桌面版处理大文件。`,
      true,
    );
  }
  const decoded = await parseMp4(file, signal);
  signal.throwIfAborted();
  const durationSec = decoded.movie.timescale > 0 ? decoded.movie.duration / decoded.movie.timescale : 0;
  if (durationSec > 300) {
    throw toolError('DURATION_LIMIT', '视频超过 5 分钟，在线版无法处理', `当前 ${durationSec.toFixed(1)} 秒。`, true);
  }

  const srcW = decoded.video.track_width || decoded.video.video?.width || 0;
  const srcH = decoded.video.track_height || decoded.video.video?.height || 0;
  if (srcW <= 0 || srcH <= 0) throw toolError('DECODE_FAILED', '无法读取视频尺寸');

  const scale = Math.min(100, Math.max(10, Math.round(params.scalePercent)));
  const outW = Math.max(2, Math.round((srcW * scale) / 100 / 2) * 2);
  const outH = Math.max(2, Math.round((srcH * scale) / 100 / 2) * 2);
  const videoSec = decoded.video.timescale > 0 ? decoded.video.duration / decoded.video.timescale : durationSec;
  const srcFps = videoSec > 0 ? decoded.video.nb_samples / videoSec : 30;
  const fps = Math.min(60, Math.max(0, Math.round(params.fps)));
  const bitrateMbps = Math.min(12, Math.max(0.4, params.bitrateMbps));
  const bitrate = Math.round(bitrateMbps * 1_000_000);

  const keepAudio = params.container === 'mp4' && params.keepAudio && Boolean(decoded.audio) &&
    AUDIO_PASSTHROUGH_CODECS.has(decoded.audio?.codec ?? '');

  const { codec: encoderCodec, config: encoderConfig } = await waitForVideoStep(
    chooseEncoder(params.container, outW, outH, fps || srcFps || 30, bitrate, signal), signal,
  );
  signal.throwIfAborted();
  opts.onLog?.({ level: 'info', message: `编码器：${encoderCodec}，${outW}×${outH}，${bitrateMbps} Mbps`, at: Date.now() });
  if (params.container === 'webm' && decoded.audio) {
    opts.onLog?.({ level: 'warn', message: 'WebM 输出需要 Opus 音轨，在线版不重编码音频，将输出无音轨视频。', at: Date.now() });
  } else if (decoded.audio && !keepAudio) {
    opts.onLog?.({ level: 'warn', message: '源音轨格式无法直接透传，将输出无音轨视频。', at: Date.now() });
  }

  const mp4Target = new Mp4Target();
  const webmTarget = new WebmTarget();
  let muxer: AnyMuxer;
  let addAudio: ((chunk: EncodedAudioChunk) => void) | undefined;
  if (params.container === 'mp4') {
    const m = new Mp4Muxer({
      target: mp4Target,
      video: { codec: 'avc', width: outW, height: outH, frameRate: fps || srcFps || 30 },
      audio: keepAudio
        ? {
            codec: 'aac',
            numberOfChannels: decoded.audio?.audio?.channel_count ?? 2,
            sampleRate: decoded.audio?.audio?.sample_rate ?? 44100,
          }
        : undefined,
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    });
    muxer = m;
    if (keepAudio) addAudio = (chunk) => m.addAudioChunk(chunk);
  } else {
    muxer = new WebmMuxer({
      target: webmTarget,
      video: {
        codec: encoderCodec === 'vp8' ? 'V_VP8' : 'V_VP9',
        width: outW,
        height: outH,
        frameRate: fps || srcFps || 30,
      },
      firstTimestampBehavior: 'offset',
    });
  }

  opts.onProgress({ done: 0, total: 1, phase: 'decoding', unit: 'frames' });
  const extracted = await extractSamples(decoded, signal);
  signal.throwIfAborted();

  let decoder: VideoDecoder | undefined;
  let encoder: VideoEncoder | undefined;
  let backgroundError: unknown;
  const minFrameGap = fps > 0 ? 1_000_000 / fps : 0;
  let lastOutTs = -Infinity;
  let encodedCount = 0;
  let chain: Promise<void> = Promise.resolve();

  const encodeFrame = async (frame: VideoFrame) => {
    if (signal.aborted) { frame.close(); return; }
    const ts = frame.timestamp;
    if (minFrameGap > 0 && ts - lastOutTs < minFrameGap - 500) {
      frame.close();
      return;
    }
    lastOutTs = ts;
    let toEncode: VideoFrame = frame;
    if (frame.displayWidth !== outW || frame.displayHeight !== outH) {
      const canvas = new OffscreenCanvas(outW, outH);
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) { frame.close(); throw toolError('ENCODE_FAILED', '无法创建 2D 画布'); }
      ctx.drawImage(frame, 0, 0, outW, outH);
      toEncode = new VideoFrame(canvas, { timestamp: ts, duration: frame.duration ?? undefined });
      frame.close();
    }
    while (!signal.aborted && (encoder?.encodeQueueSize ?? 0) > 8) await sleep0();
    if (signal.aborted) { toEncode.close(); return; }
    try { encoder?.encode(toEncode); } finally { toEncode.close(); }
    encodedCount += 1;
    opts.onProgress({
      done: encodedCount,
      total: extracted.videoSamples.length,
      phase: 'encoding',
      unit: 'frames',
    });
    if (encodedCount % 2 === 0) await sleep0();
  };

  try {
    decoder = new VideoDecoder({
      output: (frame) => {
        chain = chain.then(() => encodeFrame(frame)).catch((e) => {
          backgroundError ??= e;
        });
      },
      error: (e) => { backgroundError ??= toolError('DECODE_FAILED', '视频解码失败', String(e)); },
    });
    decoder.configure({
      codec: extracted.video.codec,
      codedWidth: srcW,
      codedHeight: srcH,
      description: extracted.videoDescription,
      hardwareAcceleration: 'no-preference',
    });

    encoder = new VideoEncoder({
      output: (chunk, meta) => muxer!.addVideoChunk(chunk, meta),
      error: (e) => { backgroundError ??= toolError('ENCODE_FAILED', '视频编码失败', String(e)); },
    });
    encoder.configure(encoderConfig);

    for (let i = 0; i < extracted.videoSamples.length; i += 1) {
      if (signal.aborted || backgroundError) break;
      const s = extracted.videoSamples[i]!;
      const { timestamp, duration } = sampleUs(s);
      decoder.decode(new EncodedVideoChunk({
        type: s.isKey ? 'key' : 'delta',
        timestamp,
        duration,
        data: s.data,
      }));
      if (i % 16 === 15) await sleep0();
    }
    signal.throwIfAborted();
    if (backgroundError) throw backgroundError;
    await waitForVideoStep(decoder.flush(), signal);
    await waitForVideoStep(chain, signal);
    if (backgroundError) throw backgroundError;
    await waitForVideoStep(encoder.flush(), signal);
    signal.throwIfAborted();
    if (backgroundError) throw backgroundError;

    // AAC 码流透传：mp4-muxer 会从采样率/声道数生成 AudioSpecificConfig。
    if (keepAudio && addAudio) {
      for (const s of extracted.audioSamples) {
        const { timestamp, duration } = sampleUs(s);
        addAudio(new EncodedAudioChunk({ type: 'key', timestamp, duration, data: s.data }));
      }
    }

    opts.onProgress({ done: 1, total: 1, phase: 'finalizing', unit: 'percent' });
    signal.throwIfAborted();
    muxer.finalize();
    const bytes = new Uint8Array(params.container === 'mp4' ? mp4Target.buffer : webmTarget.buffer);
    const ratio = fileBytes > 0 ? (fileBytes - bytes.length) / fileBytes : 0;
    return {
      bytes,
      outputName: `video-${Date.now()}.${params.container}`,
      meta: {
        outFormat: params.container,
        outWidth: outW,
        outHeight: outH,
        inputBytes: fileBytes,
        outputBytes: bytes.length,
        outputHash: shortHash(bytes),
        savingsRatio: ratio,
        savingsText: `${(ratio * 100).toFixed(1)}% ${ratio >= 0 ? '节省' : '增大'}`,
      },
    };
  } finally {
    try { decoder?.close(); } catch { /* 已关闭 */ }
    try { encoder?.close(); } catch { /* 已关闭 */ }
  }
}

export interface VideoBackendLike {
  probe(input: InputRef): Promise<VideoProbeResult>;
  run(input: InputRef, params: VideoTranscodeParams, opts: RunOptions): Promise<TaskResult>;
}

const singleton: VideoBackendLike = {
  probe: (input) => {
    if (!input.file) throw toolError('IO', '视频探测需要浏览器文件对象');
    return probe(input.file);
  },
  run: (input, params, opts) => {
    if (!input.file) throw toolError('IO', '视频转码需要浏览器文件对象');
    if (opts.signal.aborted) return Promise.reject(toolError('CANCELLED', '任务已取消'));
    return transcode(input.file, params, opts);
  },
};

export function getVideoBackend(): VideoBackendLike {
  return singleton;
}
