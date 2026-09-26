/** Presentation syntax is removed only from a speech chunk, never its source text. */
export function speechText(text: string): string {
  const plain = (value: string) => value
    .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, '')
    .replace(/^[ \t]*#{1,6}[ \t]+|^[ \t]*>[ \t]+/gm, '')
    .replace(/^[ \t]*[-+*][ \t]+(?:\[[ xX]\][ \t]+)?/gm, '')
    .replace(/\*{1,3}|_{1,3}|~~/g, (marker: string, offset: number, source: string) => {
      const before = source[offset - 1] || '', after = source[offset + marker.length] || '';
      // Preserve identifiers and arithmetic; these are meaningful characters.
      if (marker.startsWith('_') && /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after)) return marker;
      if (marker.startsWith('*') && /\d/.test(before) && /\d/.test(after)) return marker;
      if (before && after && /\s/.test(before) && /\s/.test(after)) return marker;
      return '';
    });
  // Explicit code and escaped symbols are literal content, not emphasis.
  let result = '', offset = 0;
  for (const token of text.matchAll(/(`+)([^`]+?)\1|\\([\\`*_~])/g)) {
    result += plain(text.slice(offset, token.index)) + (token[3] ?? token[2]);
    offset = token.index + token[0].length;
  }
  return (result + plain(text.slice(offset))).trim();
}
