type Character = { text: string; speech?: number };

function changeBetween(before: string, after: string) {
  let start = 0, oldEnd = before.length, newEnd = after.length;
  while (start < oldEnd && start < newEnd && before[start] === after[start]) start++;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  return { start, oldEnd, newEnd };
}

/** One editable message; recognition may revise its own characters, never typed additions. */
export class VoiceMessageDraft {
  private characters: Character[];
  private hypothesis = '';
  private anchor: number;

  constructor(typed: string) {
    this.characters = typed.split('').map(text => ({ text }));
    this.anchor = typed.length;
  }

  get text() { return this.characters.map(character => character.text).join(''); }

  recognize(text: string) {
    if (text === this.hypothesis) return this.text;
    if (!this.hypothesis && this.anchor && !/\s/.test(this.characters[this.anchor - 1]!.text)) {
      this.characters.splice(this.anchor++, 0, { text: '\n' });
    }
    const { start, oldEnd, newEnd } = changeBetween(this.hypothesis, text);
    let insertion = this.characters.findIndex(character => character.speech !== undefined && character.speech >= start);
    if (insertion < 0) {
      const last = this.characters.findLastIndex(character => character.speech !== undefined);
      insertion = last < 0 ? this.anchor : last + 1;
    }
    const retain = (characters: Character[]) => characters.flatMap(character => {
      if (character.speech === undefined || character.speech < start) return [character];
      if (character.speech < oldEnd) return [];
      return [{ ...character, speech: character.speech + newEnd - oldEnd }];
    });
    this.characters = [
      ...retain(this.characters.slice(0, insertion)),
      ...text.slice(start, newEnd).split('').map((character, offset) => ({ text: character, speech: start + offset })),
      ...retain(this.characters.slice(insertion)),
    ];
    this.hypothesis = text;
    return this.text;
  }

  edit(text: string) {
    const { start, oldEnd, newEnd } = changeBetween(this.text, text);
    if (oldEnd <= this.anchor) this.anchor += newEnd - oldEnd;
    else if (start < this.anchor) this.anchor = newEnd;
    this.characters.splice(start, oldEnd - start, ...text.slice(start, newEnd).split('').map(character => ({ text: character })));
    return this.text;
  }
}
