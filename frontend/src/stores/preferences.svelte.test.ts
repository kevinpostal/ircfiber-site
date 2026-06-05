import { describe, expect, it, beforeEach, vi } from 'vitest';
import { flushSync } from 'svelte';
import {
	clearedAtMap,
	unreadMap,
	highlightMap,
	archivedMap,
	ignoreList,
	highlightWords,
	membersCollapsedMap,
	getClearedAt,
	setClearedAt,
	clearClearedAt,
	isIgnored,
} from './preferences.svelte';

function resetPreferenceState(): void {
	Object.keys(clearedAtMap).forEach((k) => delete (clearedAtMap as Record<string, unknown>)[k]);
	Object.keys(unreadMap).forEach((k) => delete (unreadMap as Record<string, unknown>)[k]);
	Object.keys(highlightMap).forEach((k) => delete (highlightMap as Record<string, unknown>)[k]);
	Object.keys(archivedMap).forEach((k) => delete (archivedMap as Record<string, unknown>)[k]);
	ignoreList.length = 0;
	highlightWords.length = 0;
	Object.keys(membersCollapsedMap).forEach((k) => delete (membersCollapsedMap as Record<string, unknown>)[k]);
}

beforeEach(() => {
	resetPreferenceState();

	vi.stubGlobal('localStorage', {
		getItem: vi.fn(() => null),
		setItem: vi.fn(),
		removeItem: vi.fn(),
		clear: vi.fn(),
	});
});

describe('getClearedAt', () => {
	it('returns null when not set', () => {
		expect(getClearedAt('net1', '#chan')).toBeNull();
	});
});

describe('setClearedAt', () => {
	it('stores timestamp', () => {
		const before = Date.now();
		setClearedAt('net1', '#chan');
		const after = Date.now();

		const val = getClearedAt('net1', '#chan');
		expect(val).not.toBeNull();
		expect(val).toBeGreaterThanOrEqual(before);
		expect(val).toBeLessThanOrEqual(after);
	});
});

describe('clearClearedAt', () => {
	it('removes entry', () => {
		setClearedAt('net1', '#chan');
		clearClearedAt('net1', '#chan');
		expect(getClearedAt('net1', '#chan')).toBeNull();
	});
});

describe('isIgnored', () => {
	beforeEach(() => {
		ignoreList.push('spammer', 'troll_*', 'bot?');
	});

	it('matches exact nick', () => {
		expect(isIgnored('spammer')).toBe(true);
		expect(isIgnored('Spammer')).toBe(true);
		expect(isIgnored('other')).toBe(false);
	});

	it('matches wildcard pattern', () => {
		expect(isIgnored('troll_123')).toBe(true);
		expect(isIgnored('troll_abc')).toBe(true);
		expect(isIgnored('troll')).toBe(false);
		expect(isIgnored('bot1')).toBe(true);
		expect(isIgnored('bot12')).toBe(false);
	});

	it('is case-insensitive', () => {
		expect(isIgnored('SPAMMER')).toBe(true);
		expect(isIgnored('Troll_123')).toBe(true);
		expect(isIgnored('BOT1')).toBe(true);
	});
});

describe('localStorage persistence', () => {
	it('calls localStorage.setItem on change', () => {
		const setItem = vi.fn();
		vi.stubGlobal('localStorage', {
			getItem: vi.fn(() => null),
			setItem,
			removeItem: vi.fn(),
			clear: vi.fn(),
		});

		setClearedAt('net1', '#chan');
		flushSync();

		expect(setItem).toHaveBeenCalled();
		expect(setItem).toHaveBeenCalledWith('ircfiber:clearedAt', expect.any(String));
	});
});
