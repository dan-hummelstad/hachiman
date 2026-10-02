# @hachiman/client

Browser-safe client for Hachiman: Oracle REST, the gateway WebSocket and media-node voice (WebRTC).
It uses only `fetch`, `WebSocket` and `RTCPeerConnection`. Consumers import it as TypeScript source.
The wire contract is [`docs/gateway-protocol.md`](../../docs/gateway-protocol.md) (§10 is the API of this package).

| Class | Does |
|---|---|
| `RestClient` | One method per REST route (`/api/v1`). Sends a bearer token from `getToken`. Throws `RestError` on a non-2xx response. |
| `GatewayClient` | HELLO/IDENTIFY/heartbeat, RESUME, INVALID_SESSION/RECONNECT, reconnect with backoff. Emits one typed event for each dispatch. |
| `VoiceConnection` | Voice WS + RTCPeerConnection to a media node (answer-only). Mic, speaking, deafen, per-user volume, stats. |
| `HachimanClient` | Owns `rest` + `gateway`. Keeps a cache (guilds, channels, roles, members, presences, voice states). Dispatches update this cache. Also has permissions helpers and `joinVoice`/`leaveVoice`. |

The package also exports `permissions` (Discord-style bitfield + `computeChannelPermissions`) and `types` as subpaths.

```ts
import { HachimanClient, Permissions, has } from '@hachiman/client'

const client = new HachimanClient({
  apiUrl: 'http://localhost:3000/api/v1',
  gatewayUrl: 'ws://localhost:8080/gateway',
  getToken: () => oracle.getAccessToken(), // must return a fresh token each call
})
client.on('ready', ({ user }) => console.log('hello', user.username))
client.on('MESSAGE_CREATE', msg => console.log(msg.author.username, msg.content))
client.connect()

if (has(client.permissionsFor(channelId), Permissions.SEND_MESSAGES))
  await client.rest.sendMessage(channelId, { content: 'hi', nonce: crypto.randomUUID() })

const voice = await client.joinVoice(guildId, voiceChannelId)
await voice.setMicrophone(await navigator.mediaDevices.getUserMedia({ audio: true }))
```

Tests: `vitest run` (node environment, hand-written WebSocket fakes). Typecheck: `tsgo --noEmit -p tsconfig.json`.

This package started as a fork of the tf2pickup-org client library. `LICENSE` keeps the upstream attribution.
