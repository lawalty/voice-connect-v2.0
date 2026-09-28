import { DEFAULT_FISH_DELIVERY, type FishDelivery } from './fish-delivery.js';
export type RecognizerKind = 'browser' | 'vosk' | 'deepgram';
export type OutputKind = 'browser' | 'fish';
export type VoicePhase = 'off' | 'starting' | 'listening' | 'hearing' | 'finalizing' | 'thinking' | 'working' | 'thinking-commentary' | 'working-commentary' | 'speaking' | 'reconnecting' | 'paused' | 'error';
export interface SpeechPreferences {
  recognition: RecognizerKind;
  output: OutputKind;
  browserVoice: string;
  fishVoice?: string;
  fishDelivery?: FishDelivery;
  handsFree: boolean;
  /** Remember an explicit manual-turn choice when switching recognizers. */
  turnMode?: 'automatic' | 'manual';
  keepAwake: boolean;
  /** Device-local interruption threshold: 0 is least sensitive, 100 is most sensitive. */
  interruptionSensitivity?: number;
  /** Brief sounds when ready for a turn and when that listening window closes. */
  audioCues?: boolean;
}
export const DEFAULT_SPEECH: SpeechPreferences = {
  recognition: 'vosk', output: 'browser', browserVoice: '', fishVoice: '', handsFree: true, turnMode: 'automatic', keepAwake: true,
  interruptionSensitivity: 50, audioCues: true, fishDelivery: DEFAULT_FISH_DELIVERY,
};
export interface AcousticSignal { energy: number; speechProbability: number; noiseFloor: number; pitch: number | null; confidence: number; }
export interface HarnessCapabilities { connected: boolean; images: boolean; cancellation: boolean; approvals: boolean; version: string; reason?: string; }
export interface AppStatus { ownerConfigured: boolean; authenticated: boolean; build: string; csrfToken?: string; }
export interface InstallationSpeech {
  version: 1; revision: number; setupComplete: boolean;
  recognition: RecognizerKind; output: OutputKind; fishVoice: string;
  fishDelivery?: FishDelivery;
}
export interface HostModelStatus {
  id: string; installed: boolean; state: 'missing' | 'downloading' | 'extracting' | 'loading' | 'ready' | 'error' | 'unavailable';
  bytes: number; received: number; error?: string | null;
}
export interface AppSettings { deepgramConfigured: boolean; fishConfigured: boolean; fishModel?: string; harness: HarnessCapabilities; speech: InstallationSpeech; vosk: HostModelStatus; }
export interface Conversation { id: string; title: string; createdAt: number; updatedAt: number; }
export interface Attachment { id: string; mimeType: string; name: string; width: number; height: number; previewUrl?: string; }
export type Delivery = 'pending' | 'accepted' | 'complete' | 'cancelled' | 'uncertain' | 'failed';
export interface Message { id: string; role: 'user' | 'assistant'; text: string; createdAt: number; turnId?: string; runId?: string; delivery?: Delivery; attachments?: Attachment[]; }
export interface TurnRequest { id: string; text: string; attachments?: string[]; }
export interface TurnReceipt { turnId: string; delivery: Delivery; runId?: string; error?: string; }
export interface HistoryOptions { before?: string; since?: string; }
export interface HistoryWindow { sessionId: string; sync?: string; before?: string; start?: number; reset?: boolean; }
export interface ConversationView { conversation: Conversation; messages: Message[]; activeTurn?: TurnReceipt; history?: HistoryWindow; }
export type ServerEvent = (
  | { type: 'pong'; nonce: string }
  | { type: 'hello'; conversationId: string; capabilities: HarnessCapabilities }
  | { type: 'turn'; conversationId: string; turnId: string; delivery: Delivery; runId?: string; error?: string }
  | { type: 'assistant'; conversationId: string; turnId: string; runId: string; seq: number; text: string; replace: boolean }
  | { type: 'commentary'; conversationId: string; turnId: string; runId: string; itemId: string; seq: number; text: string; done: boolean }
  | { type: 'complete'; conversationId: string; turnId: string; runId: string; text?: string; cancelled?: boolean; failed?: boolean }
  | { type: 'activity'; conversationId: string; turnId?: string; label: string; stage?: 'thinking' | 'working' }
  | { type: 'approval'; conversationId: string; id: string; label: string; detail?: string; expiresAt?: number }
  | { type: 'question'; conversationId: string; id: string; text: string; options?: string[] }
  | { type: 'connection'; connected: boolean; reason?: string }
  | { type: 'reconcile'; conversationId: string }
  | { type: 'error'; message: string }
) & { revision?: number };
export type AudioEvent =
  | { type: 'ready'; sampleRate: number; playbackWindowBytes?: number }
  | { type: 'stt'; text: string; final: boolean; turnComplete: boolean; started?: boolean }
  | { type: 'speech-done' }
  | { type: 'interrupted' }
  | { type: 'error'; message: string; retryable?: boolean };
export interface ModelManifest { id: string; url: string; sha256: string; bytes: number; license: string; sampleRate: number; }
export interface HarnessAdapter {
  capabilities(): HarnessCapabilities;
  history(conversationId: string, options?: HistoryOptions): Promise<ConversationView>;
  send(conversationId: string, turn: TurnRequest): Promise<TurnReceipt>;
  abort(conversationId: string, turnId: string): Promise<void>;
  close(): void;
}
export interface RecognizerCapabilities {
  provider: RecognizerKind;
  available: boolean;
  input: 'browser-managed' | 'pcm16k';
  processing: 'browser-vendor' | 'local' | 'remote';
  handsFree: boolean;
  endpointing: 'native-session' | 'local-vad' | 'provider-turn';
  reason?: string;
}
export interface RecognizerResult { text: string; final: boolean; turnComplete: boolean; started?: boolean; }
export interface RecognizerError {
  code: 'permission' | 'capture' | 'no-speech' | 'network' | 'unavailable' | 'overload' | 'unknown';
  message: string;
  fatal: boolean;
}
export interface RecognizerEvents {
  result(result: RecognizerResult): void;
  ended(expected: boolean): void;
  error(error: RecognizerError): void;
  connection?(recovering: boolean, attempt: number, closeCode?: number): void;
}
export interface SpeechRecognizer {
  readonly capabilities: RecognizerCapabilities;
  readonly running: boolean;
  start(): Promise<void>;
  /** Normalized mono PCM at 16 kHz; browser-managed capture ignores this input. */
  push(samples: Float32Array): void;
  finish(): Promise<void>;
  stop(): void;
}
export interface SpeechOutput {
  enqueue(text: string): void;
  finish(): void;
  cancel(): void;
  dispose(): void;
}
