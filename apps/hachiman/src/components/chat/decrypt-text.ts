import type { DecryptFailure } from '@hachiman/crypto'
import type { DecryptState } from '@/stores/messagesStore'

/** One line per §12.8.5 result code, for the "unable to decrypt" row. */
const FAILURE_TEXT: Record<DecryptFailure, string> = {
  malformed: 'the message is damaged',
  wrong_channel: 'the message belongs to another channel',
  wrong_group: 'the message names another key group',
  replay: 'the message is a copy of another message',
  aead: 'the message does not match its key',
  invalid_chain: 'the sender device is not certified',
  device_mismatch: 'the sender device is not the author’s',
  edit_not_author: 'the edit does not come from the author',
  bad_signature: 'the signature is not valid',
  bad_franking: 'the report tag does not match the content',
  attachments_mismatch: 'the attachments do not match the message',
  stale_edit: 'the server sent an older version of this message'
}

const PENDING_TEXT: Record<Extract<DecryptState, { status: 'pending' }>['reason'], string> = {
  epoch_ahead: 'Waiting for the keys of this message…',
  group_unknown: 'Waiting for access to the keys of this channel…',
  no_history_key: 'This device has no key for this older message.',
  transport: 'Could not load the keys of this message. Trying again…'
}

/** The placeholder text of a row that did not decrypt, or null for 'ok'. */
export function decryptText(state: DecryptState): string | null {
  if (state.status === 'ok') return null
  if (state.status === 'pending') return PENDING_TEXT[state.reason]
  return `Unable to decrypt: ${FAILURE_TEXT[state.reason]}.`
}
