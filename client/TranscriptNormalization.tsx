import { useState } from 'react';
import { MAX_TRANSCRIPT_RULES, MAX_TRANSCRIPT_SPELLING, transcriptRuleContext, type TranscriptNormalizationRule } from '../contract/transcript-normalization';
import './transcript-normalization.css';

export default function TranscriptNormalization({ value, onChange, disabled }: { value: TranscriptNormalizationRule[]; onChange(value: TranscriptNormalizationRule[]): void; disabled: boolean }) {
  const [ids, setIds] = useState(() => value.map(() => crypto.randomUUID()));
  function edit(index: number, field: 'from' | 'to', text: string) { onChange(value.map((rule, i) => i === index ? { ...rule, [field]: text } : rule)); }
  return <section className="settings-section" aria-labelledby="transcript-normalization-title">
    <div className="section-title"><h3 id="transcript-normalization-title">Transcript normalization</h3></div>
    <p className="setting-detail">Preferred spellings for speech text before it appears in Messenger or is sent to your agent. Saved for this VC installation.</p>
    <p className="setting-detail" id="transcript-normalization-help">Matches complete phrases regardless of capitalization. Church or agent references use nearby wording such as “north point church”, “worship at north point”, or “hey north point”. Geographic and ambiguous uses stay as transcribed. These context checks may miss indirect references. Typed text is kept as written.</p>
    <div className="transcript-rules">{value.map((rule, index) => <div className="transcript-rule" key={ids[index]}>
      <label>As transcribed<input aria-label={`As transcribed ${index + 1}`} aria-describedby="transcript-normalization-help" value={rule.from} disabled={disabled} maxLength={MAX_TRANSCRIPT_SPELLING} spellCheck={false} onChange={event => edit(index, 'from', event.target.value)} /></label>
      <label>Preferred spelling<input aria-label={`Preferred spelling ${index + 1}`} value={rule.to} disabled={disabled} maxLength={MAX_TRANSCRIPT_SPELLING} spellCheck={false} onChange={event => edit(index, 'to', event.target.value)} /></label>
      <label className="transcript-rule-context">Apply to<select aria-label={`Apply transcript rule ${index + 1} to`} value={transcriptRuleContext(rule)} disabled={disabled} onChange={event => onChange(value.map((entry, i) => i === index ? { ...entry, context: event.target.value as 'name' | 'any' } : entry))}><option value="name">Church or agent references</option><option value="any">Every matching phrase</option></select></label>
      <button className="text-button" aria-label={`Remove transcript rule ${index + 1}`} disabled={disabled} onClick={() => { setIds(previous => previous.filter((_, i) => i !== index)); onChange(value.filter((_, i) => i !== index)); }}>Remove</button>
    </div>)}</div>
    {!value.length && <p className="setting-detail">No rules. Speech text will keep its transcribed spelling.</p>}
    <button className="button secondary small" disabled={disabled || value.length >= MAX_TRANSCRIPT_RULES} onClick={() => { setIds(previous => [...previous, crypto.randomUUID()]); onChange([...value, { from: '', to: '', context: 'any' }]); }}>Add transcript rule</button>
    <p className="setting-detail">Up to {MAX_TRANSCRIPT_RULES} rules. Use Save preferences to apply changes to your next voice session.</p>
  </section>;
}
