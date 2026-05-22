#!/usr/bin/env bash
# Block edits to generated protobuf files. They must be regenerated from
# Mumble.proto / MumbleUDP.proto via the regen-proto skill.
set -euo pipefail

input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')

case "$file" in
  */pkgs/hachiman-node/src/mumbleproto/*.ts \
  | */apps/hachiman-server/pkg/mumbleproto/*.pb.go)
    cat >&2 <<EOF
BLOCKED: $file is generated from the .proto files in apps/hachiman-server/pkg/mumbleproto/.

Do not hand-edit. Instead:
  1. Edit Mumble.proto or MumbleUDP.proto.
  2. Run the regen-proto skill (or invoke it directly) to regenerate
     both Go and TypeScript bindings.

If you must edit non-generated metadata in types.go or packet-type-registry.ts,
those files are NOT blocked — edit those directly.
EOF
    exit 2
    ;;
esac

exit 0
