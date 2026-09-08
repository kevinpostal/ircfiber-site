/**
 * Cursor-splice math for the MOTD raw editor, kept out of the component so the
 * line handling is testable without a textarea.
 */

/**
 * Splices banner `lines` into `body` at `at` (a textarea `selectionStart`),
 * always on their own lines, and reports where the caret should land.
 * A cursor mid-line pushes the banner to the next line and the tail keeps
 * its own line; an empty `lines` leaves the body untouched.
 */
export function insertBanner(body: string, at: number, lines: string[]): { body: string; caret: number } {
  if (lines.length === 0) return { body, caret: at };
  const i = Math.max(0, Math.min(at, body.length));
  const head = body.slice(0, i);
  const tail = body.slice(i);
  const lead = head === '' || head.endsWith('\n') ? '' : '\n';
  const trail = tail.startsWith('\n') ? '' : '\n';
  const next = head + lead + lines.join('\n') + trail;
  return { body: next + tail, caret: next.length };
}
