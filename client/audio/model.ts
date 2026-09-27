import type { HostModelStatus } from '../../contract/types';
import { api } from '../api';

export interface ModelProgress { received: number; total: number; percent: number; }
export type ModelStatus = HostModelStatus;
export function modelStatus(): Promise<ModelStatus> { return api('/api/settings/vosk'); }
export async function downloadModel(onProgress: (progress: ModelProgress) => void = () => {}): Promise<void> {
  let state = await api<ModelStatus>('/api/settings/vosk', { method: 'POST' });
  const deadline = Date.now() + 10 * 60_000;
  while (true) {
    onProgress({ received: state.received, total: state.bytes, percent: Math.min(100, Math.floor(state.received * 100 / state.bytes)) });
    if (state.installed) return;
    if (['error', 'unavailable'].includes(state.state)) throw new Error(state.error || 'The host model could not be installed.');
    if (Date.now() > deadline) throw new Error('Installation is still running on the host. Reopen Settings to check progress.');
    await new Promise(resolve => setTimeout(resolve, 1000)); state = await modelStatus();
  }
}
export async function removeModel(): Promise<void> { await api('/api/settings/vosk', { method: 'DELETE' }); }

/** Retire only the previous browser model, leaving conversations and device controls intact. */
export async function retireDeviceModel(): Promise<void> {
  if ('caches' in globalThis) await caches.delete('voice-connect-model-v1');
  if ('indexedDB' in globalThis) await new Promise<void>(resolve => {
    const request = indexedDB.deleteDatabase('/vosk');
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
}
