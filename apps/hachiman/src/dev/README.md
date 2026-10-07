# Preview mode (dev only)

Seeds the stores with a fixture so the UI renders without Takusen or a gateway. Browser host, `vite` dev server only (`import.meta.env.DEV`). It is not in production builds.

## Open it

The dev server runs at `http://localhost:5173` (`cd apps/hachiman-browser && ./node_modules/.bin/vite --port 5173 --strictPort`).

| URL                         | Shows                                                    |
| --------------------------- | -------------------------------------------------------- |
| `/?preview`                 | Signed in, dark theme, Night Owls / #general             |
| `/?preview&theme=light`     | Same, light theme                                        |
| `/?preview&display=compact` | Compact transcript (sets `usePrefsStore.messageDisplay`) |
| `/?preview=signedout`       | Signed-out screen                                        |

Preview state persists under `preview:*` localStorage keys, so it never touches your real dev session. Each reload re-seeds the fixture. (Selections such as the current guild come from the fixture, not from the last visit.)

## Fixture (`preview/fixture.ts`)

- **Me:** `kestrel` (online).
- **Night Owls** (game squad, I am the owner, so every settings surface shows). Categories "Text channels" (#general, #lfg, #clips (empty), #patch-notes (@everyone cannot send)) and "Voice channels" (Lounge, Ranked queue, AFK). 12 members. Roles: Captain red, Moderator pink, Streamer purple, Regular blue, Bot teal. Lounge has me, marlowe (speaking), Juni (muted) and ozzy (muted + deafened). quill is in Ranked queue. I am voice-connected to Lounge, so the voice panel shows.
- **Lattice Labs** (dev team). I am a plain Engineer with no manage permissions, so you see the restricted UI. Uncategorized #deploys and "Weekly sync".
- **Dog-ear Club** (book club). Flat channel list with no categories. I am the owner.
- **#general:** about 42 messages over yesterday and today. They include:
  - a mention of me (`@kestrel`, in the 10:52 message from marlowe)
  - a code-ish line (quill)
  - a long paragraph (petra_v)
  - one message that does not decrypt (sable, 11:20, "the signature is not valid")
  - one message from a history bundle (marlowe, 18:02 yesterday, "Membership at that time not verified")
  - a membership line before the first message of today ("kestrel added yuki.h")
  - one **pending** message and one **failed** message (the last two)

  Juni is typing.

- **DMs:** marlowe (5 messages, marlowe typing) and yuki.h (4 messages).
- Presences: online, idle (ozzy, renata), dnd (petra_v), offline (sable, tobias, wren).

## Stubs (`preview/stubs.ts`)

- The crypto client is `createCryptoStub` from `@hachiman/crypto` (`cryptoService.useStub()`). It has no Worker and no keys. Its envelopes are marked JSON, NOT ENCRYPTED, and it gives attachment blobs back unchanged. The send, edit, upload and decrypted-blob code paths are the real ones.
- `hachiman.connect` and the gateway are no-ops.
- Every `hachiman.rest.*` method resolves locally and logs `[preview] rest.<name>` at debug level. The stubs dispatch writes as gateway events, so the UI updates as it would live:
  - Sending a message echoes it after 400ms. The echo goes through the stub decrypt.
  - `fetchBlob` gives the fixture files and the files uploaded in this session. It renders the SVG fixture images to PNG, because their pointers say PNG.
  - The §12.12 routes reject with `PreviewUnsupported`. Only the crypto Worker calls them.
  - You can create, edit or delete channels, roles and guilds.
  - The invite list has an invite with history (`h1st0ry`, no Copy button), `nt0wl5x` and an older permanent invite by petra_v (`p3rm4nt`). A new invite gets an `inv-NNNN` code, with the expiry and the maximum uses of the request. It has `hasHistory` when the request has a `record`.
  - I own Night Owls, so its invite dialog offers 7 days, "Permanent" (with the warning) and "Include history". The crypto stub signs a placeholder record and gives a random key, so the link ends in `#k=`. In Lattice Labs I am not an administrator, so the dialog offers 24 hours or less and no history.
  - `previewInvite` returns "Pixel Pushers". For `h1st0ry` it has `hasHistory`: open `/invite/h1st0ry?preview` for the "Open the full link" note, or add `#k=` and a well-formed key (43 base64url characters, for example 43 × `A`) for the "includes history" note. The stub `redeemInvite` imports nothing.
- `joinVoice`, `leaveVoice` and `setSelfVoice` update my voice state. `setSelfVoice` keeps the client's own mute and deafen rules. There is no media.
- The stub table is typed against `hachiman.rest`. If a REST method is added or renamed, `stubs.ts` does not compile until it has a stub or is in `DS_ROUTES`.

## Unit tests

Run the tests from the repo root:

```bash
pnpm -F @hachiman/hachiman test
```

The config is `src/dev/vitest.config.ts`. It runs every `src/**/*.test.ts` in a Node environment.
