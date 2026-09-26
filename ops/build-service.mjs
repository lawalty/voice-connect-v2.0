import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await build({ entryPoints: ['service/main.ts'], outdir: 'dist/service', platform: 'node', target: 'node24', format: 'esm', bundle: true, packages: 'external', sourcemap: true });
await mkdir('dist/openclaw-library', { recursive: true });
await build({ entryPoints: ['service/library-tools.ts'], outfile: 'dist/openclaw-library/library-tools.js', platform: 'node', target: 'node24', format: 'esm', bundle: true });
for (const name of ['index.mjs', 'package.json', 'openclaw.plugin.json']) await copyFile(`integrations/openclaw-library/${name}`, `dist/openclaw-library/${name}`);
