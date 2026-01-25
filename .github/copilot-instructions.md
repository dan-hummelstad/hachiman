# Hachiman Project - AI Coding Agent Instructions

## Architecture Overview

Multi-project repository for Mumble voice chat infrastructure:
- `projects/hachiman/` - Electron desktop application with React/TypeScript UI
- `projects/hachiman-node/` - TypeScript Mumble client library (npm package)
- `projects/hachiman-server/` - Go-based Mumble server (Grumble fork)

## Project Structure & Key Patterns

### Electron App (projects/hachiman/)
- **Multi-process architecture**: Main process (`src/main/`) + Renderer process (`src/renderer/`)
- **Platform abstraction**: `platforms/` directory with platform-specific implementations
  ```typescript
  // Platform services resolved via @platform alias
  import { PlatformService } from '@platform/PlatformService'
  import { MumbleService } from '@platform/MumbleService'
  ```
- **Path resolution**: `@platform` alias resolves based on `VITE_TARGET` env var
- **IPC pattern**: Uses `window.electron.ipcRenderer` for main/renderer communication

### Mumble Client Library (projects/hachiman-node/)
- **Event-driven architecture**: Uses RxJS observables extensively
- **Strongly-typed packets**: Uses `@tf2pickup-org/mumble-protocol` with protobuf
- **Connection pattern**: `Client.connect()` returns promise, use `client.isConnected()` to check state
- **Command pattern**: 
  ```typescript
  await client.command('textMessage', {
    sendPacket: [TextMessage, messageData],
    expectPacket: [TextMessage, (packet) => true]
  })
  ```

### Mumble Server (projects/hachiman-server/)
- **Go modules**: Uses `mumble.info/grumble` as module path
- **Message handling**: Server processes messages via handler functions in `cmd/grumble/message.go`
- **WebRTC support**: Optional WebRTC bridge in `pkg/web/webrtc.go`
- **Data persistence**: Append-only file format with periodic full syncs

## Development Workflows

### Electron Development
```bash
cd projects/hachiman
pnpm dev          # Start with hot-reload
pnpm build:win    # Build for Windows
pnpm build:mac    # Build for macOS
```

### Node Library Development
```bash
cd projects/hachiman-node
pnpm test         # Unit tests with Vitest
pnpm run e2e      # E2E tests (requires running Mumble server)
```

### Server Development
```bash
cd projects/hachiman-server
pnpm dev          # Build and start with test data
# Data stored in ./bin/data/, logs in ./bin/data/grumble.log
```

## Critical Integration Points

### Electron ↔ Mumble Library
- Electron app imports `@hachiman/hachiman-node` package
- Platform-specific certificate generation using `pem` library
- Connection state managed in renderer process, exposed via React hooks

### Client ↔ Server Protocol
- Uses Mumble protocol over TCP/UDP (default port 64738)
- Authentication via client certificates (self-signed for development)
- Voice packets handled separately from control packets

## Common Patterns

### Error Handling
```typescript
// Library uses specific error types
try {
  await client.connect()
} catch (error) {
  if (error instanceof ConnectionRejectedError) {
    // Handle authentication failure
  }
}
```

### Channel Management
```typescript
// Channels accessed via managers
const channel = client.channels.byName('channelName')
await client.user?.moveToChannel(channel.id)
```

### Platform Detection
```typescript
// Use platform services for environment-specific code
const platformService = new PlatformService()
const platform = await platformService.getPlatform() // 'electron' | 'browser'
```

## Development Notes

- **Crypto dependencies**: Server uses Go crypto, client uses Node.js crypto/pem
- **mumbleprotocol versions**: Library supports Mumble protocol v1.x via protobuf definitions
- **Hot reload**: Electron renderer supports HMR, main process requires restart
- **Testing**: E2E tests require running Grumble server locally on port 64738