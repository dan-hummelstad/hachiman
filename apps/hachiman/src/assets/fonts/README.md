Vendored fonts (SIL Open Font License 1.1), latin subset woff2 from Google Fonts:

- IBM Plex Sans (normal + italic, variable 100–700): UI face. © IBM Corp.
- Geist Mono (variable 100–900): chat/transcript face. © Vercel.

`../main.css` loads them with `@font-face`. There is no network font loading (Electron CSP forbids it).
