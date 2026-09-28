/** Gateway-authored context records, never prompts submitted for generation. */
export const presenceLabel = 'Voice Connect status';
export const presenceNotes = {
  standby: 'Standby: the user tapped the orb because something came up unexpectedly, such as someone walking up or a phone call. They will return soon. This pauses the existing conversation; it does not end it. Wait quietly. Do not acknowledge this status, ask for speech, or continue an interrupted answer or task.',
  resume: 'Listening resumed: the user tapped the orb again. Continue the same conversation only when their next words arrive. Do not greet, acknowledge, recap, or replay the interrupted answer or task. This is an app status record, not a new user request.',
} as const;
export type PresenceMode = keyof typeof presenceNotes;
export function presenceMode(text: string): PresenceMode | undefined {
  return (Object.keys(presenceNotes) as PresenceMode[]).find(mode => text === `[${presenceLabel}]\n\n${presenceNotes[mode]}`);
}
export const presenceCaptions = { standby: 'Standby · conversation paused', resume: 'Listening resumed' } as const;
