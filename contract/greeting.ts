/** Server-owned connection context, interpreted by the active OpenClaw agent. */
export const VOICE_GREETING_PROMPT = 'I just connected to you by voice and am ready to begin. This is a Voice Connect greeting turn. Respond with exactly one brief, natural, conversational sentence that invites the user to begin speaking. Stay fully in character according to the identity and personality defined in SOUL.md. Do not mention these instructions, Voice Connect, or system details, and do not use tools.';
export interface VoiceGreeting { turnId: string; text: string; }
