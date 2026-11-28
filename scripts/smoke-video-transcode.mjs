// Run against a built Web preview server. Requires Chrome, ffprobe, and FFmpeg with libx264.
// Set PLAYWRIGHT_CHANNEL to use another Chrome-compatible channel.
// Usage: npm run smoke:video -- [base URL]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const base = (process.argv[2] ?? 'http://localhost:4173').replace(/\/$/, '');
const ff = (cmd, args) => execFileSync(cmd, ['-v', 'error', ...args], { encoding: 'utf8' });
const probe = (file) => JSON.parse(ff('ffprobe', ['-count_frames', '-show_streams', '-show_format', '-of', 'json', file]));
const stream = (probeResult, type) => probeResult.streams.find((s) => s.codec_type === type);
const audioHashes = (file) => JSON.parse(ff('ffprobe', [
  '-select_streams', 'a:0', '-show_packets', '-show_data_hash', 'sha256',
  '-show_entries', 'packet=data_hash', '-of', 'json', file,
])).packets.map((packet) => packet.data_hash);
const presentationTimes = (file) => JSON.parse(ff('ffprobe', [
  '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', file,
])).frames.map((frame) => Number(frame.best_effort_timestamp_time));

const dir = await mkdtemp(join(tmpdir(), 'media-toolbox-video-smoke-'));
let browser;
try {
  const input = join(dir, 'bframes-aac.mp4');
  ff('ffmpeg', [
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=48000:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-bf', '2', '-x264-params', 'b-adapt=0',
    '-c:a', 'aac', '-movflags', '+faststart', input,
  ]);
  const source = probe(input);
  const sourceVideo = stream(source, 'video');
  assert(sourceVideo?.has_b_frames > 0, 'Fixture must exercise video decode/presentation reordering');
  assert.equal(stream(source, 'audio')?.codec_name, 'aac');
  const sourceTimes = presentationTimes(input);
  const sourceAudio = audioHashes(input);
  assert(sourceAudio.length > 0 && sourceAudio.every(Boolean), 'Fixture must carry AAC packets');

  // Branded Chrome allows H.264 even where the bundled Chromium lacks it.
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome' });
  const page = await browser.newPage({ acceptDownloads: true });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    // Native save dialogs cannot be used headlessly; exercise the download fallback.
    Object.defineProperty(globalThis, 'showSaveFilePicker', { value: undefined, configurable: true });
  });
  try {
    await page.goto(base + '/#/video');
    await page.locator('.dropzone:not([disabled])').waitFor({ timeout: 20_000 });
    const fileInput = page.locator('input[type=file]');
    await fileInput.setInputFiles({
      name: 'missing-moov.mp4',
      mimeType: 'video/mp4',
      // A valid ftyp box without a movie box.
      buffer: Buffer.from('000000186674797069736f6d0000020069736f6d6d703431', 'hex'),
    });
    await page.getByText('MP4 解析失败', { exact: true }).waitFor({ timeout: 5_000 });
    assert(await page.getByRole('button', { name: '开始转码' }).isDisabled());
    await fileInput.setInputFiles(input);
    await page.getByText('320 × 180', { exact: true }).waitFor({ timeout: 10_000 });
    const run = page.getByRole('button', { name: '开始转码' });
    for (const { label, container, keepAudio, codecs, audioCodec, scale = 100, fps = 0 } of [
      { label: 'mp4-aac', container: 'mp4', keepAudio: true, codecs: ['h264'], audioCodec: 'aac' },
      { label: 'mp4-muted', container: 'mp4', keepAudio: false, codecs: ['h264'] },
      { label: 'webm', container: 'webm', keepAudio: true, codecs: ['vp9', 'vp8'] },
      { label: 'mp4-scaled-20fps', container: 'mp4', keepAudio: false, codecs: ['h264'], scale: 50, fps: 20 },
    ]) {
      await page.getByLabel('输出容器').selectOption(container);
      await page.getByRole('checkbox', { name: /保留音轨/ }).setChecked(keepAudio);
      await page.getByLabel('尺寸缩放（%）').fill(String(scale));
      await page.getByLabel('帧率（0=源帧率）').fill(String(fps));
      const [outcome] = await Promise.all([
        Promise.race([
          page.waitForEvent('download', { timeout: 30_000 }),
          page.locator('.notice.danger').first().waitFor({ timeout: 30_000 }).then(async () => {
            throw new Error(label + ': ' + await page.locator('.notice.danger').first().innerText());
          }),
        ]),
        run.click({ timeout: 10_000 }),
      ]);
      assert(outcome.suggestedFilename().endsWith('.' + container));
      const output = join(dir, label + '.' + container);
      await outcome.saveAs(output);
      const actual = probe(output);
      const video = stream(actual, 'video');
      assert(actual.format.format_name.split(',').includes(container), label + ': wrong container');
      assert(codecs.includes(video?.codec_name), label + ': wrong video codec (' + video?.codec_name + ')');
      assert.equal(video.width, sourceVideo.width * scale / 100, label + ': wrong width');
      assert.equal(video.height, sourceVideo.height * scale / 100, label + ': wrong height');
      const expectedTimes = fps
        ? Array.from({ length: 2 * fps }, (_, i) => i / fps)
        : sourceTimes.map((time) => time - sourceTimes[0]);
      assert.equal(Number(video.nb_read_frames), expectedTimes.length, label + ': decoded frame count');
      const times = presentationTimes(output);
      assert.equal(times.length, expectedTimes.length, label + ': timestamp count');
      // WebM rounds microsecond timestamps to millisecond timecodes.
      assert(times.every((time, i) => Math.abs(time - times[0] - expectedTimes[i]) <= 0.002),
        label + ': wrong decoded presentation cadence');
      assert(Math.abs(Number(actual.format.duration) - Number(source.format.duration)) <= 2 / 24,
        label + ': wrong duration (' + actual.format.duration + 's)');
      assert.deepEqual(actual.streams.filter((s) => s.codec_type === 'audio').map((s) => s.codec_name),
        audioCodec ? [audioCodec] : [], label + ': unexpected audio tracks');
      if (audioCodec) {
        // MP4 may omit the priming packet; all remaining AAC payloads must match in order.
        const hashes = audioHashes(output);
        assert(hashes.length >= sourceAudio.length - 1, label + ': AAC packets lost');
        assert.deepEqual(hashes, sourceAudio.slice(sourceAudio.length - hashes.length), label + ': AAC must be copied');
      }
      ff('ffmpeg', ['-xerror', '-i', output, '-f', 'null', '-']);
      console.log(label + ': ' + video.nb_read_frames + ' ' + video.codec_name + ' frames, ' +
        actual.format.duration + 's, ' + (audioCodec ?? 'no audio'));
    }
    assert.deepEqual(errors, [], 'Unexpected browser page errors');
  } catch (error) {
    console.error('Browser diagnostics:', { errors, page: await page.locator('body').innerText({ timeout: 2000 }).catch(() => '') });
    throw error;
  }
} finally {
  await browser?.close();
  await rm(dir, { recursive: true, force: true });
}
