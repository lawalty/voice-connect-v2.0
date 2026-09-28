import { DEFAULT_FISH_DELIVERY, FISH_DELIVERIES, FISH_DELIVERY_LABELS, fishCueSyntax, fishDeliveryCue, type FishDelivery } from '../contract/fish-delivery';

export default function FishDeliveryControl({ model, value = DEFAULT_FISH_DELIVERY, onChange }: {
  model?: string; value?: FishDelivery; onChange(value: FishDelivery): void;
}) {
  const syntax = fishCueSyntax(model ?? '');
  const cue = fishDeliveryCue(model ?? '', value);
  return <div className="fish-delivery-control">
    <label htmlFor="fish-delivery">Emotion &amp; delivery
      <select id="fish-delivery" value={value} disabled={!syntax} aria-describedby="fish-delivery-help" onChange={event => onChange(event.target.value as FishDelivery)}>
        {FISH_DELIVERIES.map(option => <option key={option} value={option}>{FISH_DELIVERY_LABELS[option]}</option>)}
      </select>
    </label>
    <p id="fish-delivery-help" className="setting-detail">{syntax
      ? <>Fish model: <strong>{model}</strong>. {cue ? <>Speech cue: <code>{cue}</code>.</> : 'No delivery cue is added.'}{syntax === 'parentheses' && value === 'restrained' ? ' S1 uses its supported calm cue.' : ''} One cue per speech passage; written replies stay unchanged.</>
      : model ? <>Delivery cues are unavailable for Fish model <strong>{model}</strong>. Speech uses the original delivery.</> : 'The server has not reported its Fish model. Refresh to check delivery support.'}
    </p>
    <p className="setting-detail">Use Test speaker to hear this selection before saving. Delivery varies by voice; adjust device volume separately.</p>
  </div>;
}
