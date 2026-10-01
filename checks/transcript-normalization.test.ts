import { describe, expect, it } from 'vitest';
import { createTranscriptNormalizer, transcriptRulesError } from '../contract/transcript-normalization';
import { Transcript } from '../client/audio/dsp';

describe('transcript normalization', () => {
  it('corrects names regardless of capitalization at phrase boundaries and preserves clear geographic uses', () => {
    const normalize = createTranscriptNormalizer();
    expect(normalize('Ask North Point, then North Point’s pastor.')).toBe('Ask NorthPointe, then NorthPointe’s pastor.');
    expect(normalize('north point church, north pointe church, North point church, North Pointe church, NORTH POINT church.')).toBe('NorthPointe church, NorthPointe church, NorthPointe church, NorthPointe church, NorthPointe church.');
    for (const text of ['the north point of the map', 'North Point on a compass', 'the map’s north point', 'the north point of the island', 'North Pointer', 'MyNorth Point', 'North Point2', 'éNorth Point', 'North Pointé', 'North Point\u0301', 'NorthPointe', 'point north']) expect(normalize(text)).toBe(text);
    expect(normalize('Ask North\nPoint')).toBe('Ask NorthPointe');
  });
  it('uses church wording related to the particular name occurrence', () => {
    const normalize = createTranscriptNormalizer();
    for (const text of ['We worship at north point.', 'We worship together at north point.', 'Sunday service at north point starts at ten.', 'The pastor at north point shared a sermon.', 'The sermon from north point is ready.', 'My church is north point.', 'Our church is called north point.', 'I go to north point for church.', 'north point is our church.', 'north point hosts Sunday services.', 'north point holds weekly worship services.', 'north point’s pastor called.']) {
      expect(normalize(text)).toBe(text.replace('north point', 'NorthPointe'));
    }
  });
  it('recognizes direct address and agent references', () => {
    const normalize = createTranscriptNormalizer();
    for (const text of ['Hey north point.', 'Hey, north point.', 'Thanks north point.', 'Ask north point about my notes.', 'Tell north point to find the file.', 'north point, can you help?', 'north point please find my notes.', 'north point, I need help.', 'My agent is north point.', 'The assistant named north point replied.', 'north point is my agent.', 'north point’s reply is ready.']) {
      expect(normalize(text)).toBe(text.replace('north point', 'NorthPointe'));
    }
  });
  it('preserves geographic and ambiguous phrases even when a church or agent is mentioned elsewhere', () => {
    const normalize = createTranscriptNormalizer();
    for (const text of ['north point', 'I am going to north point.', 'north point on Sunday.', 'The church is near the north point.', 'The church is at the north point of the island.', 'The pastor described the north point of the map.', 'We worship at the north point of the compass.', 'Find the north point while we talk about church.', 'The sermon was about the north point.', 'We met at the north point during the church service.', 'The church discussed north point.', 'The north point, can you find it?', 'North point. Church is tomorrow.', 'Ask about the north point.']) expect(normalize(text)).toBe(text);
    expect(normalize('Hey north point, show me the north point on the map.')).toBe('Hey NorthPointe, show me the north point on the map.');
    expect(normalize('We worship at north point and walk to the north point.')).toBe('We worship at NorthPointe and walk to the north point.');
    expect(normalize('north point church is near north point.')).toBe('NorthPointe church is near north point.');
    expect(normalize('Ask north point about north point.')).toBe('Ask NorthPointe about north point.');
  });
  it('lets the owner explicitly select every phrase instead of name context', () => {
    const normalize = createTranscriptNormalizer([{ from: 'north point', to: 'NorthPointe', context: 'any' }]);
    expect(normalize('north point on the map')).toBe('NorthPointe on the map');
    expect(createTranscriptNormalizer([{ from: 'north point', to: 'NorthPointe' }])('north point')).toBe('north point');
  });
  it('handles segment boundaries and revisable partial hypotheses without changing stored raw speech', () => {
    const transcript = new Transcript(), normalize = createTranscriptNormalizer();
    transcript.update('Ask North', true);
    expect(normalize(transcript.update('Point', false))).toBe('Ask NorthPointe');
    expect(normalize(transcript.update('Pointer', false))).toBe('Ask North Pointer');
    transcript.update('Point', true);
    expect(transcript.stable).toBe('Ask North Point');
    expect(normalize(transcript.take())).toBe('Ask NorthPointe');
  });
  it('supports edits, removal, literal punctuation and a single replacement pass', () => {
    expect(createTranscriptNormalizer([])('North Point')).toBe('North Point');
    const normalize = createTranscriptNormalizer([{ from: 'North Point', to: 'NorthPointe', context: 'any' }, { from: 'NorthPointe', to: 'Other' }, { from: 'C++', to: 'C plus plus' }, { from: 'A.B', to: '$&' }]);
    expect(normalize('North Point and NorthPointe; C++ and A.B.')).toBe('NorthPointe and Other; C plus plus and $&.');
    expect(normalize('AxB')).toBe('AxB');
    expect(createTranscriptNormalizer([{ from: 'North', to: 'N' }, { from: 'North Point', to: 'NorthPointe', context: 'any' }])('North Point')).toBe('NorthPointe');
  });
  it('rejects incomplete, oversized and ambiguous lists', () => {
    expect(transcriptRulesError([])).toBeNull();
    expect(transcriptRulesError([{ from: ' ', to: 'Name' }])).toContain('both spellings');
    expect(transcriptRulesError([{ from: 'Name', to: 'x'.repeat(81) }])).toContain('80');
    expect(transcriptRulesError([{ from: 'North Point', to: 'One' }, { from: ' North  Point ', to: 'Two' }])).toContain('single');
    expect(transcriptRulesError([{ from: 'north point', to: 'One' }, { from: 'North Point', to: 'Two' }])).toContain('single');
    expect(transcriptRulesError(Array.from({ length: 21 }, (_, i) => ({ from: `Name ${i}`, to: 'Name' })))).toContain('20');
  });
});
