import { Info } from 'lucide-react'
import type { SenderTrust } from '@hachiman/crypto'
import { ModalWindow } from '@/components/ui/modal-window'
import { useDialogSubject } from '@/hooks/use-dialog-subject'
import type { DialogOf } from '@/stores/dialogStore'
import { useMessageStore, type ChatMessage } from '@/stores/messagesStore'
import { decryptText } from './decrypt-text'
import { formatFull } from './format'

const TRUST_TEXT: Record<SenderTrust, string> = {
  verified: 'Verified by you',
  tofu: 'Not verified',
  changed: 'Security key changed',
  unknown: 'Unknown'
}

const useInfoMessage = (d: DialogOf<'messageInfo'>): ChatMessage | undefined =>
  useMessageStore((s) => s.byChannel.get(d.channelId)?.find((m) => m.id === d.messageId))

/** "Info" from a message's "More" menu: when it was sent and how it reached this device. */
export function MessageInfoDialog(): React.JSX.Element {
  const { subject: message, open, close } = useDialogSubject('messageInfo', useInfoMessage)
  const sender = message?.sender ?? null
  return (
    <ModalWindow open={open} onClose={close} title="Message info" icon={<Info />}>
      {message && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-[13.5px] leading-5">
          <Row label="Sent">{formatFull(message.createdAt)}</Row>
          {message.editedAt && <Row label="Edited">{formatFull(message.editedAt)}</Row>}
          <Row label="Encryption">{decryptText(message.decrypt) ?? 'End-to-end encrypted'}</Row>
          {sender && (
            <>
              <Row label="Sender device">
                <code className="text-xs break-all">{sender.deviceId}</code>
              </Row>
              <Row label="Sender key">{TRUST_TEXT[sender.trust]}</Row>
              <Row label="Delivery">
                {sender.membershipVerified ? (
                  'Received live'
                ) : (
                  <>
                    <p>Received from history, membership at that time not verified</p>
                    <p className="text-text-secondary mt-1">
                      This device was not in the channel when the message was sent. It got the
                      message later, from the channel history or a backup. The signature shows that
                      the sender wrote it, but this device could not check that the sender was still
                      a member of the channel at that time.
                    </p>
                  </>
                )}
              </Row>
            </>
          )}
          <Row label="Message ID">
            <code className="text-xs break-all">{message.id}</code>
          </Row>
        </dl>
      )}
    </ModalWindow>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <>
      <dt className="text-text-secondary font-semibold">{label}</dt>
      <dd className="text-text-primary min-w-0">{children}</dd>
    </>
  )
}
