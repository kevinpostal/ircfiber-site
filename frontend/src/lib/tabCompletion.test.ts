import { describe, it, expect } from 'vitest';
import { TabCompletionEngine } from './tabCompletion';
import type { Member, TabCompletionCandidate } from '../types';

describe('TabCompletionEngine', () => {
  const make_member = (nick: string, lastSpoke = 0, lastHighlighted = 0): Member => ({
    nick,
    prefix: '',
    category: 'MEMBER',
    ident: '',
    realname: '',
    isAway: false,
    awayMessage: '',
    lastSpoke,
    lastHighlighted,
    account: '',
    isBot: false,
  });

  const make_engine = () => new TabCompletionEngine();

  describe('getCandidates', () => {
    it('completes nicks from member list', () => {
      const engine = make_engine();
      const members: Member[] = [
        make_member('alice'),
        make_member('bob'),
        make_member('charlie'),
      ];
      const candidates = engine.getCandidates('ali', 3, members, [], 'me');
      expect(candidates).toHaveLength(1);
      expect(candidates[0].value).toBe('alice');
      expect(candidates[0].type).toBe('nick');
    });

    it('completes channels with # prefix', () => {
      const engine = make_engine();
      const buffers = ['#general', '#random', '#development'];
      const candidates = engine.getCandidates('#dev', 4, [], buffers, 'me');
      expect(candidates).toHaveLength(1);
      expect(candidates[0].value).toBe('#development');
      expect(candidates[0].type).toBe('channel');
    });

    it('completes commands with / prefix', () => {
      const engine = make_engine();
      const candidates = engine.getCandidates('/jo', 3, [], [], 'me');
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates[0].type).toBe('command');
      expect(candidates.some(c => c.value === '/join')).toBe(true);
    });

    it('completes emoji with : prefix', () => {
      const engine = make_engine();
      const candidates = engine.getCandidates(':smi', 4, [], [], 'me');
      expect(candidates).toHaveLength(0);
    });

    it('filters by partial match', () => {
      const engine = make_engine();
      const members: Member[] = [
        make_member('alice'),
        make_member('alex'),
        make_member('bob'),
      ];
      const candidates = engine.getCandidates('al', 2, members, [], 'me');
      expect(candidates).toHaveLength(2);
      expect(candidates.map(c => c.value)).toContain('alice');
      expect(candidates.map(c => c.value)).toContain('alex');
    });

    it('excludes own nick from completion', () => {
      const engine = make_engine();
      const members: Member[] = [
        make_member('alice'),
        make_member('me'),
      ];
      const candidates = engine.getCandidates('m', 1, members, [], 'me');
      expect(candidates.map(c => c.value)).not.toContain('me');
    });

    it('strips mode prefixes before matching', () => {
      const engine = make_engine();
      const members: Member[] = [
        make_member('@alice'),
        make_member('+bob'),
      ];
      const candidates = engine.getCandidates('al', 2, members, [], 'me');
      expect(candidates).toHaveLength(1);
      expect(candidates[0].value).toBe('alice');
    });

    it('returns empty array when no match', () => {
      const engine = make_engine();
      const members: Member[] = [make_member('alice')];
      const candidates = engine.getCandidates('zzz', 3, members, [], 'me');
      expect(candidates).toHaveLength(0);
    });

    it('returns empty array for empty word', () => {
      const engine = make_engine();
      const candidates = engine.getCandidates('hello ', 6, [], [], 'me');
      expect(candidates).toHaveLength(0);
    });
  });

  describe('apply', () => {
    it('adds ": " for nick at start of line', () => {
      const engine = make_engine();
      const members: Member[] = [make_member('alice')];
      engine.getCandidates('ali', 3, members, [], 'me');
      const candidate: TabCompletionCandidate = { value: 'alice', type: 'nick' };
      const result = engine.apply('ali', candidate);
      expect(result.text).toBe('alice: ');
      expect(result.cursor).toBe(7);
    });

    it('adds " " for nick mid-line', () => {
      const engine = make_engine();
      const members: Member[] = [make_member('alice')];
      engine.getCandidates('hello ali', 9, members, [], 'me');
      const candidate: TabCompletionCandidate = { value: 'alice', type: 'nick' };
      const result = engine.apply('hello ali', candidate);
      expect(result.text).toBe('hello alice ');
      expect(result.cursor).toBe(12);
    });

    it('adds " " for command completion', () => {
      const engine = make_engine();
      engine.getCandidates('/jo', 3, [], [], 'me');
      const candidate: TabCompletionCandidate = { value: '/join', type: 'command' };
      const result = engine.apply('/jo', candidate);
      expect(result.text).toBe('/join ');
      expect(result.cursor).toBe(6);
    });
  });

  describe('cycle', () => {
    it('cycles forward through candidates', () => {
      const engine = make_engine();
      const candidates: TabCompletionCandidate[] = [
        { value: 'alice', type: 'nick' },
        { value: 'alex', type: 'nick' },
      ];
      engine.setCandidates(candidates);
      expect(engine.cycle(1)?.value).toBe('alice');
      expect(engine.cycle(1)?.value).toBe('alex');
      expect(engine.cycle(1)?.value).toBe('alice');
    });

    it('cycles backward through candidates', () => {
      const engine = make_engine();
      const candidates: TabCompletionCandidate[] = [
        { value: 'alice', type: 'nick' },
        { value: 'alex', type: 'nick' },
      ];
      engine.setCandidates(candidates);
      expect(engine.cycle(-1)?.value).toBe('alex');
      expect(engine.cycle(-1)?.value).toBe('alice');
      expect(engine.cycle(-1)?.value).toBe('alex');
    });

    it('returns null when no candidates', () => {
      const engine = make_engine();
      expect(engine.cycle(1)).toBeNull();
    });
  });

  describe('setCandidates', () => {
    it('sets candidates and resets index', () => {
      const engine = make_engine();
      const candidates: TabCompletionCandidate[] = [
        { value: 'alice', type: 'nick' },
      ];
      engine.setCandidates(candidates);
      expect(engine.cycle(1)?.value).toBe('alice');
    });
  });

  describe('reset', () => {
    it('clears all state', () => {
      const engine = make_engine();
      const candidates: TabCompletionCandidate[] = [
        { value: 'alice', type: 'nick' },
      ];
      engine.setCandidates(candidates);
      engine.reset();
      expect(engine.cycle(1)).toBeNull();
    });
  });
});
