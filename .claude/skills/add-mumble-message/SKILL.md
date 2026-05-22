---
name: add-mumble-message
description: Add a new Mumble control-channel message type end-to-end across the .proto, Go server, and TypeScript client. Use when adding a custom message similar to WebRTC (27), IceCandidate (28), or TalkingState (29). Encodes the multi-file checklist so nothing gets missed.
---

# Add a new Mumble control message

Adding a new control-channel message touches four locations across two languages. Missing any one of them produces a wire-format mismatch that's painful to debug.

## Checklist

For a new message named `Foo` with type ID `N`:

### 1. Define the message in the `.proto`

File: `apps/hachiman-server/pkg/mumbleproto/Mumble.proto`

```proto
message Foo {
  optional string some_field = 1;
  // ...
}
```

### 2. Regenerate bindings

Run the [[regen-proto]] skill. Do NOT hand-edit `Mumble.pb.go` or `src/mumbleproto/Mumble.ts`.

### 3. Register the type ID on the Go server

File: `apps/hachiman-server/pkg/mumbleproto/types.go`

Add a `MessageFoo = N` constant alongside the existing message-type constants. Confirm `N` is the next free ID (current high-water mark: 29 = `TalkingState`).

### 4. Register the type ID in the TypeScript client

File: `pkgs/hachiman-node/src/packet-type-registry.ts`

Add an entry mapping ID `N` to the generated `Foo` class. The registry is consumed by `MumbleSocket` for inbound packet decoding and by `client.command()` for outbound sends.

### 5. Wire up the server handler

File: `apps/hachiman-server/cmd/grumble/message.go`

Add a `case MessageFoo:` to the dispatch switch in `handleIncomingMessage` (or wherever the existing handlers like `WebRTC` and `IceCandidate` are dispatched — usually `webrtc_handlers.go` for voice-related messages, `message.go` for control messages).

### 6. Wire up the client side (if it needs to react)

File: `pkgs/hachiman-node/src/client.ts` or a dedicated module.

Subscribe via `socket.packet.pipe(filterPacket(Foo))` to react to inbound messages. Send via `client.command(...)` or `socket.send(MessageFoo, payload)` for outbound.

### 7. Export the new type from the client library

File: `pkgs/hachiman-node/src/index.ts`

Add `Foo` to the public exports if the message is part of the consumer API.

### 8. Update tests

- Unit: mock a `Foo` packet via the test RxJS Subject in `pkgs/hachiman-node/src/**/*.spec.ts`.
- E2E (only if behavior is server-observable): add a scenario under `pkgs/hachiman-node/e2e/`.

### 9. Verify

```bash
pnpm -F @hachiman/hachiman-node build
pnpm -F hachiman-server build
pnpm -F @hachiman/hachiman-node test
```

## Reference: existing custom messages

- Type 27 — `WebRTC`: SDP offer/answer
- Type 28 — `IceCandidate`: ICE candidate exchange
- Type 29 — `TalkingState`: voice activity for WebRTC bridge

Pattern after these when adding voice/WebRTC-adjacent messages.
