// ─────────────────────────────────────────────────────────────────────
// suspiciousConnection — IRCCloud parity suspicious-port / -host helpers (W2-T01)
// ─────────────────────────────────────────────────────────────────────
//
// TypeScript port of the two helpers IRCCloud applies inline next to
// the connection banner:
//   · isSuspiciousPort — flags port/protocol mismatches (typical plain-
//     IRC port with SSL or vice-versa)
//   · isSuspiciousHostname — flags obvious host typos (leading/trailing
//     dot, no dot, no colon → likely a typo)
//
// Source: irccloud-webpack-study/app/src/model/connection.js:204-216
// (BOTH helpers were authored together — `defaultPort: 6667` and
// `defaultSSLPort: 6697` declared at line 1658-1659).
//
// Return shape: these helpers return the EXACT warning string (or
// `null` when not suspicious) so the ConnectionStatus banner can
// render them inline without a separate translation table. The
// string is short enough to drop directly into the hairline-bar
// copy: "You're trying to connect via SSL on port 6667." etc.
//
// Pure helpers — no Svelte imports; no DOM.
// ─────────────────────────────────────────────────────────────────────

/** IRCCloud's defaultPort constant (line 1658 of connection.js). The
 *  plain-IRC port range the banner flags as suspicious when the user
 *  is connected over TLS (or vice-versa). RFC 2812 §3.1 lists 6667
 *  as the historical default; modern IRCds also accept 6660-6669 and
 *  some accept 7000. We treat the classic 6667 + the 6660-6669 +
 *  7000 set as the "plain IRC ports" range so a server that picks
 *  6665 etc. still trips the warning. */
const PLAIN_IRC_PORTS: ReadonlySet<number> = new Set([
  6667, 6660, 6661, 6662, 6663, 6664, 6665, 6666, 6668, 6669, 7000,
]);

/** IRCCloud's defaultSSLPort constant (line 1659). 6697 is the
 *  canonical IRC-over-TLS port; modern IRCds also accept 6690-6699.
 *  Symmetric to the plain set above. */
const TLS_IRC_PORTS: ReadonlySet<number> = new Set([
  6697, 6690, 6691, 6692, 6693, 6694, 6695, 6696, 6698, 6699,
]);

/**
 * Returns a warning string when the chosen port suggests the wrong
 * protocol, or `null` when the port/protocol pairing is normal.
 *
 * Pattern matched to IRCCloud's `isSuspiciousPort`:
 *   (isSSL && port === defaultPort) || (!isSSL && port === defaultSSLPort)
 * — extended to the wider port sets above so a server on e.g. 6665
 * over SSL also trips the warning.
 *
 * @param port Network's `port` (e.g. `net.port`).
 * @param isSSL Network's `tls === 'on'` (or the equivalent truthy value).
 * @returns Inline warning string, or null when not suspicious.
 */
export function isSuspiciousPort(port: number, isSSL: boolean): string | null {
  if (!Number.isFinite(port) || port <= 0) return null;

  if (isSSL && PLAIN_IRC_PORTS.has(port)) {
    // User asked to use SSL on a plain-IRC port — that's almost
    // certainly a config mistake (the server likely isn't listening
    // TLS here, or expects a different port).
    return `You're trying to connect via SSL on port ${port}.`;
  }
  if (!isSSL && TLS_IRC_PORTS.has(port)) {
    // User asked to connect without SSL on a TLS port — same root
    // cause: mismatched expectations about the server's listener.
    return `You're trying to connect without SSL on port ${port}.`;
  }
  return null;
}

/**
 * Returns a warning string when the host looks typo-prone, or `null`
 * when the hostname shape is normal.
 *
 * Pattern matched to IRCCloud's `isSuspiciousHostname` (line 211-216):
 *   · leading dot (".irc.example.org")
 *   · trailing dot ("irc.example.org.")
 *   · no dot AND no colon ("localhost", "myhost") — single-label
 *     names that aren't IPv6 literals (which carry a colon) are
 *     almost always a typo / un-resolvable hostname
 *
 * The second parameter `isSSL` is part of the symmetric API surface
 * (paired with `isSuspiciousPort`) but unused here — IRCCloud's
 * original also takes no isSSL input. Reserved for future use
 * (e.g. "you're using TLS to a hostname that resolves via /etc/hosts
 * to 127.0.0.1").
 *
 * @param host Hostname the user typed (e.g. `net.host`).
 * @param isSSL Network's `tls === 'on'`. Currently unused.
 * @returns Inline warning string, or null when not suspicious.
 */
export function isSuspiciousHostname(host: string, _isSSL?: boolean): string | null {
  if (typeof host !== 'string' || host.length === 0) {
    // Empty / non-string hostname — treat as missing rather than
    // suspicious. The banner has its own blank-host copy elsewhere.
    return null;
  }

  if (host.charAt(0) === '.') {
    return `Your hostname has a leading dot: ${host}`;
  }
  if (host.charAt(host.length - 1) === '.') {
    return `Your hostname has a trailing dot: ${host}`;
  }
  if (host.indexOf('.') === -1 && host.indexOf(':') === -1) {
    // No dot, no colon — `localhost`, `myhost`, `example`. All of these
    // either unresolvable or ambiguous. IPv6 literals always carry a
    // colon, so the colon-test excludes "::1" etc. (matched by IRCCloud).
    return `Your hostname looks invalid: ${host}`;
  }

  return null;
}
