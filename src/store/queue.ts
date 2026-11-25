// 任务队列与状态机（`docs/CONTRACTS.md` §8）。两端同一份。

import { create } from 'zustand';
import { getBackend } from '../lib/backend';
import { recordTask } from './recent';
import type {
  EncodeOptions,
  ImageParams,
  ImageResultMeta,
  InputRef,
  Progress,
  ToolError,
} from '../lib/backend/types';

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'removed';

export interface QueueItem {
  id: string;
  status: TaskStatus;
  input: InputRef;
  params: ImageParams;
  encode: EncodeOptions;
  progress: Progress | null;
  result?: ImageResultMeta;
  outputBytes?: Uint8Array;
  outputName?: string;
  error?: ToolError;
  attempt: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

interface QueueState {
  items: QueueItem[];
  /** 队列级暂停：不取新任务（running 的不能暂停，只能取消） */
  paused: boolean;
  /** 同时运行的任务数上限，来自 capabilities().limits.maxConcurrent */
  concurrency: number;
  /** 正在运行的 taskId → AbortController */
  controllers: Map<string, AbortController>;

  enqueue: (input: InputRef, params: ImageParams, encode: EncodeOptions) => string;
  enqueueMany: (refs: InputRef[], params: ImageParams, encode: EncodeOptions) => string[];
  start: (id: string) => Promise<void>;
  cancel: (id: string) => void;
  retry: (id: string) => Promise<void>;
  remove: (id: string) => void;
  setPaused: (v: boolean) => void;
  setConcurrency: (n: number) => void;
  clearFinished: () => void;
  /** 队列推进：在有槽位时自动启动下一个 queued */
  pump: () => void;
  runningCount: () => number;
  totalProgress: () => number;
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `t-${Date.now().toString(36)}-${counter}`;
}

export const useQueue = create<QueueState>((set, get) => ({
  items: [],
  paused: false,
  concurrency: 1,
  controllers: new Map(),

  enqueue: (input, params, encode) => {
    const id = nextId();
    const item: QueueItem = {
      id,
      status: 'queued',
      input,
      params,
      encode,
      progress: null,
      attempt: 0,
      createdAt: Date.now(),
    };
    set((s) => ({ items: [...s.items, item] }));
    get().pump();
    return id;
  },

  enqueueMany: (refs, params, encode) => {
    const ids = refs.map((input) => {
      const id = nextId();
      const item: QueueItem = {
        id,
        status: 'queued',
        input,
        params,
        encode,
        progress: null,
        attempt: 0,
        createdAt: Date.now(),
      };
      set((s) => ({ items: [...s.items, item] }));
      return id;
    });
    get().pump();
    return ids;
  },

  start: async (id) => {
    const state = get();
    const item = state.items.find((i) => i.id === id);
    if (!item || item.status !== 'queued') return;

    const ac = new AbortController();
    state.controllers.set(id, ac);

    set((s) => ({
      items: s.items.map((i) =>
        i.id === id ? { ...i, status: 'running', startedAt: Date.now(), error: undefined } : i,
      ),
    }));

    try {
      const backend = await getBackend();
      const result = await backend.run(
        { kind: 'image.process', input: item.input, params: item.params, encode: item.encode },
        {
          taskId: id,
          signal: ac.signal,
          onProgress: (p) => {
            set((s) => ({
              items: s.items.map((i) => (i.id === id ? { ...i, progress: p } : i)),
            }));
          },
        },
      );
      set((s) => ({
        items: s.items.map((i) =>
          i.id === id
            ? {
                ...i,
                status: 'succeeded',
                result: result.meta,
                outputBytes: result.bytes,
                outputName: result.outputName,
                finishedAt: Date.now(),
              }
            : i,
        ),
      }));
      // 最近任务：只存文件名与参数，不存内容
      void recordTask({
        id,
        createdAt: Date.now(),
        kind: 'image.process',
        fileNames: [item.input.name],
        params: item.params,
        paramsHash: result.meta.outputHash,
        outcome: 'succeeded',
        inputBytes: result.meta.inputBytes,
        outputBytes: result.meta.outputBytes,
      });
    } catch (e) {
      const err = e as ToolError;
      const cancelled = err?.code === 'CANCELLED';
      set((s) => ({
        items: s.items.map((i) =>
          i.id === id
            ? {
                ...i,
                status: cancelled ? 'cancelled' : 'failed',
                error: cancelled ? undefined : err,
                finishedAt: Date.now(),
              }
            : i,
        ),
      }));
      void recordTask({
        id,
        createdAt: Date.now(),
        kind: 'image.process',
        fileNames: [item.input.name],
        params: item.params,
        paramsHash: '',
        outcome: cancelled ? 'cancelled' : 'failed',
        errorCode: cancelled ? undefined : (err as ToolError)?.code,
      });
    } finally {
      get().controllers.delete(id);
      // 推进下一个
      get().pump();
    }
  },

  cancel: (id) => {
    const state = get();
    const item = state.items.find((i) => i.id === id);
    if (!item) return;

    if (item.status === 'queued') {
      // 队列中的任务：不需要通知后端，直接标记
      set((s) => ({
        items: s.items.map((i) =>
          i.id === id ? { ...i, status: 'cancelled', finishedAt: Date.now() } : i,
        ),
      }));
      return;
    }
    if (item.status === 'running') {
      state.controllers.get(id)?.abort();
    }
  },

  retry: async (id) => {
    const item = get().items.find((i) => i.id === id);
    if (!item) return;
    if (item.status !== 'failed' && item.status !== 'cancelled') return;
    if (item.attempt >= 3) return;

    set((s) => ({
      items: s.items.map((i) =>
        i.id === id
          ? { ...i, status: 'queued', attempt: i.attempt + 1, progress: null, error: undefined }
          : i,
      ),
    }));
    get().pump();
  },

  remove: (id) => {
    const item = get().items.find((i) => i.id === id);
    if (item?.status === 'running') get().cancel(id);
    set((s) => ({ items: s.items.filter((i) => i.id !== id) }));
  },

  setPaused: (paused) => {
    set({ paused });
    if (!paused) get().pump();
  },

  setConcurrency: (n) => set({ concurrency: Math.max(1, Math.min(4, n)) }),

  clearFinished: () =>
    set((s) => ({
      items: s.items.filter(
        (i) => i.status === 'running' || i.status === 'queued',
      ),
    })),

  pump: () => {
    const state = get();
    if (state.paused) return;
    const running = state.items.filter((i) => i.status === 'running').length;
    const slots = state.concurrency - running;
    if (slots <= 0) return;

    const next = state.items.filter((i) => i.status === 'queued').slice(0, slots);
    for (const item of next) {
      void get().start(item.id);
    }
  },

  runningCount: () => get().items.filter((i) => i.status === 'running').length,

  totalProgress: () => {
    const active = get().items.filter(
      (i) => i.status === 'running' || i.status === 'queued',
    );
    if (active.length === 0) return 0;
    const done = active.filter((i) => i.status !== 'queued');
    if (done.length === 0) return 0;
    const sum = done.reduce((acc, i) => {
      const p = i.progress;
      if (!p || p.total === 0) return acc + 0;
      return acc + p.done / p.total;
    }, 0);
    return sum / active.length;
  },
}));
