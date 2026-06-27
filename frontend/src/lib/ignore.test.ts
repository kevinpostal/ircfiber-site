import { describe, it, expect } from 'vitest';
import { IgnoreMap, upgradeLegacyPattern, parseIgnoreList } from './ignore';

describe('IgnoreMap', () => {
    it('matches exact nick', () => {
        const map = parseIgnoreList(['alice']);
        expect(map.check('alice')).toBe(true);
        expect(map.check('bob')).toBe(false);
    });

    it('matches nick!user@host', () => {
        const map = parseIgnoreList(['alice!*@*']);
        expect(map.check('alice', 'user@host')).toBe(true);
    });

    it('matches wildcard host', () => {
        const map = parseIgnoreList(['*!*@evil.host']);
        expect(map.check('alice', 'user@evil.host')).toBe(true);
        expect(map.check('bob', 'user@good.host')).toBe(false);
    });

    it('preserves existing wildcard pattern (C1 fix)', () => {
        const map = parseIgnoreList(['evil*']);
        // evil* has * → treated as literal nick "evil*" (not regex wildcard)
        expect(map.check('evil*')).toBe(true);      // literal match
        expect(map.check('eviltwin')).toBe(false);   // NOT a regex wildcard
    });

    it('matches * wildcard in ignore.js style', () => {
        const map = new IgnoreMap();
        map.parse(['*!*@example.com']);
        expect(map.check('anyone', 'user@example.com')).toBe(true);
    });

    it('returns false for empty target', () => {
        const map = parseIgnoreList(['alice']);
        expect(map.check('')).toBe(false);
    });

    it('matches case-insensitively', () => {
        const map = parseIgnoreList(['Alice']);
        expect(map.check('alice')).toBe(true);
        expect(map.check('ALICE')).toBe(true);
    });

    it('matches nick!user with wildcard user', () => {
        const map = parseIgnoreList(['alice!*@host']);
        expect(map.check('alice', 'bob@host')).toBe(true);
        expect(map.check('alice', 'bob@other')).toBe(false);
    });

    it('matches *!user@host pattern', () => {
        const map = parseIgnoreList(['*!trusted@host']);
        expect(map.check('alice', 'trusted@host')).toBe(true);
        expect(map.check('bob', 'trusted@host')).toBe(true);
        expect(map.check('alice', 'other@host')).toBe(false);
    });

    it('handles mixed patterns in same map', () => {
        const map = parseIgnoreList(['alice', '*!*@evil.host', 'bob!*@*']);
        expect(map.check('alice')).toBe(true);
        expect(map.check('charlie', 'user@evil.host')).toBe(true);
        expect(map.check('bob', 'any@any')).toBe(true);
        expect(map.check('dave')).toBe(false);
    });

    it('strips ~ident prefix on both parse and check', () => {
        const map = new IgnoreMap();
        map.parse(['*!~user@host']);
        // ~ is stripped from user on both sides: stored user = 'user', checked user = 'user'
        expect(map.check('nick', '~user@host')).toBe(true);
        expect(map.check('nick', 'user@host')).toBe(true);
    });

    it('matches bare nick against upgraded pattern', () => {
        // bare-nick 'bob' → upgraded to 'bob!*@*'
        const map = parseIgnoreList(['bob']);
        expect(map.check('bob', 'user@any.host')).toBe(true);
        expect(map.check('notbob', 'user@any.host')).toBe(false);
    });
});

describe('upgradeLegacyPattern', () => {
    it('upgrades pure bare nick to *!*@*', () => {
        const result = upgradeLegacyPattern('bob');
        expect(result).toBe('bob!*@*');
    });

    it('preserves patterns with separators', () => {
        const result = upgradeLegacyPattern('alice!*@*');
        expect(result).toBe('alice!*@*');
    });

    it('preserves patterns with wildcards', () => {
        const result = upgradeLegacyPattern('evil*');
        expect(result).toBe('evil*');
    });

    it('preserves patterns with both separators and wildcards', () => {
        const result = upgradeLegacyPattern('evil*!user@host');
        expect(result).toBe('evil*!user@host');
    });

    it('preserves patterns with ? wildcard', () => {
        const result = upgradeLegacyPattern('evil?');
        expect(result).toBe('evil?');
    });

    it('preserves patterns with @ but no wildcard', () => {
        const result = upgradeLegacyPattern('user@host');
        expect(result).toBe('user@host');
    });
});

describe('parseIgnoreList', () => {
    it('returns an IgnoreMap instance', () => {
        const map = parseIgnoreList([]);
        expect(map).toBeInstanceOf(IgnoreMap);
    });

    it('creates empty map from empty list', () => {
        const map = parseIgnoreList([]);
        expect(map.check('anyone')).toBe(false);
    });
});
