// Worker 池（规格 §13：Web 端 Worker 池 1–2）。
//
// 当前 WebBackend 的实现是「一个 worker，取消时 terminate 重建」。
// 本模块提供并发上限与调度能力，让批量队列不会一次创建 N 个 worker 打爆浏览器。
//
// 设计选择：**池大小 = min(2, hardwareConcurrency - 1)**，且至少 1。
// 为什么不做任务内并行：wasm 单线程（Pages 无 SharedArrayBuffer），
// 任务内并行无法实现；池只提供「任务级」并发。

import { PROTOCOL_VERSION, type FromWorker, type ToWorker } from '../../../workers/protocol';

export interface PoolOptions {
  size?: number;
  workerFactory: () => Worker;
  onMessage: (m: FromWorker) => void;
  onError?: (e: Error) => void;
}

/** 根据硬件并发数给出建议池大小 */
export function suggestedPoolSize(): number {
  const hc = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
  return Math.max(1, Math.min(2, hc - 1));
}

/** 简单任务级 worker 池：每个 worker 同时只跑一个任务 */
export class WorkerPool {
  private workers: Worker[] = [];
  private busy = new Set<Worker>();
  private queue: Array<() => void> = [];
  private size: number;
  private factory: () => Worker;
  private onMessage: (m: FromWorker) => void;
  private onError?: (e: Error) => void;
  private disposed = false;

  constructor(opts: PoolOptions) {
    this.size = Math.max(1, opts.size ?? suggestedPoolSize());
    this.factory = opts.workerFactory;
    this.onMessage = opts.onMessage;
    this.onError = opts.onError;

    for (let i = 0; i < this.size; i++) this.workers.push(this.createWorker());
  }

  private createWorker(): Worker {
    const w = this.factory();
    w.onmessage = (ev: MessageEvent<FromWorker>) => this.onMessage(ev.data);
    w.onerror = (ev) => {
      this.onError?.(new Error(ev.message || 'Worker 异常'));
      this.busy.delete(w);
      this.pump();
    };
    return w;
  }

  private pump(): void {
    if (this.disposed) return;
    while (this.busy.size < this.size && this.queue.length > 0) {
      const job = this.queue.shift()!;
      job();
    }
  }

  /** 取一个空闲 worker 发消息；没有则排队 */
  post(msg: ToWorker, transfer: Transferable[] = []): void {
    if (this.disposed) return;
    const job = () => {
      const w = [...this.workers].find((candidate) => !this.busy.has(candidate));
      if (!w) return;
      this.busy.add(w);
      w.postMessage(msg, transfer);
    };
    if (this.busy.size >= this.size) this.queue.push(job);
    else job();
  }

  /** 任务结束，释放 worker（由 WebBackend 在收到终态消息时调用） */
  release(_taskId: string): void {
    // 简化：收到终态消息时标记所有 worker 空闲（单任务模型下是安全的）
    this.busy.clear();
    this.pump();
  }

  /** 终止并重建指定 worker（硬取消） */
  terminateAll(): void {
    for (const w of this.workers) w.terminate();
    this.workers = this.workers.map(() => this.createWorker());
    this.busy.clear();
    this.pump();
  }

  dispose(): void {
    this.disposed = true;
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.queue = [];
    this.busy.clear();
  }

  get poolSize(): number {
    return this.size;
  }

  get idleCount(): number {
    return this.size - this.busy.size;
  }
}

void PROTOCOL_VERSION;
