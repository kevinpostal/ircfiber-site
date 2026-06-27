let onlineChangeCallbacks: Array<(online: boolean) => void> = [];
let isOnline = navigator.onLine;
let pingTimer: ReturnType<typeof setInterval>;

export function onOnlineChange(cb: (online: boolean) => void): void {
    onlineChangeCallbacks.push(cb);
}

function setOnline(online: boolean): void {
    if (online !== isOnline) {
        isOnline = online;
        for (const cb of onlineChangeCallbacks) cb(online);
    }
}

async function ping(): Promise<boolean> {
    try {
        const r = await fetch('/api/ping', { method: 'HEAD', signal: AbortSignal.timeout(2000) });
        return r.ok;
    } catch { return false; }
}

export function startOnlineChecker(): void {
    window.addEventListener('online', async () => {
        const online = await ping();
        setOnline(online);
        if (!online) startPingPoll();
    });
    window.addEventListener('offline', () => setOnline(false));
    startPingPoll();
}

function startPingPoll(): void {
    clearInterval(pingTimer);
    pingTimer = setInterval(async () => {
        const online = await ping();
        setOnline(online);
        if (online) clearInterval(pingTimer);
    }, 30000);
}
