import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebBackend } from './webBackend';

class FakeWorker extends EventTarget {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  postMessage(message: unknown) {
    const data = message as { type: string };
    if (data.type === 'init') {
      queueMicrotask(() => {
        this.onmessage?.({ data: { type: 'ready', limits: { maxPixels: 20_000_000, maxBytes: 1024, maxBatch: 50, maxDurationSec: 300, maxPages: 100, maxMemoryBytes: 1, maxConcurrent: 2, isRestricted: true }, loadPath: 'test' } } as MessageEvent);
      });
    }
  }
  terminate() { this.terminated = true; }
}

const originalWorker = globalThis.Worker;
Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis });
let worker: FakeWorker;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: originalWorker });
});

function backend() {
  worker = new FakeWorker();
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: class { constructor() { return worker; } } });
  return new WebBackend();
}

describe('WebBackend worker lifecycle', () => {
  it('rejects pending probe and task when worker crashes', async () => {
    const b = backend();
    const probe = b.probe({ name: 'a.png', size: 1, file: new File([new Uint8Array([1])], 'a.png') });
    await vi.waitFor(() => expect(worker.onmessage).not.toBeNull());
    // init ready gets delivered in a microtask; let probe register after init.
    await vi.waitFor(() => expect((b as unknown as { probes: Map<string, unknown> }).probes.size).toBe(1));
    const task = b.run({ kind: 'image.process', input: { name: 'a.png', size: 1, file: new File([new Uint8Array([1])], 'a.png') }, params: {}, encode: {} } as never, { taskId: 'task-1', signal: new AbortController().signal, onProgress: () => {} } as never);
    await vi.waitFor(() => expect((b as unknown as { pending: Map<string, unknown> }).pending.size).toBe(1));
    worker.onerror?.({ message: 'boom' } as ErrorEvent);
    await expect(probe).rejects.toMatchObject({ message: 'Worker 异常退出' });
    await expect(task).rejects.toMatchObject({ message: 'Worker 异常退出' });
    expect((b as unknown as { probes: Map<string, unknown> }).probes.size).toBe(0);
  });

  it('rejects probe and task when disposed', async () => {
    const b = backend();
    const probe = b.probe({ name: 'a.png', size: 1, file: new File([new Uint8Array([1])], 'a.png') });
    await vi.waitFor(() => expect((b as unknown as { probes: Map<string, unknown> }).probes.size).toBe(1));
    const task = b.run({ kind: 'image.process', input: { name: 'a.png', size: 1, file: new File([new Uint8Array([1])], 'a.png') }, params: {}, encode: {} } as never, { taskId: 'task-1', signal: new AbortController().signal, onProgress: () => {} } as never);
    await vi.waitFor(() => expect((b as unknown as { pending: Map<string, unknown> }).pending.size).toBe(1));
    b.dispose();
    await expect(probe).rejects.toMatchObject({ message: '后端已释放' });
    await expect(task).rejects.toMatchObject({ message: '后端已释放' });
  });
});
