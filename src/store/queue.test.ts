import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskPayload, TaskResult } from '../lib/backend/types';
import { useQueue } from './queue';

const task: TaskPayload = {
  kind: 'image.process',
  input: { name: 'test.png', size: 1 },
  params: { rotate: 'none', flip: 'none', applyExifOrientation: true, background: { r: 255, g: 255, b: 255, a: 255 } },
  encode: { format: 'png', quality: 100, lossless: false, keepMetadata: false, pngOptimize: false },
};

const result: TaskResult = {
  bytes: new Uint8Array([1]),
  outputName: 'test.png',
  meta: {
    outFormat: 'png', outWidth: 1, outHeight: 1, inputBytes: 1, outputBytes: 1,
    outputHash: '', savingsRatio: 0, savingsText: '0%',
  },
};

const reset = () => {
  const state = useQueue.getState();
  state.setPaused(false);
  state.clearFinished();
  for (const item of useQueue.getState().items) state.cancel(item.id);
  state.clearFinished();
};

afterEach(reset);

describe('task queue recovery', () => {
  it('retries a failed task with its runner', async () => {
    let attempts = 0;
    const runner = async () => {
      attempts++;
      if (attempts === 1) throw { code: 'INTERNAL', message: 'failed', retryable: true, desktopHint: false };
      return result;
    };

    const promise = useQueue.getState().submit(task, undefined, runner);
    const item = useQueue.getState().items[0]!;
    await expect(promise).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(useQueue.getState().items[0]?.status).toBe('failed');

    useQueue.getState().retry(item.id);
    await vi.waitFor(() => expect(useQueue.getState().items[0]?.status).toBe('succeeded'));
    expect(attempts).toBe(2);
  });

  it('keeps queued work idle while paused and starts it on resume', async () => {
    useQueue.getState().setPaused(true);
    let started = false;
    useQueue.getState().submit(task, undefined, async () => {
      started = true;
      return result;
    }).catch(() => undefined);

    expect(started).toBe(false);
    expect(useQueue.getState().items[0]?.status).toBe('queued');
    useQueue.getState().setPaused(false);
    await vi.waitFor(() => expect(useQueue.getState().items[0]?.status).toBe('succeeded'));
    expect(started).toBe(true);
  });
});
