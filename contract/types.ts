export type RecognizerKind = 'browser' | 'vosk' | 'deepgram';
export type OutputKind = 'browser' | 'deepgram';
export type VoicePhase = 'off' | 'starting' | 'listening' | 'hearing' | 'finalizing' | 'thinking' | 'speaking' | 'reconnecting' | 'paused' | 'error';
export interface SpeechPreferences {
  recognition: RecognizerKind;
  output: OutputKind;
  browserVoice: string;
  premiumVoice: string;
  handsFree: boolean;
  keepAwake: boolean;
}
export const DEFAULT_SPEECH: SpeechPreferences = {
  recognition: 'browser', output: 'browser', browserVoice: '', premiumVoice: 'flux-haley-en', handsFree: false, keepAwake: true,
};
export interface AcousticSignal { energy: number; speechProbability: number; noiseFloor: number; pitch: number | null; confidence: number; }
export interface HarnessCapabilities { connected: boolean; images: boolean; cancellation: boolean; approvals: boolean; version: string; reason?: string; }
export interface AppStatus { ownerConfigured: boolean; authenticated: boolean; build: string; csrfToken?: string; }
export interface AppSettings { deepgramConfigured: boolean; premiumVoices: { id: string; name: string }[]; harness: HarnessCapabilities; }
export interface Conversation { id: string; title: string; createdAt: number; updatedAt: number; }
export interface Attachment { id: string; mimeType: string; name: string; width: number; height: number; previewUrl?: string; }
export type Delivery = 'pending' | 'accepted' | 'complete' | 'cancelled' | 'uncertain' | 'failed';
export interface Message { id: string; role: 'user' | 'assistant'; text: string; createdAt: number; turnId?: string; runId?: string; delivery?: Delivery; attachments?: Attachment[]; }
export interface TurnRequest { id: string; text: string; attachments?: string[]; }
export interface TurnReceipt { turnId: string; delivery: Delivery; runId?: string; }
export interface ConversationView { conversation: Conversation; messages: Message[]; activeTurn?: TurnReceipt; }
export type ServerEvent =
  | { type: 'hello'; conversationId: string; capabilities: HarnessCapabilities }
  | { type: 'turn'; conversationId: string; turnId: string; delivery: Delivery; runId?: string; error?: string }
  | { type: 'assistant'; conversationId: string; turnId: string; runId: string; seq: number; text: string; replace: boolean }
  | { type: 'complete'; conversationId: string; turnId: string; runId: string; text?: string; cancelled?: boolean; failed?: boolean }
  | { type: 'activity'; conversationId: string; turnId?: string; label: string }
  | { type: 'approval'; conversationId: string; id: string; label: string; detail?: string; expiresAt?: number }
  | { type: 'question'; conversationId: string; id: string; text: string; options?: string[] }
  | { type: 'connection'; connected: boolean; reason?: string }
  | { type: 'reconcile'; conversationId: string }
  | { type: 'error'; message: string };
export type AudioEvent =
  | { type: 'ready'; sampleRate: number }
  | { type: 'stt'; text: string; final: boolean; turnComplete: boolean; started?: boolean }
  | { type: 'speech-done' }
  | { type: 'interrupted' }
  | { type: 'error'; message: string };
export interface ModelManifest { id: string; url: string; sha256: string; bytes: number; license: string; sampleRate: number; }
export interface HarnessAdapter {
  capabilities(): HarnessCapabilities;
  history(conversationId: string): Promise<ConversationView>;
  send(conversationId: string, turn: TurnRequest): Promise<TurnReceipt>;
  abort(conversationId: string, turnId: string): Promise<void>;
  close(): void;
}
export interface SpeechRecognizer {
  start(): Promise<void>;
  finish(): Promise<void>;
  stop(): void;
}
export interface SpeechOutput {
  enqueue(text: string): void;
  finish(): void;
  cancel(): void;
  dispose(): void;
}
