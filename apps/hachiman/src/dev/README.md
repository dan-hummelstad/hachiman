# Preview mode (dev only)

Seeds the stores with a fixture so the UI renders without Oracle or a gateway. Browser host, `vite` dev server only (`import.meta.env.DEV`). It is not in production builds.

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
  - one **pending** message and one **failed** message (the last two)

  Juni is typing.

- **DMs:** marlowe (5 messages, marlowe typing) and yuki.h (4 messages).
- Presences: online, idle (ozzy, renata), dnd (petra_v), offline (sable, tobias, wren).

## Stubs (`preview/stubs.ts`)

- `hachiman.connect` and the gateway are no-ops.
- Every `hachiman.rest.*` method resolves locally and logs `[preview] rest.<name>` at debug level. The stubs dispatch writes as gateway events, so the UI updates as it would live:
  - Sending a message echoes it after 400ms.
  - You can create, edit or delete channels, roles and guilds.
  - Invites return code `nt0wl5x`.
  - `previewInvite` returns "Pixel Pushers".
- `joinVoice`, `leaveVoice` and `setSelfVoice` update my voice state. `setSelfVoice` keeps the client's own mute and deafen rules. There is no media.
- The stub table is typed against `hachiman.rest`. If a REST method is added or renamed, `stubs.ts` does not compile until it has a stub.
