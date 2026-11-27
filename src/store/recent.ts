import type { ErrorCode } from '../lib/backend/types';
import { useSettings } from './settings';

const DB_NAME = 'media-toolbox';
const STORE = 'recent';
const MAX_ITEMS = 100;
const MAX_BYTES = 512 * 1024;
const listeners = new Set<() => void>();

export interface RecentTask {
  id: string;
  createdAt: number;
  kind: string;
  fileNames: string[];
  params: unknown;
  paramsHash: string;
  outcome: 'succeeded' | 'failed' | 'cancelled';
  inputBytes?: number;
  outputBytes?: number;
  errorCode?: ErrorCode;
}

export function onRecentChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, useStore: (store: IDBObjectStore) => T): Promise<T> {
  const db = await openDB();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      tx.onabort = () => reject(tx.error);
      const result = useStore(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(result);
    });
  } finally {
    db.close();
  }
}

function sizeOf(task: RecentTask): number {
  return new Blob([JSON.stringify(task)]).size;
}

export async function recordTask(task: RecentTask): Promise<void> {
  if (!useSettings.getState().recordHistory || sizeOf(task) > MAX_BYTES / 4) return;
  try {
    await withStore('readwrite', (store) => {
      if (!useSettings.getState().recordHistory) return;
      store.put(task);
      const all = store.getAll();
      all.onsuccess = () => {
        const records = (all.result as RecentTask[]).sort((a, b) => b.createdAt - a.createdAt);
        let bytes = 0;
        records.forEach((record, index) => {
          bytes += sizeOf(record);
          if (index >= MAX_ITEMS || bytes > MAX_BYTES) store.delete(record.id);
        });
      };
    });
    listeners.forEach((listener) => listener());
  } catch {
    // Processing remains available when IndexedDB is unavailable.
  }
}

export async function listTasks(): Promise<RecentTask[]> {
  try {
    const request = await withStore('readonly', (store) => store.getAll());
    return (request.result as RecentTask[]).sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_ITEMS);
  } catch {
    return [];
  }
}

async function mutateHistory(mutate: (store: IDBObjectStore) => void): Promise<void> {
  await withStore('readwrite', mutate);
  listeners.forEach((listener) => listener());
}

export const deleteTask = (id: string) => mutateHistory((store) => { store.delete(id); });
export const clearTasks = () => mutateHistory((store) => { store.clear(); });
