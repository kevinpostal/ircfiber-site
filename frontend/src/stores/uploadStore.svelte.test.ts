import { describe, it, expect, beforeEach } from 'vitest';
import { uploadState, trackUpload, setProgress, finishUpload, failUpload, removeUpload, aggregateProgress, ringState } from './uploadStore.svelte';

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
});
