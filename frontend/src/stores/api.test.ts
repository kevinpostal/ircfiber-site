import { describe, expect, it } from 'vitest';
import { normalizeMessage } from './api';

describe('normalizeMessage', () => {
  it('unpacks the engine wire format (compact JSON) into IRCMessage fields', () => {
    // The exact shape produced by IRCRawEvent.toCompactJson in D — keys
    // are short (`i`, `x`, `c`, `n`, ...) because the engine optimizes
    // for wire size on the hot path.
    const raw = {
      i: 'e51274a4-fa45-446f-ad50-b35e5be4b756',
      t: 1782759012000,
      eid: 69853,
      x: 'Queued — waiting for holder daemon connection',
      network: 'IRC Fiber',
      phase: 'queued',
      c: 'NOTICE',
      m: 'e51274a4-fa45-446f-ad50-b35e5be4b756',
    };
    const msg = normalizeMessage(raw);
    expect(msg.id).toBe('e51274a4-fa45-446f-ad50-b35e5be4b756');
    expect(msg.text).toBe('Queued — waiting for holder daemon connection');
    expect(msg.command).toBe('NOTICE');
    expect(msg.phase).toBe('queued');
    expect(msg.t).toBe(1782759012000);
    expect(msg.eid).toBe(69853);
    expect(msg.msgid).toBe('e51274a4-fa45-446f-ad50-b35e5be4b756');
  });

  it('accepts the long-form REST history keys', () => {
    // REST-loaded messages use the camelCase field names (`id`,
    // `command`, `text`, `nick`, ...) directly. The normalizer must
    // accept that shape too, mirroring what loadHistoryWithMeta passes
    // through.
    const raw = {
      id: 'abc',
      t: 1700000000000,
      eid: 1,
      text: 'hello from long-form',
      command: 'PRIVMSG',
      nick: 'alice',
      msgid: 'msg-1',
      phase: 'queued',
    };
    const msg = normalizeMessage(raw);
    expect(msg.text).toBe('hello from long-form');
    expect(msg.command).toBe('PRIVMSG');
    expect(msg.nick).toBe('alice');
    expect(msg.phase).toBe('queued');
  });

  it('is idempotent — calling on an already-normalized IRCMessage yields an equivalent', () => {
    const once = normalizeMessage({
      i: 'id1', t: 100, eid: 1, x: 'body', c: 'NOTICE', phase: 'tcp_open', m: 'msgid1',
    });
    const twice = normalizeMessage(once as unknown as Record<string, unknown>);
    expect(twice.text).toBe(once.text);
    expect(twice.command).toBe(once.command);
    expect(twice.phase).toBe(once.phase);
    expect(twice.eid).toBe(once.eid);
    expect(twice.msgid).toBe(once.msgid);
  });

  it('extracts phase from tags.phase when the inlined field is absent', () => {
    const raw = {
      i: 'id1', t: 100, eid: 1, x: 'body', c: 'NOTICE',
      tags: { phase: 'welcome' },
    };
    const msg = normalizeMessage(raw);
    expect(msg.phase).toBe('welcome');
  });

  it('prefers inline phase over tags.phase when both are present', () => {
    const raw = {
      i: 'id1', t: 100, eid: 1, x: 'body', c: 'NOTICE',
      phase: 'queued',
      tags: { phase: 'welcome' },
    };
    const msg = normalizeMessage(raw);
    expect(msg.phase).toBe('queued');
  });

  it('falls back from text → x → undefined when neither matches', () => {
    expect(normalizeMessage({ c: 'NOTICE' }).text).toBeUndefined();
    expect(normalizeMessage({ x: 'from x' }).text).toBe('from x');
    expect(normalizeMessage({ text: 'from text', x: 'from x' }).text).toBe('from text');
  });

  it('preserves params and prefix from either format', () => {
    expect(normalizeMessage({ c: '001', p: ['nick', 'welcome'] }).params).toEqual(['nick', 'welcome']);
    expect(normalizeMessage({ command: '001', params: ['nick', 'welcome'] }).params).toEqual(['nick', 'welcome']);
    expect(normalizeMessage({ px: 'irc.example.com' }).prefix).toBe('irc.example.com');
    expect(normalizeMessage({ prefix: 'irc.example.com' }).prefix).toBe('irc.example.com');
  });

  it('selfEcho is true when `se` is set on the wire-format message', () => {
    expect(normalizeMessage({ c: 'PRIVMSG', x: 'echo', se: '1' }).selfEcho).toBe(true);
    expect(normalizeMessage({ c: 'PRIVMSG', x: 'echo', selfEcho: true }).selfEcho).toBe(true);
    expect(normalizeMessage({ c: 'PRIVMSG', x: 'echo' }).selfEcho).toBe(false);
  });

  it('keeps eid as undefined for legacy messages with a 0 eid', () => {
    // The engine writes eid = 0 for legacy Redis scrollback entries
    // predating the IRCCloud-style eid counter. normalizeMessage treats
    // those as "no eid" so the dedup sets in appendMessage/prependMessages
    // skip the eid branch and rely on msgid / t + content-hash instead.
    expect(normalizeMessage({ c: 'PRIVMSG', x: 'legacy', eid: 0 }).eid).toBeUndefined();
    expect(normalizeMessage({ c: 'PRIVMSG', x: 'modern', eid: 12345 }).eid).toBe(12345);
  });

  it('strips \x01ACTION ...\x01 CTCP markers from PRIVMSG text', () => {
    const raw = { c: 'PRIVMSG', x: '\x01ACTION waves\x01' };
    const msg = normalizeMessage(raw);
    expect(msg.text).toBe('waves');
    expect(msg.type).toBe('action');
  });

  it('does NOT touch text for non-PRIVMSG messages containing \x01', () => {
    // Server NOTICEs with binary content would survive unchanged. We
    // only unwrap ACTION for PRIVMSG (mirroring lib/messageHandler.ts).
    const raw = { c: 'NOTICE', x: '\x01VERSION\x01' };
    const msg = normalizeMessage(raw);
    expect(msg.text).toBe('\x01VERSION\x01');
    expect(msg.type).toBeUndefined();
  });
});
