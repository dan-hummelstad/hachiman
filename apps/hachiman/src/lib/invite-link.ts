/**
 * Invite links (contract §11). The grammar lives in `@hachiman/client/invite-link`. This file is
 * also the subpath `@hachiman/hachiman/invite-link`: the hosts import only `@hachiman/hachiman`, and
 * Electron main and `node --test` load this subpath. `export type` keeps it loadable with Node type
 * stripping.
 */
export { inviteKeyFragment, parseInviteCode, parseInviteLink } from '@hachiman/client/invite-link'
export type { InviteLink } from '@hachiman/client/invite-link'
