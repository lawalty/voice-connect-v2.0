type RecordValue = Record<string, any>;
const record = (value: unknown): RecordValue => value && typeof value === 'object' ? value as RecordValue : {};
const phase = (value: unknown) => value === 'commentary' || value === 'final_answer' ? value : undefined;

function signature(block: RecordValue): RecordValue {
  if (typeof block.textSignature !== 'string' || !block.textSignature.startsWith('{')) return {};
  try { const parsed = JSON.parse(block.textSignature); return parsed?.v === 1 ? record(parsed) : {}; } catch { return {}; }
}
export function assistantPhase(value: unknown): 'commentary' | 'final_answer' | undefined {
  const message = record(value);
  if (phase(message.phase)) return phase(message.phase);
  for (const nested of [message.message, message.partial, message.item]) {
    const found = nested && assistantPhase(nested); if (found) return found;
  }
  const phases = new Set((Array.isArray(message.content) ? message.content : [])
    .filter((block: RecordValue) => block?.type === 'text').map((block: RecordValue) => phase(signature(block).phase)).filter(Boolean));
  return phases.size === 1 ? [...phases][0] as 'commentary' | 'final_answer' : undefined;
}

/** Native commentary can also be stored in signed text blocks. Never promote it
 * into a Messenger reply during history reconciliation or final delivery. */
export function displayText(value: unknown): string {
  const message = record(value);
  // Codex app-server mirrors in OpenClaw 2026.9.6 store commentary without a
  // top-level phase or textSignature; their native mirror identity carries it.
  if (message.__openclaw?.mirrorOrigin === 'codex-app-server' && typeof message.__openclaw.mirrorIdentity === 'string' && message.__openclaw.mirrorIdentity.split(':')[1] === 'commentary') return '';
  if (message.isReasoning === true || ['analysis', 'reasoning', 'thinking', 'commentary'].includes(message.phase)) return '';
  let text = '';
  if (Array.isArray(message.content)) {
    const blocks = message.content.filter((block: RecordValue) => block?.type === 'text' && typeof block.text === 'string' && block.isReasoning !== true);
    const phased = blocks.some((block: RecordValue) => phase(signature(block).phase));
    text = blocks.filter((block: RecordValue) => phased ? signature(block).phase === 'final_answer' : true).map((block: RecordValue) => block.text).join('\n');
  } else text = typeof message.content === 'string' ? message.content : typeof message.text === 'string' ? message.text : '';
  return text.trim() === 'NO_REPLY' ? '' : text;
}

/** Only already-public assistant commentary is eligible. Never read tool
 * arguments, reasoning streams, or arbitrary status payloads as speech. */
export function publicCommentary(text: unknown): text is string {
  return typeof text === 'string' && text.length <= 8000 && text.trim().length > 0 && text.trim() !== 'NO_REPLY'
    && !/```|<\/?(?:think|thinking|analysis|reasoning|tool_call)\b|-----BEGIN .*PRIVATE KEY|\b(?:api[_-]?key|token|password|secret|authorization)\s*[:=]|\b(?:sk|sk-proj)-[a-z0-9_-]{12}|\bBearer\s+[a-z0-9._-]+/i.test(text);
}
