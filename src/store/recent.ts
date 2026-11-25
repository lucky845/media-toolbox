// 最近任务持久化（规格 §通用功能）。
// **只存文件名与参数，不存文件内容、不存路径**（桌面端也只在用户开启时存目录）。
// 容量：≤100 条 / ≤512 KB，写入前检查大小。

import type { ErrorCode } from '../lib/backend/types';

const DB_NAME = 'media-toolbox';
const STORE = 'recent';
const VERSION = 1;
const MAX_ITEMS = 100;
const MAX_BYTES = 512 * 1024;

export interface RecentTask {
  id: string;
  createdAt: number;
  kind: string;
  fileNames: string[];
  /** 参数快照（不含文件内容） */
  params: unknown;
  paramsHash: string;
  outcome: 'succeeded' | 'failed' | 'cancelled';
  inputBytes?: number;
  outputBytes?: number;
  /** 只存错误码，不存 message（避免把文件名拼进文案后落盘） */
  errorCode?: ErrorCode;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 记录一条任务（完成时调用） */
export async function recordTask(task: RecentTask): Promise<void> {
  try {
    const db = await openDB();
    const payload = JSON.stringify(task);
    if (new Blob([payload]).size > MAX_BYTES / 4) return; // 单条不超过 128 KB

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(task);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    // 淘汰：超出 100 条时删最旧的
    const all = await listTasks();
    if (all.length > MAX_ITEMS) {
      const doomed = all
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, all.length - MAX_ITEMS);
      await Promise.all(doomed.map((t) => deleteTask(t.id)));
    }
    db.close();
  } catch {
    // IndexedDB 不可用（隐私模式等）时静默失败 —— 最近任务只是增强功能
  }
}

export async function listTasks(): Promise<RecentTask[]> {
  try {
    const db = await openDB();
    const result = await new Promise<RecentTask[]>((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as RecentTask[]);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return result.sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_ITEMS);
  } catch {
    return [];
  }
}

export async function deleteTask(id: string): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // 静默失败
  }
}

export async function clearTasks(): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // 静默失败
  }
}
