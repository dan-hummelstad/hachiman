# Hachiman — instructions for AI coding agents

Read these first:
- [`CLAUDE.md`](../CLAUDE.md): repo layout, commands and conventions. It is the primary guide.
- [`docs/gateway-protocol.md`](../docs/gateway-protocol.md): the wire contract (entities, permissions, schema, REST, Redis, gateway ops, voice). If code and the contract disagree, fix one of them in the same change.

Architecture in one paragraph: Oracle (`apps/oracle`, Next.js + Drizzle) owns identity, the REST API `/api/v1` and the Postgres schema. After each commit it publishes gateway events to Redis. `hachiman-gateway` (Go) holds client WebSockets and dispatches those events. `hachiman-media` (Go) is a WebRTC SFU. Clients use `@hachiman/client` (`pkgs/hachiman-client`). The shared React UI is `apps/hachiman`. The Electron and browser hosts implement `IPlatformService`.

Key conventions:
- TypeScript uses `tsgo` (`@typescript/native-preview`). Never add `tsc` or a `typescript` devDependency.
- Zustand selectors: select one field, or wrap object selections in `useShallow`. Never return a fresh `[]`/`{}` from a selector. Hoist a module-level empty constant.
- One `TooltipProvider`, at the App root.
- `@hachiman/client` is browser-safe only: no Node imports.
- TS (`pkgs/hachiman-client/src/permissions.ts`) and Go (`apps/hachiman-server/pkg/permissions`) both define the permission bits. A Go sync test keeps them equal. Change both together.
- A new gateway event needs: the contract, `GatewayEvents` in `types.ts`, the Oracle publish call and the gateway handling.
- Never hand-edit `*.pb.go`. Run `go generate` in the package directory.
- In development, drop and reseed the database instead of adding ALTER migrations.
- Keep changes to the task. Do not refactor unrelated code.

Checks:
```bash
pnpm -F <package> typecheck
pnpm -F @hachiman/client test
pnpm -F @hachiman/oracle test
cd apps/hachiman-server && go test ./...
```
