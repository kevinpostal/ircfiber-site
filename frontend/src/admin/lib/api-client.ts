/**
 * Low-level fetch client for the admin JSON API.
 *
 * The D backend wraps every response in `{ok:true,data:...}` or
 * `{ok:false,error:"..."}`. This client unwraps those and throws
 * ApiError on failure so call sites can just `await client.get(...)`.
 *
 * Includes:
 *   - automatic credentials (cookies carry the admin session)
 *   - JSON body parsing for POST/PUT/DELETE
 *   - timeout via AbortController
 *   - X-Requested-With header so the backend can return JSON instead of redirects
 */

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  let url = path.startsWith('/') ? path : '/' + path;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v == null) continue;
      params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }
  return url;
}

export async function request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, timeoutMs = 15_000, signal } = opts;
  const url = buildUrl(path, query);

  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'X-Requested-With': 'fetch',
  };
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new DOMException('Timeout', 'TimeoutError')), timeoutMs);
  // If the caller passed their own signal, wire it up
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', () => ac.abort(signal.reason));
  }

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin', signal: ac.signal });
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof Error && e.name === 'TimeoutError') {
      throw new ApiError('Request timed out', 0);
    }
    throw new ApiError((e as Error).message || 'Network error', 0);
  }
  clearTimeout(timer);

  // Try to parse JSON regardless; the backend always returns either
  // the envelope or an HTML error page.
  const raw = await res.text();
  // Workaround for gateway mullvad/status stray `]` bug (]]}} vs ]}}): strip the extra bracket before parse
  const fixedRaw = raw.replace(/\]\]}}/g, ']}}');
  let parsed: { ok?: boolean; data?: T; error?: string } | null = null;
  try { parsed = fixedRaw ? JSON.parse(fixedRaw) : null; } catch { try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; } }
  if (!res.ok) {
    const msg = parsed?.error || `HTTP ${res.status}`;
    throw new ApiError(msg, res.status);
  }
  if (parsed && parsed.ok === false) {
    throw new ApiError(parsed.error || 'Unknown error', res.status);
  }
  if (parsed && 'data' in parsed) return parsed.data as T;
  // Legacy: server returned the data directly (no envelope)
  return raw as unknown as T;
}

export const api = {
  get:    <T = unknown>(path: string, query?: RequestOptions['query']) => request<T>(path, { method: 'GET', query }),
  post:   <T = unknown>(path: string, body?: unknown, query?: RequestOptions['query']) => request<T>(path, { method: 'POST', body, query }),
  put:    <T = unknown>(path: string, body?: unknown, query?: RequestOptions['query']) => request<T>(path, { method: 'PUT', body, query }),
  patch:  <T = unknown>(path: string, body?: unknown, query?: RequestOptions['query']) => request<T>(path, { method: 'PATCH', body, query }),
  delete: <T = unknown>(path: string, body?: unknown, query?: RequestOptions['query']) => request<T>(path, { method: 'DELETE', body, query }),
};