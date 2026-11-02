// Bundles the package for npm: dist/index.mjs and dist/index.cjs, for plain Node 22 (no tsx).
// The Hachiman workspace packages (TypeScript source) and their crypto libraries go in the bundle;
// discord.js and ws stay dependencies, so the bot keeps one discord.js.
import { build } from 'esbuild'

for (const format of ['esm', 'cjs'])
  await build({
    entryPoints: ['src/index.ts'],
    outfile: `dist/index.${format === 'esm' ? 'mjs' : 'cjs'}`,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format,
    external: ['discord.js', 'ws'],
    logLevel: 'warning',
    // The browser Worker bridge of @hachiman/crypto is in the graph but never runs in a bot.
    logOverride: { 'empty-import-meta': 'silent' },
  })
