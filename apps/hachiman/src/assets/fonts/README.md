Vendored fonts, latin subset woff2 from Fontsource (`@fontsource/instrument-sans@5.3.0`, `@fontsource/jetbrains-mono@5.3.0`):

- Instrument Sans (normal, weights 400, 500, 600): the UI and chat face. © The Instrument Sans Project Authors. SIL Open Font License 1.1.
- JetBrains Mono (normal, weights 400, 500, 600, 700): caps labels, badges, keys, safety numbers, codes and invite codes. © The JetBrains Mono Project Authors. SIL Open Font License 1.1.

`../main.css` loads them with `@font-face`. There is no network font loading: the Electron and browser CSP allow no font host.
