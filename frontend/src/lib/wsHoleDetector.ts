// ── Hole detection + OOB fetch ──
// 2026-07-07 redesign: the WS is "best-effort delivery". The MongoDB
// scrollback is the source of truth. If the client detects a gap in
// the eid stream (e.g. WS silently dropped a frame, or the page was
// hidden), it calls /api/oob?since=<maxEid> to fill the gap.
//
// This matches IRCCloud's OOB (out-of-band) fetch path — when the
// bouncer sends an `oob_include` message, the client knows it missed
// some events and fetches them via a separate HTTP call.
//
// (No imports from wsConnection.svelte or ircStore.svelte — this
// module is pure logic that takes a callback for the OOB fetch result
// and is trivially testable without Svelte runtime.)

export interface HoleDetectorConfig {
    /** Threshold: if nextEid - maxEid > threshold, fetch OOB. */
    threshold: number;
    /** How often to run the detection check (ms). */
    intervalMs: number;
    /** Cooldown between OOB fetches (ms). Don't hammer the server. */
    cooldownMs: number;
}

export const DEFAULT_HOLE_CONFIG: HoleDetectorConfig = {
    threshold: 25,        // a single missed frame is OK; 25 = clear gap
    intervalMs: 5_000,    // check every 5s, matching the ack interval
    cooldownMs: 10_000,   // back off if we just fetched
};

// ── OOB fetch client ──
// Calls GET /api/oob?network=<id>&since=<eid>&count=<n> and returns
// the events. The caller is responsible for routing each event by
// its `ch`/`channel` field into the correct buffer.
export interface OOBResponse {
    events: any[];
    count: number;
    since: number;
}

export async function fetchOOB(
    networkId: string,
    sinceEid: number,
    count = 100,
    signal?: AbortSignal
): Promise<OOBResponse> {
    const r = await fetch(
        `/api/oob?network=${encodeURIComponent(networkId)}&since=${sinceEid}&count=${count}`,
        {
            credentials: 'same-origin',
            ...(signal ? { signal } : {}),
        }
    );
    if (!r.ok) {
        throw new Error(`OOB fetch failed: ${r.status} ${r.statusText}`);
    }
    return r.json();
}

// ── Hole detection ──
// Tracks the last few eids we've seen. If a gap appears (eid
// jump > threshold), triggers an OOB fetch.
export class HoleDetector {
    private config: HoleDetectorConfig;
    private interval: ReturnType<typeof setInterval> | null = null;
    private lastSeenEids: number[] = [];
    private lastFetchAt = 0;
    private onHole: (networkId: string, sinceEid: number, toEid: number) => void;

    constructor(
        config: Partial<HoleDetectorConfig> = {},
        onHole: (networkId: string, sinceEid: number, toEid: number) => void,
    ) {
        this.config = { ...DEFAULT_HOLE_CONFIG, ...config };
        this.onHole = onHole;
    }

    /** Update the detector with a newly-seen eid. Returns true if a
     *  hole was detected and OOB fetch should be triggered. */
    onEid(networkId: string, eid: number): boolean {
        if (eid <= 0) return false;

        // Normal ascending order: append.
        if (this.lastSeenEids.length === 0 || eid > this.lastSeenEids[this.lastSeenEids.length - 1]) {
            this.lastSeenEids.push(eid);
            // Keep the last N eids (small ring buffer)
            if (this.lastSeenEids.length > 20) this.lastSeenEids.shift();
            return false;
        }

        // Out-of-order: a low eid arrived (e.g. OOB fill, replay). We
        // can't tell whether this is a fill (the gap was already
        // closed) or a duplicate. Either way, the safest action is to
        // reset the sliding window so the next checkForHole pass starts
        // fresh — letting any subsequent gap be detected from the
        // current high-water mark.
        this.lastSeenEids = [eid];
        return false;
    }

    /** Run a hole-check pass. Returns the OOB fetch params if a hole
     *  is detected and we're not in cooldown. */
    checkForHole(networkId: string): { since: number; to: number } | null {
        if (this.lastSeenEids.length < 2) return null;

        // Are we in cooldown from a recent fetch?
        if (Date.now() - this.lastFetchAt < this.config.cooldownMs) return null;

        // Find any gap > threshold in the recent sequence.
        // (We don't try to detect the very first hole because we don't
        // know the high-water mark before the page loaded.)
        for (let i = 1; i < this.lastSeenEids.length; i++) {
            const prev = this.lastSeenEids[i - 1];
            const curr = this.lastSeenEids[i];
            const gap = curr - prev - 1;  // number of missing events
            if (gap > this.config.threshold) {
                return { since: prev, to: curr };
            }
        }
        return null;
    }

    /** Mark that we just ran an OOB fetch (for cooldown tracking). */
    recordFetch(): void {
        this.lastFetchAt = Date.now();
    }

    /** Reset the detector (e.g. on network switch or reconnect). */
    reset(): void {
        this.lastSeenEids = [];
        this.lastFetchAt = 0;
    }

    /** Start the periodic hole-check. The callback receives OOB
     *  fetch params. */
    start(networkId: string): void {
        this.stop();
        this.interval = setInterval(() => {
            const hole = this.checkForHole(networkId);
            if (hole) {
                this.recordFetch();
                this.onHole(networkId, hole.since, hole.to);
            }
        }, this.config.intervalMs);
    }

    stop(): void {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }
}
