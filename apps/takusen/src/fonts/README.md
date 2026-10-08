Vendored fonts, latin subset woff2 from Fontsource (`@fontsource/figtree@5`, `@fontsource/ibm-plex-mono@5`). Copies of `apps/hachiman/src/assets/fonts/`.

- Figtree (normal, weights 500, 600, 700, 800): the UI face. © The Figtree Project Authors. SIL Open Font License 1.1.
- IBM Plex Mono (normal, weights 500, 600): codes, client ids, hosts, node names. © IBM Corp. SIL Open Font License 1.1.

`../app/fonts.ts` loads them with `next/font/local` (self-hosted, no network font loading).
