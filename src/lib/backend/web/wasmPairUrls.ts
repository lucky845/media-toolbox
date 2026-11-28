declare const __MT_WASM_VERSIONS__: Readonly<Record<'image' | 'doc', string>> | undefined;

/** Glue and binary share a content-addressed directory in production. */
export function wasmPairUrls(kind: 'image' | 'doc'): { glue: string; wasm: string } {
  const base = import.meta.env.BASE_URL || '/';
  const version = typeof __MT_WASM_VERSIONS__ === 'undefined' ? '' : __MT_WASM_VERSIONS__?.[kind];
  const dir = `${base.endsWith('/') ? base : `${base}/`}wasm/${version ? `${version}/` : ''}`;
  return { glue: `${dir}core_${kind}.js`, wasm: `${dir}core_${kind}_bg.wasm` };
}
