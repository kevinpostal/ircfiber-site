import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { convertUploadToGif, type GifJob } from '../stores/api';

interface StubResponse { status: number; body: unknown }

let calls: string[] = [];
let postResponse: StubResponse;
let pollResponses: StubResponse[] = [];
/** Snapshot returned once pollResponses is exhausted (used by the timeout case). */
let pollFallback: StubResponse | null = null;

function running(percent: number, extra: Partial<GifJob> = {}): StubResponse {
  return {
    status: 200,
    body: {
      state: 'running', percent, frame: 10, fps: 18.3, speed: 1.4,
      durationMs: 30000, outTimeMs: 300 * percent, elapsedMs: 1000, etaMs: 5000,
      filename: 'clip.mp4', uploadId: 'u1', startedAt: 1,
      ...extra,
    },
  };
}

const RESULT = {
  id: 'g1', url: 'https://cdn/clip.gif', pageUrl: '/p/g1', name: 'clip.gif',
  mimeType: 'image/gif', size: 123456, createdAt: 0, buffer: '#chan', networkId: 'n1',
};

beforeEach(() => {
  calls = [];
  postResponse = { status: 202, body: { jobId: 'job1', state: 'running' } };
  pollResponses = [];
  pollFallback = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const r = (init?.method === 'POST')
      ? postResponse
      : (pollResponses.shift() ?? pollFallback ?? { status: 404, body: {} });
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    };
  }));
});

afterEach(() => { vi.unstubAllGlobals(); });

const opts = { intervalMs: 1, timeoutMs: 5000 };

describe('convertUploadToGif — job + poll', () => {
  it('polls to completion and reports every snapshot in order', async () => {
    pollResponses = [
      running(10),
      running(60),
      { status: 200, body: { state: 'done', percent: 100, frame: 900, fps: 18, speed: 1.4, durationMs: 30000, outTimeMs: 30000, elapsedMs: 20000, etaMs: 0, result: RESULT } },
    ];
    const seen: GifJob[] = [];
    const out = await convertUploadToGif('u1', (j) => seen.push(j), opts);
    expect(out).toEqual(RESULT);
    expect(seen.map(j => [j.state, j.percent])).toEqual([
      ['running', 10], ['running', 60], ['done', 100],
    ]);
    expect(calls[0]).toBe('POST /api/uploads/u1/gif');
    expect(calls[1]).toBe('GET /api/uploads/gif-jobs/job1');
  });

  it('rejects with the server error string on state:error', async () => {
    pollResponses = [
      running(10),
      { status: 200, body: { state: 'error', percent: 10, frame: 5, fps: 0, speed: 0, durationMs: 30000, outTimeMs: 0, elapsedMs: 100, etaMs: 0, error: 'ffmpeg failed (exit 1)' } },
    ];
    await expect(convertUploadToGif('u1', undefined, opts)).rejects.toThrow('ffmpeg failed (exit 1)');
  });

  it('rejects with job expired when a poll 404s', async () => {
    pollResponses = [{ status: 404, body: { error: 'not found' } }];
    await expect(convertUploadToGif('u1', undefined, opts)).rejects.toThrow('GIF conversion job expired');
  });

  it('passes a durationMs:0 snapshot through untouched so the UI can go indeterminate', async () => {
    pollResponses = [
      running(0, { durationMs: 0, frame: 42, fps: 12.5, etaMs: 0 }),
      { status: 200, body: { state: 'done', percent: 100, frame: 90, fps: 12.5, speed: 1, durationMs: 0, outTimeMs: 0, elapsedMs: 3000, etaMs: 0, result: RESULT } },
    ];
    const seen: GifJob[] = [];
    await convertUploadToGif('u1', (j) => seen.push(j), opts);
    expect(seen[0].durationMs).toBe(0);
    expect(seen[0].frame).toBe(42);
    expect(seen[0].fps).toBe(12.5);
  });

  it('times out while the job stays running', async () => {
    pollFallback = running(20);
    await expect(convertUploadToGif('u1', undefined, { intervalMs: 1, timeoutMs: 5 }))
      .rejects.toThrow('GIF conversion timed out');
    expect(calls.length).toBeGreaterThan(1); // POST + at least one poll
  });

  it('rejects on a synchronous 400 and never polls', async () => {
    postResponse = { status: 400, body: { error: 'Not a convertible file (video or WebP)' } };
    await expect(convertUploadToGif('u1', undefined, opts))
      .rejects.toThrow('Not a convertible file (video or WebP)');
    expect(calls).toEqual(['POST /api/uploads/u1/gif']);
  });
});
