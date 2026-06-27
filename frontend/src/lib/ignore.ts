// ── Ignore Map (3-level host→user→nick) ──
// Port of IRCCloud ignore.js with plain Map/Set instead of safe-key-object.
// Host → User → Set<Nick> lookup, walking wildcards at each level.

export interface IgnoreEntry {
    host?: string;
    user?: string;
    nick?: string;
}

export class IgnoreMap {
    private root: Map<string, Map<string, Set<string>>> = new Map();

    /** Parse a list of ignore patterns into the 3-level map. */
    parse(patterns: string[]): void {
        for (const pattern of patterns) {
            let host = '*';
            let user = '*';
            let nick = '*';

            // Split on @ first (per IRCCloud ignore.js:69-93)
            const atParts = pattern.split('@');
            if (atParts.length === 2) {
                host = atParts[1];
                const bangParts = atParts[0].split('!');
                if (bangParts.length === 2) {
                    nick = bangParts[0];
                    user = bangParts[1];
                } else {
                    // *@host or user@host (no bang) → left side is user
                    user = atParts[0];
                }
            } else {
                const bangParts = pattern.split('!');
                if (bangParts.length === 2) {
                    nick = bangParts[0];
                    host = bangParts[1];
                } else {
                    // Pure bare nick (or preserved wildcard pattern)
                    nick = pattern;
                }
            }

            // Strip leading ~ from ident (IRC convention)
            user = user.replace(/^~/, '');

            const nickL = nick.toLowerCase();
            const userL = user.toLowerCase();
            const hostL = host.toLowerCase();

            // Ensure nested maps
            if (!this.root.has(hostL)) {
                this.root.set(hostL, new Map());
            }
            const userMap = this.root.get(hostL)!;
            if (!userMap.has(userL)) {
                userMap.set(userL, new Set());
            }
            userMap.get(userL)!.add(nickL);
        }
    }

    /**
     * Check if a nick (+ optional user@host) matches any ignore pattern.
     *
     * Walks host → user → nick through exact matches, IRC `*` wildcards, and
     * catch-all `*` at each level, per IRCCloud ignore.js.
     */
    check(target: string, hostmask?: string): boolean {
        if (!target) return false;
        target = target.toLowerCase();

        // Parse hostmask (format: user@host)
        let user: string;
        let host: string;
        if (hostmask) {
            const atIdx = hostmask.indexOf('@');
            if (atIdx >= 0) {
                user = hostmask.slice(0, atIdx).replace(/^~/, '').toLowerCase();
                host = hostmask.slice(atIdx + 1).toLowerCase();
            } else {
                user = hostmask.toLowerCase();
                host = '*';
            }
        } else {
            user = '*';
            host = '*';
        }

        // Level 1: collect matching host maps
        const hostMaps = this.collectMaps(this.root, host);
        for (const userMap of hostMaps) {
            // Level 2: collect matching user sets
            const nickSets = this.collectMaps(userMap, user);
            for (const nickSet of nickSets) {
                // Level 3: exact nick match, any-nick wildcard, or IRC wildcard pattern
                if (nickSet.has(target)) return true;
                if (nickSet.has('*')) return true;
                for (const pattern of nickSet) {
                    if (pattern.includes('*') || pattern.includes('?')) {
                        if (this.checkWildcard(pattern, target)) return true;
                    }
                }
            }
        }
        return false;
    }

    /**
     * Collect map values matching a token: exact match first, then IRC wildcard
     * matches, then `*` catch-all.
     */
    private collectMaps<V>(map: Map<string, V>, token: string): V[] {
        const exact: V[] = [];
        const wildcard: V[] = [];
        const any: V[] = [];

        for (const [key, val] of map) {
            if (key === token) {
                exact.push(val);
            } else if (key === '*') {
                any.push(val);
            } else if (this.checkWildcard(key, token)) {
                wildcard.push(val);
            }
        }

        return [...exact, ...wildcard, ...any];
    }

    /**
     * IRC `*` wildcard matching (mirrors IRCCloud ignore.js checkWildcard).
     * Treats `*` as matching any sequence after escaping regex metacharacters.
     * Bare `*` (length <= 1) is excluded — handled via catch-all above.
     */
    private checkWildcard(ptrn: string, token: string): boolean {
        if (ptrn.length <= 1 || (!ptrn.includes('*') && !ptrn.includes('?'))) return false;
        const escaped = ptrn
            .replace(/[-[\]{}()+.,\\^$|#\s]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.');
        return new RegExp('^' + escaped + '$', 'i').test(token);
    }
}

/**
 * C1 critic fix heuristic: upgrade legacy bare-nick patterns to `*!*@*` masks.
 *
 * Patterns with `!`, `@`, `*`, or `?` are preserved as-is.
 * Pure bare nicks (no separator, no wildcard) are upgraded to `nick!*@*`
 * so the 3-level map treats them as nick-level matches.
 */
export function upgradeLegacyPattern(pattern: string): string {
    const hasSeparator = pattern.includes('!') || pattern.includes('@');
    const hasWildcard = pattern.includes('*') || pattern.includes('?');
    if (!hasSeparator && !hasWildcard) {
        console.debug('[Ignore] upgrading bare nick pattern:', pattern);
        return pattern + '!*@*';
    }
    return pattern;
}

/** Create an IgnoreMap from a list of patterns, upgrading legacy patterns first. */
export function parseIgnoreList(patterns: string[]): IgnoreMap {
    const map = new IgnoreMap();
    const upgraded = patterns.map((p) => upgradeLegacyPattern(p));
    map.parse(upgraded);
    return map;
}
