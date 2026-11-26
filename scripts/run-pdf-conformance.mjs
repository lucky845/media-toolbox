// PDF 双端一致性测试：native 与 wasm 跑同一操作，输出必须逐字节相等（blake3 相同）。
// 用法：node scripts/run-pdf-conformance.mjs

import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const work = await mkdtemp(join(tmpdir(), 'mt-pdfconformance-'));
const log = (...a) => console.error(...a);
const nativeBin = join(repo, 'target/release/examples/pdf_conformance');
const fixture = join(repo, 'tests/fixtures/sample.pdf');

if (!existsSync(nativeBin)) {
  log('缺少 native PDF 一致性程序。先执行：cargo build --release -p media-native --example pdf_conformance');
  process.exit(2);
}

const run = (cmd, args) => execFileSync(cmd, args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const cases = [
  { name: 'pdf.rotate.90', op: { op: 'rotate', degrees: 90, ranges: [{ from: 1, toInclusive: 3 }] } },
  { name: 'pdf.split', op: { op: 'split', ranges: [{ from: 1, toInclusive: 2 }, { from: 3, toInclusive: 3 }] } },
  { name: 'pdf.merge.self', op: { op: 'merge', inputs: [join(repo, 'tests/fixtures/sample.pdf')] } },
];

let pass = 0;
for (const c of cases) {
  const opPath = join(work, `${c.name}.json`);
  await writeFile(opPath, JSON.stringify(c.op));
  const nOut = join(work, `${c.name}.native.pdf`);
  const wOut = join(work, `${c.name}.wasm.pdf`);
  const n = JSON.parse(run(nativeBin, [fixture, opPath, nOut]).trim().split('\n').pop());
  const w = JSON.parse(run('node', ['scripts/wasm-pdf-harness.mjs', fixture, opPath, wOut]).trim().split('\n').pop());
  const ok = n.hash === w.hash && n.outputBytes === w.outputBytes;
  log(`${ok ? '✓' : '✗'} ${c.name}: native=${n.outputBytes}B/${n.hash.slice(0, 12)} wasm=${w.outputBytes}B/${w.hash.slice(0, 12)}`);
  if (ok) pass += 1;
}
console.log(JSON.stringify({ pass, total: cases.length, allPass: pass === cases.length }, null, 2));
process.exit(pass === cases.length ? 0 : 1);
