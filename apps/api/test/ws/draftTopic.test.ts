import { describe, it, expect } from 'vitest';
import {
  topicKey,
  channelToTopicKey,
  draftChannel,
} from '../../src/ws/topics.js';

// The draft board is fanned out only if the publisher's channel maps back to the
// exact TopicKey a subscriber registered. A drift between these two would drop
// every draft event silently (no test failure elsewhere), so pin the round-trip.
describe('draft WS topic routing', () => {
  it('round-trips topicKey ↔ channel for a league draft', () => {
    const leagueId = '11111111-2222-3333-4444-555555555555';
    const key = topicKey({ kind: 'draft', leagueId });
    expect(key).toBe(`draft:${leagueId}`);
    expect(channelToTopicKey(draftChannel(leagueId))).toBe(key);
  });

  it('keeps different leagues on isolated keys', () => {
    const a = topicKey({ kind: 'draft', leagueId: 'a' });
    const b = topicKey({ kind: 'draft', leagueId: 'b' });
    expect(a).not.toBe(b);
    expect(channelToTopicKey(draftChannel('a'))).toBe(a);
  });

  it('still maps the static channels and ignores unknown ones', () => {
    expect(channelToTopicKey('ws:universe')).toBe('universe');
    expect(channelToTopicKey('ws:prices')).toBe('prices');
    expect(channelToTopicKey('ws:nope')).toBeNull();
  });
});
