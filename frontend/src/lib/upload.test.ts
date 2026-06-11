import { describe, it, expect } from 'vitest';
import {
  MAX_UPLOAD_BYTES, MAX_UPLOAD_BATCH, isUploadableImage, validateFile,
  dataURIToBlob, joinMessageLink, flattenFileList, sizeToString,
} from './upload';

describe('isUploadableImage', () => {
  it('accepts image mime types', () => {
    expect(isUploadableImage('image/png')).toBe(true);
    expect(isUploadableImage('image/webp')).toBe(true);
  });
  it('rejects non-images', () => {
    expect(isUploadableImage('video/mp4')).toBe(false);
    expect(isUploadableImage('application/pdf')).toBe(false);
    expect(isUploadableImage('')).toBe(false);
  });
});

describe('validateFile', () => {
  it('returns null for an acceptable image', () => {
    expect(validateFile({ name: 'a.png', type: 'image/png', size: 1000 })).toBeNull();
  });
  it('rejects oversize and non-image files with reasons', () => {
    expect(validateFile({ name: 'a.png', type: 'image/png', size: MAX_UPLOAD_BYTES + 1 }))
      .toMatch(/too large/i);
    expect(validateFile({ name: 'a.mp4', type: 'video/mp4', size: 10 }))
      .toMatch(/only images/i);
  });
});

describe('dataURIToBlob', () => {
  it('decodes a base64 data URI into a Blob with the right type', () => {
    const blob = dataURIToBlob('data:image/png;base64,aGVsbG8=');
    expect(blob).not.toBeNull();
    expect(blob!.type).toBe('image/png');
    expect(blob!.size).toBe(5);
  });
  it('returns null for non-data-URI strings', () => {
    expect(dataURIToBlob('https://example.com/x.png')).toBeNull();
    expect(dataURIToBlob('data:image/png;base64,!!!notbase64')).toBeNull();
  });
});

describe('joinMessageLink', () => {
  it('joins message and url with a single space', () => {
    expect(joinMessageLink('look', 'https://u')).toBe('look https://u');
    expect(joinMessageLink('look ', 'https://u')).toBe('look https://u');
    expect(joinMessageLink('', 'https://u')).toBe('https://u');
  });
});

describe('flattenFileList', () => {
  const f = (name: string, size = 10, type = 'image/png') => ({ name, size, type });
  it('filters blacklisted and empty files and caps the batch', () => {
    const files = [f('.DS_Store'), f('a.png'), f('empty.png', 0), ...Array.from({ length: 15 }, (_, i) => f(`x${i}.png`))];
    const { accepted, truncated } = flattenFileList(files as unknown as File[]);
    expect(accepted.map(x => x.name)).not.toContain('.DS_Store');
    expect(accepted.map(x => x.name)).not.toContain('empty.png');
    expect(accepted.length).toBe(MAX_UPLOAD_BATCH);
    expect(truncated).toBe(true);
  });
});

describe('sizeToString', () => {
  it('formats bytes, KB, MB', () => {
    expect(sizeToString(500)).toBe('500 B');
    expect(sizeToString(1500)).toBe('2 KB');
    expect(sizeToString(1_500_000)).toBe('1.5 MB');
  });
});
