import type { ErrorCode } from '../lib/backend/types';
import { canRecordHistory } from './settings';

const DB_NAME = 'media-toolbox';
const STORE = 'recent';
const MAX_ITEMS = 100;
const MAX_BYTES = 512 * 1024;
const CHANGE_KEY = 'media-toolbox-recent-change';
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

function notifyListeners() {
  listeners.forEach((listener) => listener());
}

function publishChange() {
  try {
    // Only an opaque invalidation signal crosses tabs, never task metadata.
    localStorage.setItem(CHANGE_KEY, globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36));
  } catch {
    // The current tab can still refresh when localStorage is unavailable.
  }
  notifyListeners();
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === CHANGE_KEY && event.storageArea === window.localStorage) notifyListeners();
  });
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
  if (!canRecordHistory()) return;
  try {
    if (sizeOf(task) > MAX_BYTES / 4) return;
    let wrote = false;
    await withStore('readwrite', (store) => {
      // The transaction can be queued behind another tab. Check when it is active,
      // not just while opening the database or listening for storage events.
      const ready = store.getKey(task.id);
      ready.onsuccess = () => {
        if (!canRecordHistory()) return;
        store.put(task);
        wrote = true;
        const all = store.getAll();
        all.onsuccess = () => {
          const records = (all.result as RecentTask[]).sort((a, b) => b.createdAt - a.createdAt);
          let bytes = 0;
          records.forEach((record, index) => {
            bytes += sizeOf(record);
            if (index >= MAX_ITEMS || bytes > MAX_BYTES) store.delete(record.id);
          });
        };
      };
    });
    if (wrote) publishChange();
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
  publishChange();
}

export const deleteTask = (id: string) => mutateHistory((store) => { store.delete(id); });
export const clearTasks = () => mutateHistory((store) => { store.clear(); });
