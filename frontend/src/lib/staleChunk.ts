/**
 * Recovery for a lazily loaded chunk that is no longer on the server.
 *
 * Every hashed asset name changes when the gateway ships, and the swap
 * deletes the previous build's files. A tab that was open across a deploy
 * is still running the old `main-*.js`, which asks for the old
 * `chunk-*.js` the first time the user opens a lazily loaded surface —
 * Help & Feedback, Settings, a file viewer. The server 404s it, the
 * dynamic import rejects, and the tab is left running code the server no
 * longer has.
 *
 * Reported as "help & feedback brings up blank page when navigating
 * within the website but entering the direct url for feedback works":
 * the direct URL is a fresh document, so it gets the current index.html
 * and the current hashes.
 *
 * The only real repair is to fetch the new index.html, so the first such
 * failure in a tab reloads. A reload that does not fix it must not loop,
 * so a second failure inside the retry window gives up and leaves the
 * caller to render something the user can act on.
 */

/** Messages browsers use for a dynamic import that never arrived. */
const CHUNK_GONE =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Loading chunk \d+ failed/i;

const RELOAD_KEY = 'ircfiber:stale-chunk-reload';
const RETRY_WINDOW_MS = 60_000;

/** Whether a rejection looks like a chunk the server does not have. */
export function isStaleChunkError(error: unknown): boolean {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? '');
  return CHUNK_GONE.test(message);
}

function lastReloadAt(): number {
  try {
    return Number(sessionStorage.getItem(RELOAD_KEY) ?? 0) || 0;
  } catch {
    return 0; // storage blocked (private mode, cookie policy) — treat as first try
  }
}

function markReloaded(): void {
  try {
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    /* nothing to remember it with; the window check just always retries */
  }
}

/**
 * Reload to pick up the current bundle, at most once per retry window.
 * @param error The rejection that exposed the stale chunk.
 * @param reload How to reload; the default is the real navigation.
 * @returns Whether a reload was started. `false` means the caller should
 *          render a recovery surface instead of a blank one.
 */
export function recoverFromStaleChunk(
  error: unknown,
  reload: () => void = () => location.reload(),
): boolean {
  if (!isStaleChunkError(error)) return false;
  if (Date.now() - lastReloadAt() < RETRY_WINDOW_MS) {
    console.error('[staleChunk] chunk still missing after a reload; not looping', error);
    return false;
  }
  markReloaded();
  console.warn('[staleChunk] a chunk from the previous build is gone; reloading', error);
  reload();
  return true;
}
