import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'media-toolbox-settings';
const CHANGE_KEY = 'media-toolbox-recent-change';
const task = {
  id: 'test', createdAt: 1, kind: 'image.process', fileNames: ['private.png'],
  params: null, paramsHash: '', outcome: 'succeeded' as const,
};

function setupStorage() {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
  const window = Object.assign(new EventTarget(), { localStorage: storage });
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', window);
  return {
    storage,
    change(key: string, newValue?: string) {
      window.dispatchEvent(Object.assign(new Event('storage'), { key, newValue, storageArea: storage }));
    },
    set(recordHistory: boolean) {
      storage.setItem(KEY, JSON.stringify({ version: 1, state: { recordHistory } }));
    },
  };
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('cross-tab history privacy', () => {
  it('re-reads the current setting even if a storage event carries an older value', async () => {
    const browser = setupStorage();
    const { useSettings, canRecordHistory } = await import('./settings');
    expect(useSettings.getState().recordHistory).toBe(true);
    browser.set(false);
    expect(canRecordHistory()).toBe(false);
    browser.change(KEY, JSON.stringify({ version: 1, state: { recordHistory: true } }));
    expect(useSettings.getState().recordHistory).toBe(false);
    browser.set(true);
    browser.change(KEY);
    expect(useSettings.getState().recordHistory).toBe(true);
  });

  it('does not overwrite a newer privacy setting when updating a different preference', async () => {
    const browser = setupStorage();
    const { useSettings, canRecordHistory } = await import('./settings');
    browser.set(false);
    useSettings.getState().setQuality(97);
    expect(useSettings.getState()).toMatchObject({ quality: 97, recordHistory: false });
    expect(canRecordHistory()).toBe(false);
    expect(JSON.parse(browser.storage.getItem(KEY)!).state.recordHistory).toBe(false);
  });

  it('skips opening IndexedDB before cross-tab synchronization when latest consent is off', async () => {
    const browser = setupStorage();
    const open = vi.fn();
    vi.stubGlobal('indexedDB', { open });
    const { recordTask } = await import('./recent');
    browser.set(false);
    await recordTask(task);
    expect(open).not.toHaveBeenCalled();
  });

  it('rechecks consent after waiting for the IndexedDB transaction', async () => {
    const browser = setupStorage();
    const ready = { onsuccess: () => {} };
    const put = vi.fn();
    const store = { getKey: vi.fn(() => ready), put };
    const tx = { objectStore: () => store, oncomplete: () => {} };
    const request = { result: { transaction: () => tx, close: vi.fn() }, onsuccess: () => {} };
    vi.stubGlobal('indexedDB', { open: () => request });
    const { recordTask } = await import('./recent');
    const write = recordTask(task);
    request.onsuccess();
    await Promise.resolve();
    expect(store.getKey).toHaveBeenCalledWith(task.id);
    browser.set(false);
    ready.onsuccess();
    tx.oncomplete();
    await write;
    expect(put).not.toHaveBeenCalled();
    expect(browser.storage.getItem(CHANGE_KEY)).toBeNull();
  });

  it('publishes only an opaque change signal after a committed deletion', async () => {
    const browser = setupStorage();
    const store = { delete: vi.fn() };
    const tx = { objectStore: () => store, oncomplete: () => {} };
    const request = { result: { transaction: () => tx, close: vi.fn() }, onsuccess: () => {} };
    vi.stubGlobal('indexedDB', { open: () => request });
    const { deleteTask, onRecentChange } = await import('./recent');
    const listener = vi.fn();
    const unsubscribe = onRecentChange(listener);
    const deletion = deleteTask(task.id);
    request.onsuccess();
    await Promise.resolve();
    expect(store.delete).toHaveBeenCalledWith(task.id);
    expect(listener).not.toHaveBeenCalled();
    tx.oncomplete();
    await deletion;
    expect(browser.storage.getItem(CHANGE_KEY)).toBeTruthy();
    expect(browser.storage.getItem(CHANGE_KEY)).not.toContain(task.fileNames[0]);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('refreshes listeners after another tab signals a mutation', async () => {
    const browser = setupStorage();
    const { onRecentChange } = await import('./recent');
    const listener = vi.fn();
    const unsubscribe = onRecentChange(listener);
    browser.change(CHANGE_KEY, 'opaque');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    browser.change(CHANGE_KEY, 'next');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
