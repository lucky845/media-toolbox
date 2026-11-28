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
 * 性能：解码/编码由浏览器内部线程完成；限制解码积压和编码队列，
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
  duration: number;
  timescale: number;
  data: Uint8Array;
  isKey: boolean;
}

interface ParsedMp4 {
  buffer: MP4Box.MP4BoxBuffer;
  movie: MP4Box.Movie;
  video: MP4Box.Track;
  audio?: MP4Box.Track;
}

interface Demuxed {
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
  if (!/\.mp4$/i.test(file.name) && file.type !== 'video/mp4') {
    throw toolError(
      'UNSUPPORTED_FORMAT',
      '在线版只能读取 MP4 文件',
      'mp4box.js 仅解封装 ISOBMFF；MKV/MOV/HEVC 请用桌面版。',
      true,
    );
  }
  const read = file.arrayBuffer();
  const buffer = (await (signal ? waitForVideoStep(read, signal) : read)) as MP4Box.MP4BoxBuffer;
  signal?.throwIfAborted();
  buffer.fileStart = 0;
  const mp4 = MP4Box.createFile();
  let movie: MP4Box.Movie | undefined;
  let parseError: string | undefined;
  mp4.onReady = (info) => { movie = info; };
  mp4.onError = (_module, message) => { parseError = message; };
  try {
    mp4.appendBuffer(buffer);
    mp4.flush();
  } catch (error) {
    throw toolError('DECODE_FAILED', 'MP4 解析失败', String(error), true);
  }
  if (parseError) throw toolError('DECODE_FAILED', 'MP4 解析失败', parseError, true);
  if (!movie) {
    throw toolError('DECODE_FAILED', 'MP4 解析失败', '文件缺少完整的视频容器元数据。', true);
  }
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
  return { buffer, movie, video, audio: movie.audioTracks[0] };
}

/** MP4Box 同步处理完整缓冲区，在 appendBuffer/flush 期间分批交付压缩样本。 */
function extractSamples(parsed: ParsedMp4, keepAudio: boolean): Demuxed {
  const { buffer, video } = parsed;
  const audio = keepAudio ? parsed.audio : undefined;
  const videoSamples: RawSample[] = [];
  const audioSamples: RawSample[] = [];
  // 元数据探测会丢弃已读取的媒体数据。重新解析并在读取期间收集样本。
  const extractor = MP4Box.createFile();
  let extractionError: string | undefined;
  extractor.onError = (_module, message) => { extractionError = message; };
  extractor.onSamples = (id, _user, samples) => {
    const dest = id === video.id ? videoSamples : id === audio?.id ? audioSamples : null;
    if (!dest) return;
    for (const s of samples) {
      if (!s.data) continue;
      dest.push({
        cts: s.cts,
        duration: s.duration,
        timescale: s.timescale,
        // MP4Box allocates a separate buffer per sample; keep that buffer, not a copy.
        data: s.data,
        isKey: s.is_sync === true,
      });
    }
  };
  extractor.onReady = () => {
    extractor.setExtractionOptions(video.id, null, { nbSamples: Math.max(1, video.nb_samples || 1) });
    if (audio) extractor.setExtractionOptions(audio.id, null, { nbSamples: Math.max(1, audio.nb_samples || 1) });
    extractor.start();
  };
  try {
    extractor.appendBuffer(buffer);
    extractor.flush();
  } catch (error) {
    throw toolError('DECODE_FAILED', '视频样本提取失败', String(error), true);
  } finally {
    extractor.stop();
  }
  if (extractionError) throw toolError('DECODE_FAILED', '视频样本提取失败', extractionError, true);
  if (!videoSamples.length) {
    throw toolError('DECODE_FAILED', '视频轨为空', 'MP4 中没有可提取的视频样本。', true);
  }
  if (videoSamples.length < video.nb_samples || (audio && audioSamples.length < audio.nb_samples)) {
    throw toolError('DECODE_FAILED', '视频样本提取失败', '文件缺少轨道声明的媒体样本。', true);
  }
  return { videoDescription: avcDescription(extractor, video.id, buffer), videoSamples, audioSamples };
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
  const requestedFps = Math.min(60, Math.max(0, Math.round(params.fps)));
  const targetFps = requestedFps > 0 && requestedFps < srcFps ? requestedFps : 0;
  const outputFps = targetFps || srcFps || 30;
  const bitrateMbps = Math.min(12, Math.max(0.4, params.bitrateMbps));
  const bitrate = Math.round(bitrateMbps * 1_000_000);

  const keepAudio = params.container === 'mp4' && params.keepAudio && Boolean(decoded.audio) &&
    AUDIO_PASSTHROUGH_CODECS.has(decoded.audio?.codec ?? '');

  const { codec: encoderCodec, config: encoderConfig } = await waitForVideoStep(
    chooseEncoder(params.container, outW, outH, outputFps, bitrate, signal), signal,
  );
  signal.throwIfAborted();
  opts.onLog?.({ level: 'info', message: `编码器：${encoderCodec}，${outW}×${outH}，${bitrateMbps} Mbps`, at: Date.now() });
  if (params.container === 'webm' && decoded.audio) {
    opts.onLog?.({ level: 'warn', message: 'WebM 输出需要 Opus 音轨，在线版不重编码音频，将输出无音轨视频。', at: Date.now() });
  } else if (params.keepAudio && decoded.audio && !keepAudio) {
    opts.onLog?.({ level: 'warn', message: '源音轨格式无法直接透传，将输出无音轨视频。', at: Date.now() });
  }

  const mp4Target = new Mp4Target();
  const webmTarget = new WebmTarget();
  let muxer: AnyMuxer;
  let addAudio: ((chunk: EncodedAudioChunk) => void) | undefined;
  if (params.container === 'mp4') {
    const m = new Mp4Muxer({
      target: mp4Target,
      video: { codec: 'avc', width: outW, height: outH, frameRate: outputFps },
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
        frameRate: outputFps,
      },
      firstTimestampBehavior: 'offset',
    });
  }

  opts.onProgress({ done: 0, total: 1, phase: 'decoding', unit: 'frames' });
  signal.throwIfAborted();
  const extracted = extractSamples(decoded, keepAudio);

  let decoder: VideoDecoder | undefined;
  let encoder: VideoEncoder | undefined;
  let failure: unknown;
  const frames: VideoFrame[] = [];
  let draining: Promise<void> | undefined;
  const queueLimit = 8;
  const closeCodecs = () => {
    if (decoder && decoder.state !== 'closed') decoder.close();
    if (encoder && encoder.state !== 'closed') encoder.close();
  };
  const disposeFrames = () => {
    for (const frame of frames) frame.close();
    frames.length = 0;
  };
  const fail = (error: unknown) => {
    failure ??= error;
    disposeFrames();
    closeCodecs();
  };
  const checkFailure = () => {
    if (failure) throw failure;
  };
  const onAbort = () => fail(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });

  let firstFrameTime: number | undefined;
  let lastFrameSlot = -1;
  let processedCount = 0;
  let canvas: OffscreenCanvas | undefined;

  const encodeFrame = (frame: VideoFrame) => {
    let outputFrame: VideoFrame | undefined;
    try {
      firstFrameTime ??= frame.timestamp;
      let timestamp = frame.timestamp;
      let duration = frame.duration ?? undefined;
      if (targetFps) {
        // Pick one frame per output interval relative to the first frame.
        // One microsecond of tolerance handles integer WebCodecs timestamps.
        const slot = Math.floor((timestamp - firstFrameTime + 1) * targetFps / 1_000_000);
        if (slot === lastFrameSlot) return;
        const start = Math.round(slot * 1_000_000 / targetFps);
        timestamp = firstFrameTime + start;
        duration = Math.round((slot + 1) * 1_000_000 / targetFps) - start;
        lastFrameSlot = slot;
      }
      if (frame.displayWidth !== outW || frame.displayHeight !== outH) {
        canvas ??= new OffscreenCanvas(outW, outH);
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) throw toolError('ENCODE_FAILED', '无法创建 2D 画布');
        ctx.drawImage(frame, 0, 0, outW, outH);
        outputFrame = new VideoFrame(canvas, { timestamp, duration });
      } else if (targetFps) {
        outputFrame = new VideoFrame(frame, { timestamp, duration });
      }
      encoder!.encode(outputFrame ?? frame);
    } finally {
      outputFrame?.close();
      frame.close();
    }
  };

  const drainFrames = async () => {
    while (frames.length && !failure) {
      if (encoder!.encodeQueueSize >= queueLimit) {
        await sleep0();
      } else {
        encodeFrame(frames.shift()!);
        opts.onProgress({
          done: ++processedCount,
          total: extracted.videoSamples.length,
          phase: 'encoding',
          unit: 'frames',
        });
      }
    }
  };

  try {
    decoder = new VideoDecoder({
      output: (frame) => {
        if (failure) { frame.close(); return; }
        frames.push(frame);
        draining ??= Promise.resolve().then(drainFrames).catch(fail).finally(() => { draining = undefined; });
      },
      error: (e) => fail(toolError('DECODE_FAILED', '视频解码失败', String(e))),
    });
    decoder.configure({
      codec: decoded.video.codec,
      codedWidth: srcW,
      codedHeight: srcH,
      description: extracted.videoDescription,
      hardwareAcceleration: 'no-preference',
    });

    encoder = new VideoEncoder({
      output: (chunk, meta) => {
        if (failure) return;
        try { muxer.addVideoChunk(chunk, meta); } catch (error) { fail(error); }
      },
      error: (e) => fail(toolError('ENCODE_FAILED', '视频编码失败', String(e))),
    });
    encoder.configure(encoderConfig);

    // Limit submitted decode work as well as the decoded backlog. Do not flush
    // between batches: the decoder needs to retain reference/reordered frames.
    for (let i = 0; i < extracted.videoSamples.length; i += 1) {
      while (!failure && (decoder.decodeQueueSize + frames.length >= queueLimit ||
        encoder.encodeQueueSize >= queueLimit)) await sleep0();
      checkFailure();
      const s = extracted.videoSamples[i]!;
      const { timestamp, duration } = sampleUs(s);
      decoder.decode(new EncodedVideoChunk({
        type: s.isKey ? 'key' : 'delta',
        timestamp,
        duration,
        data: s.data,
      }));
    }
    const flush = async (codec: VideoDecoder | VideoEncoder) => {
      try { await codec.flush(); } catch (error) { fail(error); }
      checkFailure();
    };
    await flush(decoder);
    await draining;
    checkFailure();
    await flush(encoder);
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
    signal.removeEventListener('abort', onAbort);
    disposeFrames();
    closeCodecs();
    await draining;
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
