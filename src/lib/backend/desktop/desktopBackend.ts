// 桌面后端：Tauri invoke + listen。
//
// 与 Web 后端的差异**只在这里**：
//  - 输入是文件路径（不读进 JS），输出写文件（不经过 JS 内存）
//  - 进度走 Tauri event（100ms 一次，节流在 Rust 侧）
//  - 取消是硬取消（信号 + 进程树），所以 cancel.hard === true
//
// 这个文件通过动态 import 加载，不会进 Web 首屏包。

import type { UnlistenFn } from '@tauri-apps/api/event';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';

import type {
  Backend,
  Capabilities,
  ImageResultMeta,
  InputRef,
  Limits,
  LogEntry,
  Progress,
  RunOptions,
  TaskPayload,
  TaskResult,
  ToolError,
} from '../types';

interface DesktopProgressEvent {
  taskId: string;
  done: number;
  total: number;
  phase: Progress['phase'];
  unit: Progress['unit'];
  speed?: number;
  etaSec?: number;
}

interface DesktopLogEvent {
  taskId: string;
  level: LogEntry['level'];
  message: string;
}

export class DesktopBackend implements Backend {
  readonly kind = 'desktop' as const;

  private capsCache: Capabilities | null = null;
  private limitsCache: Limits | null = null;
  private unlisteners: UnlistenFn[] = [];
  private running = new Map<string, AbortController>();
  private listenersAttached = false;

  private async attachListeners(): Promise<void> {
    if (this.listenersAttached) return;
    this.listenersAttached = true;
    this.unlisteners.push(
      await listen<DesktopProgressEvent>('task://progress', (ev) => {
        this.progressHandlers.get(ev.payload.taskId)?.({
          done: ev.payload.done,
          total: ev.payload.total,
          phase: ev.payload.phase,
          unit: ev.payload.unit,
        });
      }),
      await listen<DesktopLogEvent>('task://log', (ev) => {
        this.logHandlers.get(ev.payload.taskId)?.({
          level: ev.payload.level,
          message: ev.payload.message,
          at: Date.now(),
        });
      }),
    );
  }

  private progressHandlers = new Map<string, (p: Progress) => void>();
  private logHandlers = new Map<string, (e: LogEntry) => void>();

  async capabilities(): Promise<Capabilities> {
    if (this.capsCache) return this.capsCache;
    await this.attachListeners();
    const caps = await invoke<Capabilities>('probe_capabilities');
    this.capsCache = caps;
    return caps;
  }

  async limits(): Promise<Limits> {
    if (this.limitsCache) return this.limitsCache;
    const caps = await this.capabilities();
    // 桌面阈值来自 capabilities 里的 image.maxPixels 等（同一份 Rust 常量）
    // 这里构造一个与 Web 同形状的 Limits，避免 UI 两套代码
    const l: Limits = {
      maxPixels: Number.MAX_SAFE_INTEGER,
      maxBytes: caps.video.maxBytes > 0 ? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER,
      maxBatch: Number.MAX_SAFE_INTEGER,
      maxDurationSec: Number.MAX_SAFE_INTEGER,
      maxPages: Number.MAX_SAFE_INTEGER,
      maxMemoryBytes: 0,
      maxConcurrent: 4,
      isRestricted: false,
    };
    this.limitsCache = l;
    return l;
  }

  async run(task: TaskPayload, opts: RunOptions): Promise<TaskResult> {
    await this.attachListeners();
    const ac = new AbortController();
    this.running.set(opts.taskId, ac);
    this.progressHandlers.set(opts.taskId, opts.onProgress);
    if (opts.onLog) this.logHandlers.set(opts.taskId, opts.onLog);

    const onAbort = () => {
      void invoke('cancel_task', { taskId: opts.taskId });
    };
    opts.signal.addEventListener('abort', onAbort, { once: true });

    try {
      if (task.kind === 'image.process') {
        // 桌面：路径进、路径出。中间的字节不进 JS。
        if (!task.input.path) {
          throw {
            code: 'INVALID_PARAMS',
            message: '桌面端需要文件路径',
            retryable: false,
            desktopHint: false,
          } satisfies ToolError;
        }
        // 输出路径由 Rust 决定（同目录 + 命名规则），前端只拿回结果元数据
        const r = await invoke<{
          outputPath: string;
          meta: ImageResultMeta;
          outputBytes: number;
        }>('image_process', {
          inputPath: task.input.path,
          params: task.params,
          encode: task.encode,
          taskId: opts.taskId,
        });

        // 读取结果字节用于预览（仅预览，不用于写盘）
        const bytes = await invoke<number[]>('read_output_preview', { path: r.outputPath });
        return {
          bytes: new Uint8Array(bytes),
          meta: r.meta,
          outputName: r.outputPath.split(/[\\/]/).pop() ?? 'output',
        };
      }

      throw {
        code: 'UNSUPPORTED_FORMAT',
        message: `当前版本暂不支持 ${task.kind}`,
        retryable: false,
        desktopHint: false,
      } satisfies ToolError;
    } finally {
      this.progressHandlers.delete(opts.taskId);
      this.logHandlers.delete(opts.taskId);
      this.running.delete(opts.taskId);
    }
  }

  cancel(taskId: string): void {
    this.running.get(taskId)?.abort();
    // 同时通知后端（即使 AbortController 已触发，也确保 Rust 侧收到）
    void invoke('cancel_task', { taskId });
  }

  async pickFiles(accept: string, multiple: boolean): Promise<InputRef[]> {
    const exts = accept
      .split(',')
      .map((s) => s.trim().replace(/^\./, ''))
      .filter(Boolean);
    const picked = await openDialog({
      multiple,
      filters: exts.length ? [{ name: '支持的文件', extensions: exts }] : undefined,
    });
    if (!picked) return [];
    const paths = Array.isArray(picked) ? picked : [picked];
    return paths.map((p) => ({
      path: p,
      name: p.split(/[\\/]/).pop() ?? p,
      size: 0, // 大小由 Rust 侧探测后回填
    }));
  }

  async saveOutput(bytes: Uint8Array, name: string): Promise<'downloaded' | 'saved' | 'cancelled'> {
    const target = await saveDialog({ defaultPath: name });
    if (!target) return 'cancelled';
    await invoke('write_output_file', { path: target, data: Array.from(bytes) });
    return 'saved';
  }

  dispose(): void {
    for (const u of this.unlisteners) u();
    this.unlisteners = [];
    this.listenersAttached = false;
    this.progressHandlers.clear();
    this.logHandlers.clear();
    this.running.clear();
  }
}
