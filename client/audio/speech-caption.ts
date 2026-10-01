import type { SpeechAlignment } from '../../contract/speech-alignment';

export function textWords(text: string) {
  return [...text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)].map(match => ({
    key: match[0].toLocaleLowerCase('en-US').replace(/’/g, "'"), start: match.index, end: match.index + match[0].length,
  }));
}

/** Map a spoken prefix to the original Markdown without rewriting history.
 * A replacement of already spoken words cannot be aligned: show it in full. */
export function replyPrefix(source: string, spoken: string): string {
  const raw = textWords(source), said = textWords(spoken);
  if (!said.length) return '';
  if (said.some((word, index) => raw[index]?.key !== word.key)) return source;
  const next = raw[said.length];
  // Include punctuation and closing emphasis, leaving the next word untouched.
  return source.slice(0, next?.start ?? source.length).trimEnd();
}

/** Cumulative alignment snapshots are replaced by chunk, never appended. Late
 * corrections cannot rewind words already displayed. No synthetic word timer. */
export class SpeechCaptionTimeline {
  private text = '';
  private chunks = new Map<number, { alignment: SpeechAlignment; start: number; end: number; closed: boolean }>();
  private revealed = 0;
  append(text: string) { this.text += (this.text ? ' ' : '') + text.trim(); }
  update(alignment: SpeechAlignment) {
    const previous = this.chunks.get(alignment.chunk);
    if (previous) { previous.alignment = alignment; return; }
    if (this.chunks.size >= 2048) return;
    const last = [...this.chunks.values()].at(-1);
    const from = last?.end ?? 0;
    // Provider content excludes delivery cues. Locate it in the actual TTS text,
    // allowing whitespace/punctuation normalization but no invented words.
    const source = textWords(this.text.slice(from)), content = textWords(alignment.content);
    let index = -1;
    if (content.length) index = source.findIndex((_, at) => content.every((word, n) => source[at + n]?.key === word.key));
    if (index < 0) return;
    const start = from + source[index]!.start;
    const end = from + source[index + content.length - 1]!.end;
    if (last) last.closed = true;
    this.chunks.set(alignment.chunk, { alignment, start, end, closed: false });
  }
  finish() { for (const chunk of this.chunks.values()) chunk.closed = true; }
  /** PCM offset is supplied by the player, including underruns and suspension. */
  sample(audioSeconds: number): string | undefined {
    let end = this.revealed;
    for (const chunk of this.chunks.values()) {
      if (chunk.end <= this.revealed) continue;
      const { alignment, start } = chunk;
      const content = textWords(this.text.slice(start, chunk.end));
      let cursor = 0;
      for (const word of alignment.words) {
        const keys = textWords(word.text);
        const at = content.findIndex((_, n) => n >= cursor && keys.length > 0 && keys.every((key, i) => content[n + i]?.key === key.key));
        if (at < 0) continue; // e.g. a provider verbalized a numeral; no guessed timestamps
        cursor = at + keys.length;
        if (alignment.offset + word.start <= audioSeconds) end = Math.max(end, start + content[cursor - 1]!.end);
      }
      // Unaligned punctuation/numerals still become readable at the known end
      // of their completed audio chunk, without holding back playback.
      if (chunk.closed && alignment.offset + alignment.duration <= audioSeconds) end = Math.max(end, chunk.end);
    }
    if (end <= this.revealed) return;
    this.revealed = end;
    return this.text.slice(0, end);
  }
}
