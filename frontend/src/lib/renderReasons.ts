// ─────────────────────────────────────────────────────────────────────
// renderReasons — IRCCloud parity reason rendering (W2-T01)
// ─────────────────────────────────────────────────────────────────────
//
// TypeScript port of IRCCloud's `app/src/view/renderreasons.js` —
// trimmed per the Wave-2 critique (OE1 fix): only the two exports
// the Wave-3 ConnectionStatus banner actually consumes (`renderReason`
// for the structured fail-reason body, `renderSSLVerify` for the
// nested SSL-verify detail). Every other helper (RESTRICTED_REASONS,
// renderRestricted*, POST_ERRORS, renderPostError, the FileWrapper-
// backed sizeToString for `file_too_large`) was dropped because no
// Wave-3/4 consumer references them.
//
// The dropped tables are documented in the trailing TODO comment so a
// follow-up PR can re-introduce them when the banner or server-log
// rendering grows a path that needs them.
// ─────────────────────────────────────────────────────────────────────

/**
 * Reason key → human-readable string. Lifted verbatim from
 * irccloud-webpack-study/app/src/view/renderreasons.js:17-32
 * (`RENDER_REASONS`). Unknown keys fall through to the raw reason
 * string — same behaviour as IRCCloud (line 92-94), which lets banner
 * code render any engine-side `disconnectReason` that the table
 * doesn't know about (e.g. server-supplied free text from an old
 * build, or custom IRCds).
 *
 * Use this from the ConnectionStatus banner to render `failInfo.reason`
 * into the structured "Disconnected: {renderReason(reason)}" body
 * (per plan W3-T01 failure rendering).
 */
export function renderReason(reason: string): string {
  const trimmed = typeof reason === 'string' ? reason : '';
  // Pinned by TG1: every key below returns its IRCCloud string;
  // unknown keys fall through unchanged.
  switch (trimmed) {
    case 'pool_lost':            return 'Connection pool failed';
    case 'no_pool':              return 'No available connection pools';
    case 'enetdown':             return 'Network down';
    case 'etimedout':            return 'Timed out';
    case 'timeout':              return 'Timed out';
    case 'closed':               return 'Connection closed';
    case 'enotconn':             return 'Connection unavailable';
    case 'ehostunreach':         return 'Host unreachable';
    case 'econnrefused':         return 'Connection refused';
    case 'nxdomain':             return 'Invalid hostname';
    case 'einval':               return 'Invalid hostname';
    case 'ssl_certificate_error': return 'SSL certificate error';
    case 'ssl_error':            return 'SSL error';
    case 'crash':                return 'Connection crashed';
    default:
      // Pass-through: render the raw reason so the banner still shows
      // *something*. The engine emits typed reasons but legacy paths
      // (or unparseable server-side strings) will land here.
      return trimmed;
  }
}

/**
 * Wire shape used by the engine's `CONNECTION_FAIL` event for the
 * `sslVerifyError` nested object (see source/ircfiber/models/irc_event.d
 * `makeConnectionFail`, FailInfo struct's `sslVerifyError: Json`). The
 * front-end mirrors it as a plain object — `{type, error}` — so the TS
 * interface stays a 1:1 structural match with the engine's wire payload
 * (no conversion needed in messageHandler.ts).
 */
export interface SslVerifyInfo {
  type: string;
  error: string;
}

/**
 * Nested-key lookup for the SSL-verify detail. The engine nests the
 * underlying OpenSSL error family under `type` (e.g. `bad_cert`) and
 * the specific error code under `error` (e.g. `cert_expired`); the
 * banner stitches them together into a single human-readable string
 * (per plan W3-T01 SSL verify branch).
 *
 * Lifted from irccloud-webpack-study/app/src/view/renderreasons.js:34-50
 * (`SSL_VERIFY_ERRORS`). Unknown (type, error) pairs fall back to the
 * raw `"type: error"` form so the banner still says *something*
 * meaningful when the OpenSSL class grows a new code upstream.
 */
export function renderSSLVerify(info: SslVerifyInfo | null | undefined): string {
  if (!info || typeof info.type !== 'string' || typeof info.error !== 'string') {
    // Defensive: engine emits null/undefined for non-SSL failures (the
    // `sslVerifyError` field is omitted from the wire entirely in that
    // case) so this branch just preserves "do not call me on non-SSL".
    // Returning empty string keeps the banner from rendering
    // "undefined: undefined" when Wave 3 forgets to gate on
    // `failInfo.reason === 'ssl_verify_error'`.
    return '';
  }

  const type = info.type;
  const error = info.error;

  // bad_cert family — the most common OpenSSL verify outcome on IRC.
  if (type === 'bad_cert') {
    switch (error) {
      case 'unknown_ca':             return 'Unknown certificate authority';
      case 'selfsigned_peer':        return 'Self signed certificate';
      case 'cert_expired':           return 'Certificate expired';
      case 'invalid_issuer':         return 'Invalid certificate issuer';
      case 'invalid_signature':      return 'Invalid certificate signature';
      case 'name_not_permitted':     return 'Invalid certificate alternative hostname';
      case 'missing_basic_constraint': return 'Missing certificate basic contraints';
      case 'invalid_key_usage':      return 'Invalid certificate key usage';
      default:
        return `${type}: ${error}`;
    }
  }

  // ssl_verify_hostname family — RFC 2812 server-name match failures.
  if (type === 'ssl_verify_hostname') {
    switch (error) {
      case 'unable_to_match_altnames':   return 'Certificate hostname mismatch';
      case 'unable_to_match_common_name': return 'Certificate hostname mismatch';
      case 'unable_to_decode_common_name': return 'Invalid certificate hostname';
      default:
        return `${type}: ${error}`;
    }
  }

  // Unknown SSL-verify type — fall back to the raw pair. The banner
  // can choose to bold-format it or not; we hand back a stable string.
  return `${type}: ${error}`;
}

// ─────────────────────────────────────────────────────────────────────
// TODO (W2-T01 critic OE1 follow-up):
//
// The Wave-1 port included a broader table that this file deliberately
// trims. Re-introduce these exports when a consumer lands:
//
//   · renderRestricted(reason): string
//     RESTRICTED_REASONS = {
//       networks:            "You've exceeded the connection limit for free accounts. <b>Upgrade now</b> to connect to more servers",
//       unverified:          "You can't connect to external servers until you confirm your email address",
//       passworded_servers:  "You can't connect to passworded servers with free accounts. <b>Upgrade now</b>",
//       slack_disallowed:    "You can't connect to Slack workspaces with free accounts. <b>Upgrade now</b>",
//     }
//     Default: "You can't connect to this server with a free account. <b>Upgrade now</b>"
//     NOTE: IRC Fiber has NO paid-tier upgrade surface. When this lands,
//     ConnectionStatus will need to detect failInfo.type==='connecting_restricted'
//     OR failInfo.type==='connection_blocked' and degrade the
//     <b>Upgrade now</b> CTA to a generic 'Click to reconnect' button.
//     (See plan open_questions.connection_blocked.)
//
//   · renderRestrictedShort(reason): string   →  RESTRICTED_REASONS_SHORT
//     Default: 'Limited'
//
//   · renderPostError(response, message): string
//     POST_ERRORS entries that don't need a FileWrapper.sizeToString
//     (paste_too_large, paste_invalid, paste_empty, database_down, auth,
//      …) can be ported wholesale. The `file_too_large` entry has to
//     stay dropped because fiber has no client-side sizeToString —
//     port it later if a ServerLogTimeline banner path needs it.
//
// Each of these is a follow-up PR; this file stays surgical until a
// consumer lands.
// ─────────────────────────────────────────────────────────────────────
