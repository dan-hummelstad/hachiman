import type { CallSecurityKind } from './use-call-security'

/**
 * Whether "Join" may start a call: CONNECT in the channel, and not while this client must update
 * (4012) or rejoins its own call after 4013 (§8, §12.13).
 */
export function canJoinVoice(canConnect: boolean, kind: CallSecurityKind): boolean {
  return canConnect && kind !== 'update_required' && kind !== 'resyncing'
}
