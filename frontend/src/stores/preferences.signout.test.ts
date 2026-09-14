import { describe, expect, it } from 'vitest';
import {
	setStorageItem,
	clearLocalPreferences,
	isPersistSuppressed,
	flushPersist,
} from './preferences.svelte';

// Own file on purpose: clearLocalPreferences latches persistence off for the
// lifetime of the module, which is correct in a page that is navigating to
// /login but would starve every later test sharing the module instance.
describe('clearLocalPreferences (sign-out sweep)', () => {
	it('removes every ircfiber:* key and blocks the writes that would resurrect them', () => {
		localStorage.setItem('ircfiber:pinned', JSON.stringify({ 'net1:#general': true }));
		localStorage.setItem('ircfiber:pinned:_savedAt', String(Date.now()));
		localStorage.setItem('ircfiber:dirtySeen', '{}');
		localStorage.setItem('token', 'jwt-value');

		clearLocalPreferences();

		expect(Object.keys(localStorage).filter((k) => k.startsWith('ircfiber:'))).toEqual([]);
		// The auth token has no prefix and is the caller's business.
		expect(localStorage.getItem('token')).toBe('jwt-value');

		// A debounced persist and the beforeunload dirtySeen write both land
		// after the sweep and before the sign-out navigation completes. Left
		// ungated they re-create the previous account's keys for whoever logs
		// in next on this browser.
		expect(isPersistSuppressed()).toBe(true);
		flushPersist();
		setStorageItem('ircfiber:pinned', { 'net1:#general': true });
		expect(localStorage.getItem('ircfiber:pinned')).toBeNull();
	});
});
