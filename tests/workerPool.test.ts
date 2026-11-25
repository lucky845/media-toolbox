import { describe, expect, it, vi } from 'vitest';
import { WorkerPool, suggestedPoolSize } from '../src/lib/backend/web/workerPool';
import { PROTOCOL_VERSION, type FromWorker, type ToWorker } from '../src/workers/protocol';

/** 假 Worker：记录消息与 terminate 次数 */
class FakeWorker {
  static instances: FakeWorker[] = [];
  messages: ToWorker[] = [];
  terminated = false;
  onmessage: ((e: { data: FromWorker }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(m: ToWorker): void {
    this.messages.push(m);
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe('Worker 池', () => {
  it('池大小在 1..2 之间', () => {
    const n = suggestedPoolSize();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(2);
  });

  it('按 pool size 限制并发，超出的任务排队', () => {
    FakeWorker.instances = [];
    const factory = () => new FakeWorker() as unknown as Worker;
    const pool = new WorkerPool({ size: 2, workerFactory: factory, onMessage: vi.fn() });

    const msg = (id: string): ToWorker => ({
      v: PROTOCOL_VERSION,
      type: 'run',
      taskId: id,
      input: new ArrayBuffer(1),
      inputName: `${id}.png`,
      params: {
        rotate: 'none',
        flip: 'none',
        applyExifOrientation: true,
        background: { r: 255, g: 255, b: 255, a: 255 },
      },
      encode: { format: 'png', quality: 80, lossless: true, keepMetadata: false, pngOptimize: false },
    });

    pool.post(msg('t1'));
    pool.post(msg('t2'));
    pool.post(msg('t3')); // 第三个应排队

    expect(pool.idleCount).toBe(0);
    // 两个 worker 各收到一条，第三个尚未投递
    const sent = FakeWorker.instances.reduce((n, w) => n + w.messages.length, 0);
    expect(sent).toBe(2);

    pool.release('t1'); // 释放一个槽位，第三个开始
    const sentAfter = FakeWorker.instances.reduce((n, w) => n + w.messages.length, 0);
    expect(sentAfter).toBe(3);

    pool.dispose();
  });

  it('terminateAll 会重建全部 worker', () => {
    FakeWorker.instances = [];
    const factory = () => new FakeWorker() as unknown as Worker;
    const pool = new WorkerPool({ size: 2, workerFactory: factory, onMessage: vi.fn() });
    const before = [...FakeWorker.instances];
    pool.terminateAll();
    expect(before.every((w) => w.terminated)).toBe(true);
    expect(FakeWorker.instances.length).toBe(4);
    pool.dispose();
  });

  it('dispose 后不再投递消息', () => {
    FakeWorker.instances = [];
    const factory = () => new FakeWorker() as unknown as Worker;
    const pool = new WorkerPool({ size: 1, workerFactory: factory, onMessage: vi.fn() });
    pool.dispose();
    pool.post({ v: PROTOCOL_VERSION, type: 'dispose' });
    expect(FakeWorker.instances[0]!.messages.length).toBe(0);
  });
});
