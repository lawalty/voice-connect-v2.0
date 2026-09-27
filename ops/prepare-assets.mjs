import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const models = path.join(root, 'client/public/models');
const runtime = path.join(root, 'client/public/runtime');
const scratch = path.join(root, '.local/assets');
await Promise.all([models, runtime, scratch].map(p => mkdir(p, { recursive: true })));
const digest = data => createHash('sha256').update(data).digest('hex');
const sources = {
  vad: 'https://raw.githubusercontent.com/snakers4/silero-vad/5cd7945676eb32225748052e2e6a0580e4686a08/src/silero_vad/data/silero_vad.onnx',
};
const lockPath = path.join(root, 'ops/asset-lock.json');
let lock = {};
try { lock = JSON.parse(await readFile(lockPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
async function download(url, target, expected) {
  let bytes;
  try { bytes = await readFile(target); } catch { /* download below */ }
  if (!bytes || (expected && digest(bytes) !== expected)) {
    const response = await fetch(url, { signal: AbortSignal.timeout(240_000) });
    if (!response.ok) throw new Error(`Asset request failed: ${response.status} ${url}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (expected && digest(bytes) !== expected) throw new Error(`Asset integrity mismatch: ${url}`);
    await writeFile(target, bytes);
  }
  return digest(bytes);
}
const vadHash = await download(sources.vad, path.join(models, 'silero_vad.onnx'), lock.vad?.sha256);
await writeFile(lockPath, JSON.stringify({ vad: { url: sources.vad, sha256: vadHash } }, null, 2) + '\n');
// Exact legacy asset allowlist. Do not publish the old browser recognizer again.
for (const relative of ['models/vosk-en-us-0.15.tar.gz.bin', 'models/vosk-en-us-0.15.json', 'runtime/vosk.js', 'audio/vosk.worker.js']) {
  await rm(path.join(root, 'client/public', relative), { force: true });
}
for (const file of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']) {
  await copyFile(path.join(root, 'node_modules/onnxruntime-web/dist', file), path.join(runtime, file));
}
console.log(JSON.stringify({ vadSha256: vadHash, runtime: 'onnxruntime-web@1.30.0', recognition: 'Optional server-hosted Vosk lgraph' }));
