import { build } from 'esbuild';
await build({ entryPoints: ['service/main.ts'], outdir: 'dist/service', platform: 'node', target: 'node24', format: 'esm', bundle: true, packages: 'external', sourcemap: true });
