/** Polyfill the Map upsert helpers used by pdf.js 6.x on older WebKit. */
export function installPdfJsMapCompat(): void {
  const proto = globalThis.Map.prototype as Map<unknown, unknown> & {
    getOrInsertComputed?: (key: unknown, callback: () => unknown) => unknown;
    getOrInsert?: (key: unknown, value: unknown) => unknown;
  };
  if (typeof proto.getOrInsertComputed !== 'function') {
    Object.defineProperty(proto, 'getOrInsertComputed', {
      configurable: true,
      writable: true,
      value(key: unknown, callback: () => unknown) {
        if (this.has(key)) return this.get(key);
        const value = callback();
        this.set(key, value);
        return value;
      },
    });
  }
  if (typeof proto.getOrInsert !== 'function') {
    Object.defineProperty(proto, 'getOrInsert', {
      configurable: true,
      writable: true,
      value(key: unknown, value: unknown) {
        if (this.has(key)) return this.get(key);
        this.set(key, value);
        return value;
      },
    });
  }
  const weakProto = globalThis.WeakMap.prototype as WeakMap<object, unknown> & {
    getOrInsertComputed?: (key: object, callback: () => unknown) => unknown;
    getOrInsert?: (key: object, value: unknown) => unknown;
  };
  if (typeof weakProto.getOrInsertComputed !== 'function') {
    Object.defineProperty(weakProto, 'getOrInsertComputed', {
      configurable: true,
      writable: true,
      value(key: object, callback: () => unknown) {
        if (this.has(key)) return this.get(key);
        const value = callback();
        this.set(key, value);
        return value;
      },
    });
  }
  if (typeof weakProto.getOrInsert !== 'function') {
    Object.defineProperty(weakProto, 'getOrInsert', {
      configurable: true,
      writable: true,
      value(key: object, value: unknown) {
        if (this.has(key)) return this.get(key);
        this.set(key, value);
        return value;
      },
    });
  }
}
