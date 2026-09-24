import type { ModelManifest } from '../../contract/types';

const CACHE = 'voice-connect-model-v1';
const MANIFEST = '/models/vosk-en-us-0.15.json';
export interface ModelProgress { received: number; total: number; percent: number; }
export interface ModelStatus { installed: boolean; bytes: number; id?: string; license?: string; }
let download: Promise<void> | undefined;

async function manifest(): Promise<ModelManifest> {
  const cached = await (await caches.open(CACHE)).match(MANIFEST);
  let response: Response;
  try { response = await fetch(MANIFEST, { cache: 'no-store' }); }
  catch { if (!cached) throw new Error('Connect once to download the local speech model.'); response = cached; }
  if (!response.ok) { if (cached) response = cached; else throw new Error('Local speech model is not available on this server.'); }
  const value = await response.json() as ModelManifest;
  const url = new URL(value.url, location.origin);
  if (url.origin !== location.origin || !url.pathname.startsWith('/models/') ||
      !/^[a-f0-9]{64}$/i.test(value.sha256) || !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > 200_000_000 || value.sampleRate !== 16000) {
    throw new Error('Local speech model manifest is invalid.');
  }
  return value;
}

export async function modelStatus(): Promise<ModelStatus> {
  if (!('caches' in globalThis)) return { installed: false, bytes: 0 };
  const cache = await caches.open(CACHE), saved = await cache.match(MANIFEST);
  if (!saved) return { installed: false, bytes: 0 };
  const value = await saved.json() as ModelManifest;
  const model = await cache.match(value.url);
  return { installed: Boolean(model), bytes: model ? value.bytes : 0, id: value.id, license: value.license };
}

export async function downloadModel(onProgress: (progress: ModelProgress) => void = () => {}): Promise<void> {
  if (download) return download;
  download = (async () => {
    const value = await manifest(), cache = await caches.open(CACHE);
    const oldManifest = await cache.match(MANIFEST);
    const old = oldManifest ? await oldManifest.json() as ModelManifest : undefined;
    if (old?.sha256 === value.sha256 && await cache.match(value.url)) {
      onProgress({ received: value.bytes, total: value.bytes, percent: 100 }); return;
    }
    const response = await fetch(value.url, { cache: 'no-store' });
    if (!response.ok || !response.body) throw new Error('Speech model download failed. Try again while connected.');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let received = 0;
    onProgress({ received, total: value.bytes, percent: 0 });
    while (true) {
      const next = await reader.read(); if (next.done) break;
      received += next.value.byteLength;
      if (received > value.bytes) { await reader.cancel(); throw new Error('Speech model size verification failed.'); }
      chunks.push(next.value);
      onProgress({ received, total: value.bytes, percent: Math.floor(received * 100 / value.bytes) });
    }
    if (received !== value.bytes) throw new Error('Speech model download was incomplete.');
    const bytes = new Uint8Array(received); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) => v.toString(16).padStart(2, '0')).join('');
    if (hash !== value.sha256.toLowerCase()) throw new Error('Speech model integrity verification failed.');
    await cache.put(value.url, new Response(bytes, { headers: { 'Content-Type': 'application/gzip', 'Content-Length': String(received) } }));
    await cache.put(MANIFEST, new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } }));
    await navigator.storage?.persist?.().catch(() => false);
    onProgress({ received, total: value.bytes, percent: 100 });
  })().finally(() => { download = undefined; });
  return download;
}

/** Vosk's Emscripten mount uses this exact IDB database; never touch conversation storage. */
export async function clearExtractedModel(): Promise<void> {
  if (!('indexedDB' in globalThis)) return;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('/vosk');
    request.onsuccess = () => resolve(); request.onerror = () => reject(new Error('Could not remove the extracted speech model.'));
    request.onblocked = () => reject(new Error('Close other Voice Connect tabs before removing the local model.'));
  });
}

export async function removeModel(): Promise<void> {
  if (download) await download;
  await clearExtractedModel();
  await caches.delete(CACHE);
}

/** Use verified cached bytes even without connectivity; revoke after Vosk loads them. */
export async function modelArchiveURL(): Promise<string> {
  const cache = await caches.open(CACHE), saved = await cache.match(MANIFEST);
  if (!saved) throw new Error('Download the local Vosk model before starting local speech.');
  const value = await saved.json() as ModelManifest, response = await cache.match(value.url);
  if (!response) throw new Error('The browser removed the local model. Download it again.');
  return URL.createObjectURL(await response.blob());
}
