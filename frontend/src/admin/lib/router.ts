/**
 * Lightweight hash-based router for the admin SPA.
 *
 * Routes are flat strings (no params in the matcher — the admin URLs
 * are simple /admin/foo/bar style and most dynamic params live in the
 * query string). A leading `#` separates the route from any further
 * hash fragments.
 *
 * Examples:
 *   navigate('/dashboard')  → window.location.hash = '#/dashboard'
 *   current()               → '/dashboard'
 *   onChange(cb)            → cb fires with new path on hashchange + initial
 */

const PREFIX = '#';

export function current(): string {
  const h = window.location.hash;
  if (!h || h.length <= PREFIX.length) return '/';
  return h.slice(PREFIX.length) || '/';
}

export function navigate(path: string): void {
  if (!path.startsWith('/')) path = '/' + path;
  if (window.location.hash === PREFIX + path) return;
  window.location.hash = PREFIX + path;
}

export function onChange(cb: (path: string) => void): () => void {
  const handler = () => cb(current());
  window.addEventListener('hashchange', handler);
  // Fire once immediately
  queueMicrotask(() => cb(current()));
  return () => window.removeEventListener('hashchange', handler);
}

/** Match a route pattern against a path. Returns null on no match,
 *  or an object with extracted params. Supports `:name` placeholders
 *  and trailing wildcard `*`.
 */
export function match(pattern: string, path: string): Record<string, string> | null {
  const ps = pattern.split('/').filter(Boolean);
  const xs = path.split('/').filter(Boolean);
  if (pattern.endsWith('*')) {
    const base = ps.slice(0, -1);
    if (xs.length < base.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < base.length; i++) {
      if (base[i].startsWith(':')) params[base[i].slice(1)] = decodeURIComponent(xs[i]);
      else if (base[i] !== xs[i]) return null;
    }
    params['*'] = xs.slice(base.length).map(decodeURIComponent).join('/');
    return params;
  }
  if (ps.length !== xs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < ps.length; i++) {
    if (ps[i].startsWith(':')) params[ps[i].slice(1)] = decodeURIComponent(xs[i]);
    else if (ps[i] !== xs[i]) return null;
  }
  return params;
}

/** Build a link href for an admin path. */
export function href(path: string): string {
  return PREFIX + path;
}