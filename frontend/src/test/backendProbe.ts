// Gateway-availability probe for the DB-backed `*.e2e.test.ts` suites.
//
// Those suites are real integration tests: they POST /login with the dev-stack
// admin credentials and then read /api/networks and channel history straight
// out of Mongo/Redis through the IRC Fiber gateway. Vitest's browser project
// serves them from the Vite dev server, whose proxy forwards `/login`, `/api/*`
// and `/ws` to BACKEND_URL — `http://127.0.0.1:8090` by default (vite.config.ts
// L43-44). With no gateway running, every one of those calls fails, so the
// suites are guaranteed red on a plain dev checkout and hide real regressions.
//
// So each suite asks once, up front, whether the gateway is actually there and
// gates itself with `describe.skipIf(...)`. The skip is conditional on this
// probe only: with the stack up the suites run completely unchanged.
//
// Why `GET /login` and not `/api/health`: the `/api` proxy rule in
// vite.config.ts (L187-204) deliberately swallows ECONNREFUSED and answers
// `200 []` so the SPA's event-polling fallback stays quiet — an `/api` probe
// therefore cannot tell "gateway down" from "gateway up". The `/login` rule
// (L238-242) has no such handler: Vite answers 5xx when the upstream refuses
// the connection, while a live gateway serves the login page (200) or redirects
// an already-authenticated session into the SPA. `GET /login` is also
// side-effect free (`router.get("/login", &loginPage)` in
// site/backend/source/ircfiber/web/package.d L86).

/** Host:port the Vite dev/test proxy forwards `/login` + `/api/*` to. */
export const GATEWAY_URL = '127.0.0.1:8090';

/** Reason shown in the suite name when the probe comes back negative. */
export const GATEWAY_SKIP_REASON =
  `needs the IRC Fiber gateway + Mongo/Redis on ${GATEWAY_URL}`;

const PROBE_TIMEOUT_MS = 1500;

let probe: Promise<boolean> | null = null;

/**
 * True when the Vite proxy target answers, i.e. the gateway stack is up.
 * The request is issued at most once per module instance (once per test file
 * under vitest browser isolation) and never throws.
 */
export function gatewayAvailable(): Promise<boolean> {
  probe ??= (async () => {
    try {
      const res = await fetch('/login', {
        method: 'GET',
        credentials: 'include',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      // 5xx here is Vite's proxy reporting ECONNREFUSED/ETIMEDOUT upstream.
      return res.status < 500;
    } catch {
      // Network error / abort: no gateway.
      return false;
    }
  })();
  return probe;
}
