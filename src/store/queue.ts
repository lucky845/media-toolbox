import { create } from 'zustand';
import { getBackend } from '../lib/backend';
import type { EncodeOptions, ImageParams, InputRef, Progress, RunOptions, TaskPayload, TaskResult, ToolError } from '../lib/backend/types';
import { fallbackMessage, isToolError } from '../lib/errors';
import { recordTask } from './recent';

export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
type Runner = (task: TaskPayload, options: RunOptions) => Promise<TaskResult>;
type Observer = Partial<Pick<RunOptions, 'signal' | 'onProgress'>>;

export interface QueueItem {
  id: string;
  task: TaskPayload;
  status: TaskStatus;
  progress: Progress | null;
  result?: TaskResult;
  outputBytes?: Uint8Array;
  outputName?: string;
  error?: ToolError;
  attempt: number;
}

interface QueueState {
  items: QueueItem[];
  paused: boolean;
  concurrency: number;
  enqueue: (input: InputRef, params: ImageParams, encode: EncodeOptions) => string;
  submit: (task: TaskPayload, observer?: Observer, runner?: Runner) => Promise<TaskResult>;
  cancel: (id: string) => void;
  retry: (id: string) => void;
  remove: (id: string) => void;
  setPaused: (paused: boolean) => void;
  setConcurrency: (concurrency: number) => void;
  clearFinished: (kind?: TaskPayload['kind']) => void;
}

interface Job {
  runner?: Runner;
  observer?: Observer;
  resolve?: (result: TaskResult) => void;
  reject?: (error: ToolError) => void;
  detach?: () => void;
  controller?: AbortController;
}

export const TASK_LABELS: Record<TaskPayload['kind'], string> = {
  'image.process': '图片处理',
  'video.transcode': '视频转码',
  'pdf.render': 'PDF 渲染图片',
  'pdf.merge': 'PDF 合并',
  'pdf.split': 'PDF 拆分',
  'pdf.rotate': 'PDF 旋转',
  'pdf.reorder': 'PDF 页面重排',
  'pdf.encrypt': 'PDF 加密',
  'pdf.decrypt': 'PDF 解密',
  'pdf.extract': 'PDF 提取',
  'office.structure': '文档结构化转换',
  'office.convert': '文档转换',
};

export function taskInputs(task: TaskPayload): InputRef[] {
  return task.kind === 'pdf.merge' ? task.inputs : [task.input];
}

export function isActive(item: QueueItem): boolean {
  return item.status === 'queued' || item.status === 'running';
}

export function canRetryTask(task: TaskPayload) {
  return task.kind !== 'pdf.encrypt' && task.kind !== 'pdf.decrypt';
}

const cancelled: ToolError = { code: 'CANCELLED', message: '任务已取消', retryable: true, desktopHint: false };

function storedConcurrency(): number {
  try {
    const value = Number(localStorage.getItem('media-toolbox-queue-concurrency'));
    return value === 2 ? 2 : 1;
  } catch {
    return 1;
  }
}

export const useQueue = create<QueueState>((set, get) => {
  const jobs = new Map<string, Job>();
  let counter = 0;
  const session = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);

  function update(id: string, changes: Partial<QueueItem>) {
    set((state) => ({ items: state.items.map((item) => item.id === id ? { ...item, ...changes } : item) }));
  }

  function finish(item: QueueItem, outcome: 'succeeded' | 'failed' | 'cancelled', result?: TaskResult, error?: ToolError) {
    const job = jobs.get(item.id);
    if (!job) return;
    // Release the slot and detach page callbacks before publishing the terminal state.
    job.detach?.();
    if (outcome === 'succeeded' || !canRetryTask(item.task)) jobs.delete(item.id);
    else jobs.set(item.id, { runner: job.runner });
    update(item.id, {
      status: outcome,
      result,
      outputBytes: result?.bytes,
      outputName: result?.outputName,
      error: outcome === 'failed' ? error : undefined,
    });
    void recordTask({
      id: item.id,
      createdAt: Date.now(),
      kind: item.task.kind,
      fileNames: taskInputs(item.task).map((input) => input.name),
      params: null,
      paramsHash: '',
      outcome,
      inputBytes: result?.meta.inputBytes,
      outputBytes: result?.meta.outputBytes,
      errorCode: outcome === 'failed' ? error?.code : undefined,
    });
    if (result) job.resolve?.(result);
    if (error) job.reject?.(error);
    pump();
  }

  async function start(item: QueueItem) {
    const job = jobs.get(item.id)!;
    const controller = new AbortController();
    job.controller = controller;
    update(item.id, { status: 'running' });
    const options: RunOptions = {
      taskId: `${item.id}-${item.attempt}`,
      signal: controller.signal,
      onProgress: (progress) => {
        if (controller.signal.aborted || jobs.get(item.id) !== job) return;
        update(item.id, { progress });
        job.observer?.onProgress?.(progress);
      },
    };
    try {
      const result = job.runner
        ? await job.runner(item.task, options)
        : await (await getBackend()).run(item.task, options);
      if (controller.signal.aborted) finish(item, 'cancelled', undefined, cancelled);
      else finish(item, 'succeeded', result);
    } catch (cause) {
      const error: ToolError = isToolError(cause) ? cause : {
        code: 'INTERNAL', message: fallbackMessage('INTERNAL'), retryable: true, desktopHint: false,
      };
      if (controller.signal.aborted || error.code === 'CANCELLED') finish(item, 'cancelled', undefined, cancelled);
      else finish(item, 'failed', undefined, error);
    }
  }

  function pump() {
    const { items, paused, concurrency } = get();
    if (paused) return;
    const slots = Math.max(0, concurrency - items.filter((item) => item.status === 'running').length);
    for (const item of items.filter((entry) => entry.status === 'queued').slice(0, slots)) {
      void start(item);
    }
  }

  function add(task: TaskPayload, job: Job = {}) {
    const id = `${session}-${++counter}`;
    if (task.kind === 'pdf.encrypt' || task.kind === 'pdf.decrypt') {
      const { password, ...publicTask } = task;
      job.runner = async (_, options) => (await getBackend()).run({ ...publicTask, password }, options);
      task = publicTask;
    }
    const item: QueueItem = { id, task, status: 'queued', progress: null, attempt: 0 };
    const signal = job.observer?.signal;
    const abort = () => get().cancel(id);
    if (signal) {
      signal.addEventListener('abort', abort, { once: true });
      job.detach = () => signal.removeEventListener('abort', abort);
    }
    jobs.set(id, job);
    set((state) => ({ items: [...state.items, item] }));
    if (signal?.aborted) abort();
    else pump();
    return id;
  }

  return {
    items: [],
    paused: false,
    concurrency: storedConcurrency(),
    enqueue: (input, params, encode) => add({ kind: 'image.process', input, params, encode }),
    submit: (task, observer, runner) => new Promise((resolve, reject) => {
      add(task, { observer, runner, resolve, reject });
    }),
    cancel: (id) => {
      const item = get().items.find((entry) => entry.id === id);
      if (item?.status === 'queued') finish(item, 'cancelled', undefined, cancelled);
      if (item?.status === 'running') jobs.get(id)?.controller?.abort();
    },
    retry: (id) => {
      const item = get().items.find((entry) => entry.id === id);
      if (!item || !canRetryTask(item.task) || (item.status !== 'failed' && item.status !== 'cancelled') || item.attempt >= 3) return;
      jobs.set(id, { runner: jobs.get(id)?.runner });
      update(id, { status: 'queued', attempt: item.attempt + 1, progress: null, error: undefined });
      pump();
    },
    remove: (id) => {
      const item = get().items.find((entry) => entry.id === id);
      if (!item || isActive(item)) return;
      jobs.delete(id);
      set((state) => ({ items: state.items.filter((entry) => entry.id !== id) }));
    },
    setPaused: (paused) => {
      set({ paused });
      pump();
    },
    setConcurrency: (concurrency) => {
      const value = Math.max(1, Math.min(2, concurrency));
      try {
        localStorage.setItem('media-toolbox-queue-concurrency', String(value));
      } catch {
        // Queue settings still apply for this session when storage is unavailable.
      }
      set({ concurrency: value });
      pump();
    },
    clearFinished: (kind) => {
      const items = get().items.filter((item) => {
        if (isActive(item) || (kind && item.task.kind !== kind)) return true;
        jobs.delete(item.id);
        return false;
      });
      set({ items });
    },
  };
});

export const submitTask: QueueState['submit'] = (...args) => useQueue.getState().submit(...args);
