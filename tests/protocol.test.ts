import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  isTerminal,
  validateFromWorker,
  type FromWorker,
} from '../src/workers/protocol';

describe('Worker 协议不变量（docs/CONTRACTS.md §6）', () => {
  it('终止消息判定只认 done/error/cancelled', () => {
    const mk = (type: string): FromWorker =>
      ({ v: PROTOCOL_VERSION, type, taskId: 't-1' }) as unknown as FromWorker;
    expect(isTerminal(mk('done'))).toBe(true);
    expect(isTerminal(mk('error'))).toBe(true);
    expect(isTerminal(mk('cancelled'))).toBe(true);
    expect(isTerminal(mk('progress'))).toBe(false);
    expect(isTerminal(mk('probed'))).toBe(false);
    expect(isTerminal(mk('log'))).toBe(false);
  });

  it('版本不匹配必须被拒绝', () => {
    const errs = validateFromWorker({ v: 2, type: 'ready' });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]).toContain('协议版本');
  });

  it('ready 必须带 version 与 limits', () => {
    expect(validateFromWorker({ v: 1, type: 'ready' })).toContainEqual(
      expect.stringContaining('version'),
    );
    const ok = validateFromWorker({
      v: 1,
      type: 'ready',
      contractVersion: 1,
      version: '0.1.0',
      limits: {},
      loadPath: 'streaming',
    });
    expect(ok).toEqual([]);
  });

  it('done 必须携带 ArrayBuffer（否则 transfer 契约被破坏）', () => {
    const errs = validateFromWorker({
      v: 1,
      type: 'done',
      taskId: 't-1',
      output: 'not-a-buffer',
      meta: {},
    });
    expect(errs).toContainEqual(expect.stringContaining('ArrayBuffer'));

    const ok = validateFromWorker({
      v: 1,
      type: 'done',
      taskId: 't-1',
      output: new ArrayBuffer(8),
      meta: {},
    });
    expect(ok).toEqual([]);
  });

  it('progress 必须带 taskId 与负载', () => {
    expect(validateFromWorker({ v: 1, type: 'progress', p: {} })).toContainEqual(
      expect.stringContaining('taskId'),
    );
    const ok = validateFromWorker({
      v: 1,
      type: 'progress',
      taskId: 't-1',
      p: { done: 1, total: 2, phase: 'decoding', unit: 'percent' },
    });
    expect(ok).toEqual([]);
  });

  it('未知 type 被拒绝', () => {
    const errs = validateFromWorker({ v: 1, type: 'bogus' });
    expect(errs).toContainEqual(expect.stringContaining('未知 type'));
  });

  it('非对象输入不崩溃', () => {
    expect(validateFromWorker(null)).toEqual(['消息不是对象']);
    expect(validateFromWorker('x')).toEqual(['消息不是对象']);
  });
});
