import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskPayload, TaskResult } from '../lib/backend/types';
import { hasPendingOutputs, useQueue } from './queue';

const { saveOutput } = vi.hoisted(() => ({ saveOutput: vi.fn() }));
vi.mock('../lib/backend', () => ({ getBackend: async () => ({ saveOutput }) }));

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
  for (const item of useQueue.getState().items) {
    state.cancel(item.id);
    state.remove(item.id);
  }
  saveOutput.mockReset();
};

afterEach(reset);

describe('task queue recovery', () => {
  it('limits concurrent image jobs while allowing other media to run', async () => {
    useQueue.getState().setConcurrency(2);
    let finishFirst!: (value: TaskResult) => void;
    let finishPdf!: (value: TaskResult) => void;
    const firstGate = new Promise<TaskResult>((resolve) => { finishFirst = resolve; });
    const pdfGate = new Promise<TaskResult>((resolve) => { finishPdf = resolve; });
    const first = useQueue.getState().submit(task, undefined, async () => firstGate);
    const pdfTask: TaskPayload = { kind: 'pdf.merge', inputs: [] };
    const pdf = useQueue.getState().submit(pdfTask, undefined, async () => pdfGate);
    expect(useQueue.getState().items.filter((item) => item.status === 'running')).toHaveLength(2);
    finishFirst(result);
    finishPdf(result);
    await Promise.all([first, pdf]);
  });

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

describe('queue output protection', () => {
  const current = () => useQueue.getState().items[0]!;

  it('protects partially saved outputs, tracks actual outcomes, and clears only after both saves', async () => {
    const queue = useQueue.getState();
    await queue.submit(task, undefined, async () => ({
      ...result,
      outputs: [{ name: 'same.png', bytes: result.bytes }, { name: 'same.png', bytes: result.bytes }],
    }));
    const { id } = current();
    queue.clearFinished(task.kind);
    expect(current().id).toBe(id);

    saveOutput.mockResolvedValueOnce('cancelled').mockResolvedValueOnce('saved').mockResolvedValueOnce('downloaded');
    await expect(queue.saveOutput(id, 0)).resolves.toBe('cancelled');
    expect(current().outputSaveStates).toBeUndefined();
    await expect(queue.saveOutput(id, 0)).resolves.toBe('saved');
    queue.clearFinished();
    expect(current().outputSaveStates).toEqual({ 0: 'saved' });
    expect(hasPendingOutputs(current())).toBe(true);
    await expect(queue.saveOutput(id, 1)).resolves.toBe('downloaded');
    expect(current().outputSaveStates).toEqual({ 0: 'saved', 1: 'downloaded' });
    queue.clearFinished();
    expect(current()).toBeUndefined();
  });

  it('retains a result on save errors and blocks removal during an in-flight save', async () => {
    const queue = useQueue.getState();
    await queue.submit(task, undefined, async () => result);
    const { id } = current();
    const error = new Error('not written');
    saveOutput.mockRejectedValueOnce(error);
    const saving = queue.saveOutput(id, 0);
    expect(queue.remove(id)).toBe(false);
    queue.clearFinished();
    expect(current().id).toBe(id);
    await expect(saving).rejects.toBe(error);
    expect(hasPendingOutputs(current())).toBe(true);
    expect(queue.remove(id)).toBe(true);
  });

  it('treats nonempty backend-written paths as saved', async () => {
    const queue = useQueue.getState();
    await queue.submit(task, undefined, async () => ({ ...result, savedOutputs: [{ name: 'test.png', path: '/out/test.png', bytes: 1 }] }));
    expect(hasPendingOutputs(current())).toBe(false);
    queue.clearFinished();
    expect(current()).toBeUndefined();
  });

  it('does not restart tasks with a non-retryable error', async () => {
    const queue = useQueue.getState();
    const runner = vi.fn().mockRejectedValue({ code: 'INTERNAL', message: 'stop', retryable: false, desktopHint: false });
    await expect(queue.submit(task, undefined, runner)).rejects.toMatchObject({ retryable: false });
    queue.retry(current().id);
    expect(current()).toMatchObject({ status: 'failed', attempt: 0 });
    expect(runner).toHaveBeenCalledTimes(1);
  });
});
