import { describe, expect, it } from 'vitest';
import type { ImageMeta } from '../../lib/backend/types';
import { buildParams, canvasError, defaultForm, normalizeImageSection } from './form';

const meta: ImageMeta = {
  width: 400,
  height: 200,
  format: 'png',
  hasAlpha: true,
  exifOrientation: 1,
  bytes: 1000,
  peakMemoryEstimate: 0,
};

describe('image form sections', () => {
  it('normalizes route slugs and defaults unknown groups to combination', () => {
    expect(normalizeImageSection()).toBe('all');
    expect(normalizeImageSection('compress')).toBe('compress');
    expect(normalizeImageSection('not-a-group')).toBe('all');
  });

  it('isolates group parameters and composes all image operations', () => {
    const form = defaultForm('nearest');
    Object.assign(form, {
      scalePercent: 50,
      cropEnabled: true,
      cropPct: { x: 25, y: 0, w: 50, h: 100 },
      rotate: 'cw90',
      flip: 'h',
      canvasEnabled: true,
      canvasWidth: '300',
      canvasHeight: '300',
      canvasColor: '#123456',
      adjust: { brightness: 1.5, contrast: 1, saturation: 1 },
    });

    const transform = buildParams(form, meta, 'transform');
    expect(transform.crop).toEqual({ x: 100, y: 0, width: 200, height: 200 });
    expect(transform.rotate).toBe('cw90');
    expect(transform.resize?.width).toBe(100);
    expect(transform.adjust).toBeNull();
    expect(transform.canvas).toBeNull();

    const fill = buildParams(form, meta, 'fill');
    expect(fill.resize).toBeNull();
    expect(fill.rotate).toBe('none');
    expect(fill.crop).toBeNull();
    expect(fill.canvas).toEqual({
      width: 300,
      height: 300,
      background: { r: 18, g: 52, b: 86, a: 255 },
    });

    const compress = buildParams(form, meta, 'compress');
    expect(compress.resize).toBeNull();
    expect(compress.adjust).toBeNull();
    expect(compress.canvas).toBeNull();

    const all = buildParams(form, meta, 'all');
    expect(all.crop).not.toBeNull();
    expect(all.resize?.width).toBe(100);
    expect(all.adjust?.brightness).toBe(1.5);
    expect(all.canvas?.width).toBe(300);
  });

  it('validates enabled canvas dimensions and pixel cap', () => {
    const form = defaultForm('nearest');
    form.canvasEnabled = true;
    form.canvasWidth = '100';
    form.canvasHeight = '50';
    expect(canvasError(form, 5000)).toBeNull();
    expect(canvasError(form, 4999)).toContain('像素上限');
    form.canvasWidth = '0';
    expect(canvasError(form)).toContain('整数');
    form.canvasEnabled = false;
    expect(canvasError(form)).toBeNull();
  });
});
