Vendored fonts, latin subset woff2 from Fontsource (`@fontsource/figtree@5`, `@fontsource/ibm-plex-mono@5`):

- Figtree (normal, weights 500, 600, 700, 800): the UI and chat face. © The Figtree Project Authors. SIL Open Font License 1.1.
- IBM Plex Mono (normal, weights 500, 600): keys, safety numbers, codes and invite codes. © IBM Corp. SIL Open Font License 1.1.

`../main.css` loads them with `@font-face`. There is no network font loading: the Electron and browser CSP allow no font host.
