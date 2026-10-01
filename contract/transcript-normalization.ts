export interface TranscriptNormalizationRule { from: string; to: string; context?: 'name' | 'any'; }
export const MAX_TRANSCRIPT_RULES = 20;
export const MAX_TRANSCRIPT_SPELLING = 80;
export const DEFAULT_TRANSCRIPT_RULES: TranscriptNormalizationRule[] = [
  { from: 'north point', to: 'NorthPointe', context: 'name' },
  { from: 'north pointe', to: 'NorthPointe', context: 'name' },
];

const spellingKey = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();
/** Existing NorthPointe spelling entries also acquire the conservative context gate. */
export function transcriptRuleContext(rule: TranscriptNormalizationRule): 'name' | 'any' {
  return rule.context ?? (/^north point[e]?$/.test(spellingKey(rule.from)) ? 'name' : 'any');
}

const directionPoint = /^(?:north|south|east|west|northeast|northwest|southeast|southwest) point[e]?$/;
const geographicObject = '(?:map|compass|diagram|chart|island|peninsula|coast|lake|land|triangle|rectangle|polygon|star|shape|circle|boundary|trail|route|field|grid|globe)';
const geographicAfter = new RegExp(`^\\s+(?:of|on|in)\\s+(?:(?:the|a|an|this|that|our|your)\\s+)?${geographicObject}\\b`, 'i');
const geographicBefore = new RegExp(`${geographicObject}(?:['’]s)?\\s*$`, 'i');
const CONTEXT_CHARACTERS = 180;

function nearbyText(text: string, match: string, offset: number) {
  return {
    before: text.slice(Math.max(0, offset - CONTEXT_CHARACTERS), offset),
    after: text.slice(offset + match.length, offset + match.length + CONTEXT_CHARACTERS),
  };
}

/** A deterministic guard for clear directional descriptions, not a semantic classifier. */
function geographicUse(text: string, match: string, offset: number) {
  if (!directionPoint.test(spellingKey(match))) return false;
  const { before, after } = nearbyText(text, match, offset);
  return geographicAfter.test(after) || geographicBefore.test(before);
}

const churchNoun = '(?:church|congregation|pastor|ministr(?:y|ies)|sermons?|worship|bible study|sunday school|sunday service|church service)';
// Require a relationship to this occurrence, rather than a church keyword anywhere in the sentence.
const churchBefore = new RegExp(`(?:\\b${churchNoun}\\s+(?:(?:is|named|called)\\s+){0,2}|\\b${churchNoun}\\s+(?:(?:together|services?)\\s+)?(?:at|from|with|for|of)\\s+(?:the\\s+)?)$`, 'i');
const churchAfter = new RegExp(`^(?:['’]s)?\\s*(?:${churchNoun}\\b|(?:is|was)\\s+(?:(?:a|the|our|my|your|their|local)\\s+)?${churchNoun}\\b|(?:for|at)\\s+(?:(?:a|the|our|my|your|their)\\s+)?${churchNoun}\\b|(?:holds?|hosts?|offers?)\\s+(?:(?:a|the|our|weekly|sunday)\\s+){0,2}(?:worship|services?|bible study)\\b|(?:we|they|i)\\s+(?:worship|pray)\\b)`, 'i');
const clauseBoundary = /[.!?;\n]|,|\b(?:and|but|then|while|whereas)\b/gi;

function churchUse(text: string, match: string, offset: number) {
  if (geographicUse(text, match, offset)) return false;
  // Keep evidence in the same clause. A different church mention must not label a geographic occurrence.
  const nearby = nearbyText(text, match, offset);
  const before = nearby.before.split(clauseBoundary).at(-1) || '';
  const after = nearby.after.split(clauseBoundary)[0] || '';
  return churchBefore.test(before) || churchAfter.test(after);
}

const agentNoun = '(?:agent|assistant|ai agent|ai assistant|reply|replies|answer|response|instructions|tools|chat|conversation|memory)';
const agentBefore = new RegExp(`(?:\\b(?:hey|hi|hello|okay|ok|thanks|thank you|ask|tell|message|contact|call)\\s*[,!]?\\s+|\\b(?:agent|assistant)\\s+(?:(?:is|named|called)\\s+){0,2})$`, 'i');
const agentAfter = new RegExp(`^(?:['’]s)?\\s+(?:${agentNoun}\\b|(?:is|was)\\s+(?:(?:a|the|our|my|your|their)\\s+)?${agentNoun}\\b)`, 'i');
const directRequest = /^\s*[,!:]?\s*(?:(?:can|could|will|would)\s+you\b|(?:please\s+)?(?:help|find|show|tell|explain|remember|summarize|check|look|search|write|read|open)\b|i\s+(?:need|want)\b)/i;

/** Local linguistic cues for church names and agent names; uncertain references stay literal. */
function nameUse(text: string, match: string, offset: number) {
  if (geographicUse(text, match, offset)) return false;
  if (churchUse(text, match, offset)) return true;
  const { before, after } = nearbyText(text, match, offset);
  const clauseBefore = before.split(clauseBoundary).at(-1) || '';
  const clauseAfter = after.split(clauseBoundary)[0] || '';
  return agentBefore.test(before) || agentAfter.test(clauseAfter) || (!clauseBefore.trim() && directRequest.test(after));
}

/** Literal, case-insensitive phrases; no regex syntax, substring matches or cascading replacements. */
export function createTranscriptNormalizer(rules: readonly TranscriptNormalizationRule[] = DEFAULT_TRANSCRIPT_RULES): (text: string) => string {
  if (!rules.length) return text => text;
  const ordered = [...rules].sort((a, b) => b.from.length - a.from.length);
  const phrases = ordered.map(rule => rule.from.trim().split(/\s+/).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'));
  const pattern = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])(?:${phrases.join('|')})(?![\\p{L}\\p{M}\\p{N}_])`, 'giu');
  const spellings = new Map(ordered.map(rule => [spellingKey(rule.from), rule]));
  return text => text.replace(pattern, (match: string, offset: number) => {
    const rule = spellings.get(spellingKey(match))!;
    return transcriptRuleContext(rule) === 'name' && !nameUse(text, match, offset) ? match : rule.to.trim();
  });
}

export function transcriptRulesError(rules: readonly TranscriptNormalizationRule[]): string | null {
  if (rules.length > MAX_TRANSCRIPT_RULES) return `Use up to ${MAX_TRANSCRIPT_RULES} transcript rules.`;
  const seen = new Set<string>();
  for (const rule of rules) {
    const from = spellingKey(rule.from), to = rule.to.trim();
    if (!from || !to) return 'Fill in both spellings or remove the empty rule.';
    if (from.length > MAX_TRANSCRIPT_SPELLING || to.length > MAX_TRANSCRIPT_SPELLING) return `Keep each spelling within ${MAX_TRANSCRIPT_SPELLING} characters.`;
    if (seen.has(from)) return 'Each heard spelling needs a single preferred spelling.';
    seen.add(from);
  }
  return null;
}
