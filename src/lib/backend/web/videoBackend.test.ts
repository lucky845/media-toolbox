import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunOptions, VideoTranscodeParams } from '../types';
import { getVideoBackend } from './videoBackend';

const params: VideoTranscodeParams = {
  container: 'mp4', bitrateMbps: 2, scalePercent: 100, fps: 0, keepAudio: false,
};

function run(file: File, controller: AbortController, onProgress: RunOptions['onProgress'] = vi.fn()) {
  return getVideoBackend().run({ file, name: file.name, size: file.size }, params, {
    signal: controller.signal, taskId: 'video-test', onProgress,
  });
}

function pendingInput() {
  const file = new File([], 'pending.mp4');
  vi.spyOn(file, 'arrayBuffer').mockImplementation(() => new Promise(() => {}));
  return file;
}

describe('Web video interruption', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('enforces the 120s deadline even when reading the file stalls', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const result = run(pendingInput(), controller);
    const check = expect(result).rejects.toMatchObject({ code: 'TIMEOUT', desktopHint: true });
    await vi.advanceTimersByTimeAsync(120_000);
    await check;
    expect(controller.signal.aborted).toBe(false);
  });

  it('reports active cancellation during file read independently of the deadline', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const result = run(pendingInput(), controller);
    const check = expect(result).rejects.toMatchObject({ code: 'CANCELLED' });
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await check;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains TIMEOUT when closing the codecs rejects an in-flight flush', async () => {
    vi.useFakeTimers();
    let flushStarted = false;
    let rejectFlush: ((error: Error) => void) | undefined;
    const closeDecoder = vi.fn(() => rejectFlush?.(new Error('closed during flush')));
    const closeEncoder = vi.fn();
    vi.stubGlobal('EncodedVideoChunk', class {});
    vi.stubGlobal('VideoDecoder', class {
      configure() {}
      decode() {}
      flush() {
        flushStarted = true;
        return new Promise<void>((_, reject) => { rejectFlush = reject; });
      }
      close = closeDecoder;
    });
    vi.stubGlobal('VideoEncoder', class {
      static async isConfigSupported() { return { supported: true }; }
      configure() {}
      close = closeEncoder;
    });
    const file = new File([new Uint8Array(readFileSync('tests/fixtures/sample.mp4'))], 'sample.mp4');
    const result = run(file, new AbortController());
    const check = expect(result).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(119_999);
    expect(flushStarted).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await check;
    expect(closeDecoder).toHaveBeenCalled();
    expect(closeEncoder).toHaveBeenCalled();
  });
});
