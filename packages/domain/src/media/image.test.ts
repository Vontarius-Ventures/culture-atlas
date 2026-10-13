import { describe, expect, it } from 'vitest';
import { sniffImageType } from './image';

describe('sniffImageType', () => {
  it('identifies accepted formats from magic bytes, not names', () => {
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffImageType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageType(new TextEncoder().encode('\0\0\0\x18ftypheic'))).toBe('image/heic');
    expect(sniffImageType(new TextEncoder().encode('<svg xmlns='))).toBeNull();
  });
});
