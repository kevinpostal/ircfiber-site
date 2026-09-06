import { describe, it, expect, beforeEach } from 'vitest';
import { uploadState, trackUpload, setProgress, setConverting, finishUpload, failUpload, removeUpload, aggregateProgress, ringState } from './uploadStore.svelte';

beforeEach(() => { uploadState.active = []; uploadState.dialog = null; });

describe('uploadStore', () => {
  it('tracks uploads and aggregates progress', () => {
    const a = trackUpload('a.png', 100);
    const b = trackUpload('b.png', 100);
    setProgress(a.id, 50);
    setProgress(b.id, 100);
    expect(aggregateProgress()).toBe(75);
  });

  it('ringState reflects lifecycle: active -> finalizing -> success, then idle after removal', () => {
    const a = trackUpload('a.png', 100);
    expect(ringState()).toBe('active');
    setProgress(a.id, 100);
    expect(ringState()).toBe('finalizing');
    finishUpload(a.id, { id: 'x', url: 'https://u', pageUrl: 'p', name: 'a.png', size: 100 });
    expect(ringState()).toBe('success');
    removeUpload(a.id);
    expect(ringState()).toBe('idle');
  });

  it('any error makes ringState error', () => {
    const a = trackUpload('a.png', 100);
    failUpload(a.id, 'boom');
    expect(ringState()).toBe('error');
    expect(uploadState.active[0].error).toBe('boom');
  });

  it('setConverting clamps progress and ringState reports converting, but error still wins', () => {
    const a = trackUpload('clip.mp4', 100);
    setConverting(a.id, 42);
    expect(uploadState.active[0].status).toBe('converting');
    expect(uploadState.active[0].progress).toBe(42);
    expect(ringState()).toBe('converting');
    setConverting(a.id, 140);
    expect(uploadState.active[0].progress).toBe(100);
    setConverting(a.id, -5);
    expect(uploadState.active[0].progress).toBe(0);
    const b = trackUpload('b.png', 100);
    failUpload(b.id, 'boom');
    expect(ringState()).toBe('error');
  });
});
