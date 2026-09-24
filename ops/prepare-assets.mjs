import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { unzipSync } from 'fflate';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const models = path.join(root, 'client/public/models');
const runtime = path.join(root, 'client/public/runtime');
const scratch = path.join(root, '.local/assets');
await Promise.all([models, runtime, scratch].map(p => mkdir(p, { recursive: true })));
const digest = data => createHash('sha256').update(data).digest('hex');
const sources = {
  vosk: 'https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip',
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
const archive = path.join(scratch, 'vosk-model-small-en-us-0.15.zip');
const sourceHash = await download(sources.vosk, archive, lock.vosk?.sha256);
const vadHash = await download(sources.vad, path.join(models, 'silero_vad.onnx'), lock.vad?.sha256);
// A binary suffix prevents static servers from treating the gzip archive as an
// HTTP content encoding and transparently decompressing it before hash validation.
const modelArchive = path.join(models, 'vosk-en-us-0.15.tar.gz.bin');
// Fixed metadata makes the archive identical across Windows and Linux builds.
const entries = unzipSync(await readFile(archive));
const blocks = [];
for (const filename of Object.keys(entries).sort()) {
  if (!filename.startsWith('vosk-model-small-en-us-0.15/') || filename.includes('..')) throw new Error('Unexpected model path');
  const name = 'model/' + filename.slice('vosk-model-small-en-us-0.15/'.length);
  if (Buffer.byteLength(name) >= 100) throw new Error('Model path exceeds tar header');
  const data = Buffer.from(entries[filename]);
  const directory = name.endsWith('/');
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  const octal = (value, offset, width) => header.write(value.toString(8).padStart(width - 1, '0') + '\0', offset, width);
  octal(directory ? 0o755 : 0o644, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
  octal(data.length, 124, 12); octal(0, 136, 12);
  header.fill(32, 148, 156); header[156] = directory ? 53 : 48;
  header.write('ustar\0', 257, 6); header.write('00', 263, 2);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
}
blocks.push(Buffer.alloc(1024));
const bytes = gzipSync(Buffer.concat(blocks), { level: 6 });
await writeFile(modelArchive, bytes);
const manifest = { id: 'vosk-en-us-0.15', url: '/models/vosk-en-us-0.15.tar.gz.bin', sha256: digest(bytes), bytes: bytes.length, license: 'Apache-2.0', sampleRate: 16000 };
await writeFile(path.join(models, 'vosk-en-us-0.15.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(lockPath, JSON.stringify({ vosk: { url: sources.vosk, sha256: sourceHash }, vad: { url: sources.vad, sha256: vadHash } }, null, 2) + '\n');
for (const file of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']) {
  await copyFile(path.join(root, 'node_modules/onnxruntime-web/dist', file), path.join(runtime, file));
}
await copyFile(path.join(root, 'node_modules/vosk-browser/dist/vosk.js'), path.join(runtime, 'vosk.js'));
console.log(JSON.stringify({ model: manifest.id, bytes: manifest.bytes, sha256: manifest.sha256, vadSha256: vadHash, runtime: 'onnxruntime-web@1.30.0, vosk-browser@0.0.8' }));
