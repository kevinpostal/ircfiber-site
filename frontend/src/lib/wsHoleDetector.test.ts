import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HoleDetector, fetchOOB, DEFAULT_HOLE_CONFIG } from './wsHoleDetector';

describe('HoleDetector', () => {
    let detector: HoleDetector;
    let onHoleMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        onHoleMock = vi.fn();
        detector = new HoleDetector({}, onHoleMock);
    });

    afterEach(() => {
        detector.stop();
    });

    it('does not detect a hole with no events', () => {
        expect(detector.checkForHole('net1')).toBeNull();
    });

    it('does not detect a hole with contiguous eids', () => {
        detector.onEid('net1', 100);
        detector.onEid('net1', 101);
        detector.onEid('net1', 102);
        expect(detector.checkForHole('net1')).toBeNull();
    });

    it('detects a hole when a gap exceeds the threshold', () => {
        // Push eids that form a gap of 30
        detector.onEid('net1', 100);
        detector.onEid('net1', 131);   // gap = 131 - 100 - 1 = 30 > 25 (default threshold)
        const hole = detector.checkForHole('net1');
        expect(hole).not.toBeNull();
        expect(hole!.since).toBe(100);
        expect(hole!.to).toBe(131);
    });

    it('does not detect a hole smaller than the threshold', () => {
        detector.onEid('net1', 100);
        detector.onEid('net1', 110);  // gap = 9 < 25
        expect(detector.checkForHole('net1')).toBeNull();
    });

    it('skips detection during cooldown', () => {
        detector.onEid('net1', 100);
        detector.onEid('net1', 200);
        // Mark a recent fetch to trigger cooldown
        detector.recordFetch();
        expect(detector.checkForHole('net1')).toBeNull();
    });

    it('allows detection after cooldown expires', () => {
        detector.onEid('net1', 100);
        detector.onEid('net1', 200);
        detector.recordFetch();
        // First check during cooldown
        expect(detector.checkForHole('net1')).toBeNull();
        // Wait for cooldown (use a custom config with 0ms cooldown)
        const fast = new HoleDetector({ cooldownMs: 0 }, onHoleMock);
        fast.onEid('net1', 100);
        fast.onEid('net1', 200);
        fast.recordFetch();
        expect(fast.checkForHole('net1')).not.toBeNull();
        fast.stop();
    });

    it('triggers onHole via the periodic timer', () => {
        vi.useFakeTimers();
        try {
            const localDetector = new HoleDetector({ intervalMs: 1000 }, onHoleMock);
            localDetector.onEid('net1', 100);
            localDetector.onEid('net1', 200);
            localDetector.start('net1');
            vi.advanceTimersByTime(1500);
            expect(onHoleMock).toHaveBeenCalledWith('net1', 100, 200);
            localDetector.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('ignores out-of-order eids (treats as OOB fill, not a hole)', () => {
        detector.onEid('net1', 200);
        detector.onEid('net1', 300);
        // Late-arriving eid (e.g. from OOB fill)
        detector.onEid('net1', 150);
        // Should not flag a hole
        expect(detector.checkForHole('net1')).toBeNull();
    });

    it('reset clears the sliding window and cooldown', () => {
        detector.onEid('net1', 100);
        detector.onEid('net1', 200);
        detector.recordFetch();
        detector.reset();
        // After reset, the only eid is forgotten, so checkForHole returns null
        expect(detector.checkForHole('net1')).toBeNull();
        // New events should be tracked fresh
        detector.onEid('net1', 500);
        detector.onEid('net1', 600);
        expect(detector.checkForHole('net1')).not.toBeNull();
        expect(detector.checkForHole('net1')!.since).toBe(500);
    });

    it('ignores eid <= 0', () => {
        expect(detector.onEid('net1', 0)).toBe(false);
        expect(detector.onEid('net1', -1)).toBe(false);
    });
});

describe('fetchOOB', () => {
    beforeEach(() => {
        global.fetch = vi.fn();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('calls /api/oob with the right query params', async () => {
        (global.fetch as any).mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ events: [], count: 0, since: 100 }),
        });

        await fetchOOB('net-123', 100, 200);

        expect(global.fetch).toHaveBeenCalledWith(
            '/api/oob?network=net-123&since=100&count=200',
            expect.objectContaining({ credentials: 'same-origin' }),
        );
    });

    it('returns the parsed response on success', async () => {
        const events = [{ eid: 101, c: 'NOTICE' }, { eid: 102, c: 'NOTICE' }];
        (global.fetch as any).mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ events, count: 2, since: 100 }),
        });

        const r = await fetchOOB('net-123', 100);
        expect(r.events).toEqual(events);
        expect(r.count).toBe(2);
        expect(r.since).toBe(100);
    });

    it('throws on non-2xx', async () => {
        (global.fetch as any).mockResolvedValue({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            json: async () => ({ error: 'boom' }),
        });

        await expect(fetchOOB('net-123', 100)).rejects.toThrow('OOB fetch failed: 500');
    });

    it('URL-encodes the network id', async () => {
        (global.fetch as any).mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ events: [], count: 0, since: 0 }),
        });

        await fetchOOB('net/with/slashes', 0);

        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('network=net%2Fwith%2Fslashes'),
            expect.anything(),
        );
    });

    it('passes an AbortSignal when provided', async () => {
        const controller = new AbortController();
        (global.fetch as any).mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ events: [], count: 0, since: 0 }),
        });

        await fetchOOB('net-123', 0, 100, controller.signal);

        expect(global.fetch).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ signal: controller.signal }),
        );
    });
});

describe('DEFAULT_HOLE_CONFIG', () => {
    it('has reasonable defaults', () => {
        expect(DEFAULT_HOLE_CONFIG.threshold).toBeGreaterThan(0);
        expect(DEFAULT_HOLE_CONFIG.intervalMs).toBeGreaterThan(0);
        expect(DEFAULT_HOLE_CONFIG.cooldownMs).toBeGreaterThanOrEqual(DEFAULT_HOLE_CONFIG.intervalMs);
    });
});
