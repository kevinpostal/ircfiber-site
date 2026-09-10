/**
 * Boot-state invariant for the typing maps.
 *
 * Lives in its own file on purpose: every other typing test calls
 * `resetTypingState()` first, which assigns `ircState.typing = {}` and
 * therefore hides a store literal that never declared the field. Shipping
 * exactly that (the field was dropped when typingStreaks was added) made
 * the first TAGMSG throw "Cannot read properties of undefined (reading
 * '<networkId>:#channel>')" and took the whole SPA down on boot, so the
 * untouched-store path is what this file exercises — no reset anywhere.
 */
import { describe, it, expect } from 'vitest';
import { setTyping, getTypersForBuffer, ircState } from './ircStore.svelte';

describe('typing state at boot (no reset)', () => {
  it('the store ships both typing maps, so the first TAGMSG cannot throw', () => {
    expect(ircState.typing).toBeDefined();
    expect(ircState.typingStreaks).toBeDefined();

    setTyping('boot-net', '#boot', 'Alice');
    expect(getTypersForBuffer('boot-net', '#boot')).toContain('Alice');
  });
});
