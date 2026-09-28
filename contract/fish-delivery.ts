/** Keep capability checks tied to the model sent in Fish's request header. */
export const DEFAULT_FISH_MODEL = 's2.1-pro';
export const FISH_DELIVERIES = ['restrained', 'off', 'calm', 'soft', 'empathetic', 'relaxed', 'confident', 'happy'] as const;
export type FishDelivery = typeof FISH_DELIVERIES[number];
export const DEFAULT_FISH_DELIVERY: FishDelivery = 'restrained';
export const FISH_DELIVERY_LABELS: Record<FishDelivery, string> = {
  restrained: 'Calm, warm, measured · default', off: 'Off · original delivery',
  calm: 'Calm', soft: 'Soft tone', empathetic: 'Empathetic', relaxed: 'Relaxed', confident: 'Confident', happy: 'Happy',
};

export function fishCueSyntax(model: string): 'brackets' | 'parentheses' | null {
  // Explicitly qualified model IDs only: new models must not receive guessed tags.
  if (['s2-pro', 's2.1-pro', 's2.1-pro-free'].includes(model)) return 'brackets';
  if (model === 's1') return 'parentheses';
  return null;
}

export function fishDeliveryCue(model: string, delivery: FishDelivery): string {
  const syntax = fishCueSyntax(model);
  if (!syntax || delivery === 'off') return '';
  const cue = delivery === 'restrained' ? (syntax === 'brackets' ? 'calm, warm, measured voice' : 'calm')
    : delivery === 'soft' ? 'soft tone' : delivery;
  return syntax === 'brackets' ? `[${cue}]` : `(${cue})`;
}

/** Called at the provider boundary only, after the application's speech cleanup. */
export function fishSpeechText(text: string, model: string, delivery: FishDelivery): string {
  const cue = fishDeliveryCue(model, delivery);
  return cue && text.trim() ? `${cue} ${text}` : text;
}
