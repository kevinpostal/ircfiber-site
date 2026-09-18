import { describe, it, expect } from 'vitest';
import { parseYoutubeInfoMessage } from './youtubePlayerBridge';

describe('parseYoutubeInfoMessage', () => {
  it('extracts currentTime and playerState from infoDelivery', () => {
    const data = JSON.stringify({ event: 'infoDelivery', info: { currentTime: 12.5, playerState: 1 } });
    expect(parseYoutubeInfoMessage(data)).toEqual({ currentTime: 12.5, playerState: 1 });
  });
  it('ignores other events', () => {
    expect(parseYoutubeInfoMessage('{"event":"onReady"}')).toBeNull();
  });
  it('ignores non-JSON', () => {
    expect(parseYoutubeInfoMessage('not json')).toBeNull();
  });
  it('ignores non-string payloads', () => {
    expect(parseYoutubeInfoMessage({ event: 'infoDelivery', info: {} })).toBeNull();
  });
});
