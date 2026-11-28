// Worker 消息协议（`docs/CONTRACTS.md` §6）。主线程与 worker 共用这一份类型。

import type {
  TaskPayload,
  EncodeOptions,
  ImageMeta,
  ImageParams,
  ImageResultMeta,
  Limits,
  Progress,
  ToolError,
} from '../lib/backend/types';

export const PROTOCOL_VERSION = 1 as const;

type WithoutInputRefs<T> = T extends TaskPayload ? Omit<T, 'input' | 'inputs'> : never;
export type DocWorkerPayload = WithoutInputRefs<TaskPayload>;

/** 主线程 → worker */
export type ToWorker =
  | {
      v: typeof PROTOCOL_VERSION;
      type: 'init';
      /** wasm 胶水的 URL（已带 BASE_URL） */
      glueUrl: string;
      /** wasm 二进制 URL */
      wasmUrl: string;
    }
  | {
      v: typeof PROTOCOL_VERSION;
      type: 'probe';
      taskId: string;
      /** 输入字节（transferable） */
      input: ArrayBuffer;
      inputName: string;
    }
  | {
      v: typeof PROTOCOL_VERSION;
      type: 'run';
      taskId: string;
      input: ArrayBuffer;
      inputName: string;
      params: ImageParams;
      encode: EncodeOptions;
    }
  | {
      v: typeof PROTOCOL_VERSION;
      type: 'runDoc';
      taskId: string;
      /** Input bytes in task order, transferred rather than cloned. */
      inputs: ArrayBuffer[];
      payload: DocWorkerPayload;
    }
  | { v: typeof PROTOCOL_VERSION; type: 'cancel'; taskId: string }
  | { v: typeof PROTOCOL_VERSION; type: 'dispose' };

/** worker → 主线程 */
export type FromWorker =
  | {
      v: typeof PROTOCOL_VERSION;
      type: 'ready';
      contractVersion: number;
      version: string;
      limits: Limits;
      /** 加载走了哪条降级路径：streaming / fallback / arraybuffer */
      loadPath: string;
    }
  | { v: typeof PROTOCOL_VERSION; type: 'probed'; taskId: string; meta: ImageMeta }
  | { v: typeof PROTOCOL_VERSION; type: 'progress'; taskId: string; p: Progress }
  | {
      v: typeof PROTOCOL_VERSION;
      type: 'done';
      taskId: string;
      output: ArrayBuffer;
      outputName?: string;
      outputs?: Array<{ name: string; output: ArrayBuffer }>;
      meta: ImageResultMeta;
    }
  | { v: typeof PROTOCOL_VERSION; type: 'cancelled'; taskId: string }
  | { v: typeof PROTOCOL_VERSION; type: 'error'; taskId: string; error: ToolError }
  | {
      v: typeof PROTOCOL_VERSION;
      type: 'log';
      taskId: string;
      level: 'info' | 'warn' | 'error';
      message: string;
    };

/** 判断一条消息是否是终止消息（每个 taskId 至多一条） */
export function isTerminal(m: FromWorker): boolean {
  return m.type === 'done' || m.type === 'error' || m.type === 'cancelled';
}

/** 协议不变量校验（测试用） */
export function validateFromWorker(m: unknown): string[] {
  const errs: string[] = [];
  if (typeof m !== 'object' || m === null) return ['消息不是对象'];
  const o = m as Record<string, unknown>;
  if (o.v !== PROTOCOL_VERSION) errs.push(`协议版本不匹配：${String(o.v)}`);
  if (typeof o.type !== 'string') errs.push('缺少 type');
  switch (o.type) {
    case 'ready':
      if (typeof o.version !== 'string') errs.push('ready 缺少 version');
      if (typeof o.limits !== 'object') errs.push('ready 缺少 limits');
      break;
    case 'probed':
    case 'cancelled':
      if (typeof o.taskId !== 'string') errs.push(`${String(o.type)} 缺少 taskId`);
      break;
    case 'progress':
      if (typeof o.taskId !== 'string') errs.push('progress 缺少 taskId');
      if (typeof o.p !== 'object') errs.push('progress 缺少 p');
      break;
    case 'done':
      if (typeof o.taskId !== 'string') errs.push('done 缺少 taskId');
      if (!(o.output instanceof ArrayBuffer)) errs.push('done 的 output 不是 ArrayBuffer');
      break;
    case 'error':
      if (typeof o.taskId !== 'string') errs.push('error 缺少 taskId');
      if (typeof o.error !== 'object') errs.push('error 缺少 error');
      break;
    case 'log':
      if (typeof o.taskId !== 'string') errs.push('log 缺少 taskId');
      break;
    default:
      errs.push(`未知 type：${String(o.type)}`);
  }
  return errs;
}
