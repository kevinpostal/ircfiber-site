/** Normalize a user-entered IRC host input.
 *
 * Accepts:
 * - bare hostname: "irc.libera.chat"
 * - bracketed IPv6: "[2001:470:b:56f:30:5::]" or "[2001:470:b:56f:30:5::]:443"
 * - full IRC URL: "ircs://[2001:470:b:56f:30:5::]:443" or "irc://irc.example.com:6667"
 *
 * Returns the host without brackets/scheme/port. Port extraction is the caller's
 * responsibility if they want to auto-fill it; this helper only normalizes the host
 * string itself. For ircs:// / irc:// inputs it strips scheme and path.
 */
export function normalizeHost(input: string): string {
  let host = input.trim();
  const schemeSep = host.indexOf('://');
  if (schemeSep >= 0) {
    host = host.slice(schemeSep + 3);
    const slash = host.indexOf('/');
    if (slash >= 0) host = host.slice(0, slash);
    const bracketClose = host.indexOf(']');
    if (bracketClose >= 0) {
      const open = host.indexOf('[');
      if (open >= 0) host = host.slice(open, bracketClose + 1);
      else host = host.slice(0, bracketClose + 1);
    } else {
      const colon = host.lastIndexOf(':');
      if (colon >= 0) {
        const after = host.slice(colon + 1);
        const allDigits = after.length > 0 && /^[0-9]+$/.test(after);
        const looksLikeIPv6 = host.includes('::') || host.indexOf(':') !== host.lastIndexOf(':');
        if (allDigits && !looksLikeIPv6) host = host.slice(0, colon);
      }
    }
    host = host.trim();
  }
  if (host.length >= 2 && host[0] === '[') {
    const close = host.indexOf(']');
    if (close > 0) return host.slice(1, close);
  }
  return host;
}

/** Try to parse an ircs:// / irc:// URL pasted into the host field.
 * Returns {host, port, tls} if input looks like a URL, else null.
 * Port is extracted from the URL if present; tls is 'required' for ircs, 'disabled' for irc.
 */
export function parseHostUrl(input: string): { host: string; port?: number; tls?: 'required' | 'disabled' } | null {
  const trimmed = input.trim();
  const schemeMatch = trimmed.match(/^(ircs?):\/\//i);
  if (!schemeMatch) return null;
  try {
    const url = new URL(trimmed);
    const host = url.hostname; // URL already strips brackets
    const port = url.port ? parseInt(url.port, 10) : undefined;
    const tls = schemeMatch[1].toLowerCase() === 'ircs' ? 'required' as const : 'disabled' as const;
    if (!host) return null;
    return { host, port, tls };
  } catch {
    // Fallback manual parse for edge cases where URL() rejects bare IPv6 without brackets
    return { host: normalizeHost(trimmed) };
  }
}
