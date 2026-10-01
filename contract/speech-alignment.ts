/** Provider seconds refer to concatenated PCM, not socket arrival time. */
export interface SpeechAlignment {
  chunk: number;
  offset: number;
  content: string;
  duration: number;
  words: { text: string; start: number; end: number }[];
}

export function speechAlignment(value: Record<string, unknown>): SpeechAlignment | undefined {
  const alignment = value.alignment as Record<string, unknown> | null;
  if (!alignment || typeof alignment !== 'object' || !Array.isArray(alignment.segments)) return;
  const { chunk_seq: chunk, chunk_audio_offset_sec: offset, content } = value;
  const duration = alignment.audio_duration;
  if (!Number.isSafeInteger(chunk) || (chunk as number) < 0 || typeof offset !== 'number' || !Number.isFinite(offset) || offset < 0 ||
      typeof content !== 'string' || content.length > 16000 || typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0 || duration > 600 || alignment.segments.length > 2048) return;
  const words: SpeechAlignment['words'] = [];
  for (const item of alignment.segments) {
    if (!item || typeof item !== 'object') return;
    const { text, start, end } = item as Record<string, unknown>;
    if (typeof text !== 'string' || text.length > 500 || typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end > duration + 1) return;
    words.push({ text, start, end });
  }
  return { chunk: chunk as number, offset, content, duration, words };
}
