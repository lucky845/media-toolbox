// CI 闸门：可选的 GPL 组件必须被显式声明（规格 §23）。
//
// 这条检查防的是「有人精简文档时把 GPL 声明删了」——
// 那会让整个站点从「无 GPL 义务」变成「分发 GPL 二进制而未声明」。

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const repo = resolve(import.meta.dirname, '..');
const notices = join(repo, 'THIRD_PARTY_NOTICES.md');

if (!existsSync(notices)) {
  console.error('✗ 缺少 THIRD_PARTY_NOTICES.md');
  process.exit(1);
}

const text = await readFile(notices, 'utf8');
const fails = [];

/** 必须出现的声明 */
const REQUIRED = [
  {
    pattern: /@ffmpeg\/core[\s\S]{0,600}?GPL-2\.0-or-later/,
    why: '@ffmpeg/core 的 GPL-2.0-or-later 声明（可选分包）',
  },
  {
    pattern: /ffmpeg[\s\S]{0,400}?LGPL-2\.1/,
    why: '桌面 FFmpeg 的 LGPL-2.1-or-later 声明',
  },
  {
    pattern: /--enable-gpl/,
    why: '必须写明哪些构建标志会触发 GPL（否则读者无法自行判断）',
  },
  {
    pattern: /--enable-nonfree|libfdk_aac/,
    why: '必须写明 nonfree 构建被禁用',
  },
  { pattern: /LibreOffice[\s\S]{0,300}?MPL-2\.0/, why: 'LibreOffice 的 MPL-2.0 声明' },
  { pattern: /Noto Sans (CJK|SC)[\s\S]{0,300}?OFL/, why: '中文字体的 SIL OFL 1.1 声明' },
  { pattern: /pdf\.js[\s\S]{0,300}?Apache-2\.0/, why: 'pdf.js 的 Apache-2.0 声明' },
];

for (const r of REQUIRED) {
  if (!r.pattern.test(text)) fails.push(r.why);
}

/**
 * 禁止出现的错误表述。
 *
 * 难点：本文件自己会**引用**这些词来说明「不得承诺」。所以不能简单 grep，
 * 必须排除「否定语境」——即同一行里出现「不得 / 禁止 / 不承诺 / 未」时要放过。
 * 这条规则本身也有代价：如果有人写「本工具支持无损转换（不是承诺）」会被放过。
 * 权衡后保留：误报会让维护者关掉检查，漏报则由 review 兜住。
 */
const NEGATION = /不得|禁止|不承诺|未|不要|避免|❌/;

const FORBIDDEN = [
  { pattern: /ffmpeg\.wasm[^\n]{0,80}?MIT/i, why: '不能说 ffmpeg.wasm 的 core 是 MIT（它是 GPL）' },
  { pattern: /(无损|高保真)转换/, why: 'PDF↔Word 不得承诺无损/高保真（规格 §24）' },
];

for (const f of FORBIDDEN) {
  for (const line of text.split('\n')) {
    if (!f.pattern.test(line)) continue;
    if (NEGATION.test(line)) continue; // 否定语境 = 正在说明「不要这样说」
    fails.push(`禁止表述：${f.why} → ${line.trim().slice(0, 60)}`);
  }
}

if (fails.length > 0) {
  console.error('✗ 许可证声明检查失败：');
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('✓ 许可证声明检查通过');
