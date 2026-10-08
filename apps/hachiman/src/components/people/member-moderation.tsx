import { useMemo, useState } from 'react'
import { ArrowRightLeft, Ban, HeadphoneOff, MicOff, PhoneOff, UserMinus } from 'lucide-react'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import type { ModerationRights } from '@/components/people/use-moderation-rights'
import type { Action } from '@/hooks/use-action'
import { compareChannels } from '@/lib/model'
import { hachiman } from '@/services/hachiman'
import { useChannelStore } from '@/stores/channelStore'
import { useGuildStore } from '@/stores/guildStore'
import { useVoiceStore } from '@/stores/voiceStore'

export type ModerationDialog = 'kick' | 'ban'

/**
 * The moderation items of a member menu: server mute and deafen, move and disconnect (while the
 * member is in voice), kick and ban. Kick and ban only ask: `onDialog` opens their confirm window.
 */
export function ModerationMenuItems(props: {
  guildId: string
  userId: string
  name: string
  rights: ModerationRights
  action: Action
  onDialog: (kind: ModerationDialog) => void
}): React.JSX.Element | null {
  const { guildId, userId, name, rights, action, onDialog } = props
  const member = useGuildStore((s) => s.members.get(guildId)?.get(userId))
  const voiceChannelId = useVoiceStore((s) => s.voiceStates.get(guildId)?.get(userId)?.channelId)
  const channels = useChannelStore((s) => s.channels)
  const targets = useMemo(
    () =>
      [...channels.values()]
        .filter((c) => c.guildId === guildId && c.type === 'voice' && c.id !== voiceChannelId)
        .sort(compareChannels),
    [channels, guildId, voiceChannelId]
  )
  if (!member || !Object.values(rights).some(Boolean)) return null

  const update = (what: string, body: Parameters<typeof hachiman.rest.updateMember>[2]): void =>
    void action.run(what, () => hachiman.rest.updateMember(guildId, userId, body))
  const voiceItems = rights.mute || rights.deafen || (rights.move && voiceChannelId)

  return (
    <>
      <DropdownMenuSeparator />
      {rights.mute && (
        <DropdownMenuItem
          onSelect={() =>
            update(`${member.mute ? 'server unmute' : 'server mute'} ${name}`, {
              mute: !member.mute
            })
          }
        >
          <MicOff /> {member.mute ? 'Server unmute' : 'Server mute'}
        </DropdownMenuItem>
      )}
      {rights.deafen && (
        <DropdownMenuItem
          onSelect={() =>
            update(`${member.deaf ? 'server undeafen' : 'server deafen'} ${name}`, {
              deaf: !member.deaf
            })
          }
        >
          <HeadphoneOff /> {member.deaf ? 'Server undeafen' : 'Server deafen'}
        </DropdownMenuItem>
      )}
      {rights.move && voiceChannelId && targets.length > 0 && (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <ArrowRightLeft /> Move to
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {targets.map((c) => (
              <DropdownMenuItem
                key={c.id}
                onSelect={() => update(`move ${name}`, { channelId: c.id })}
              >
                {c.name ?? 'Voice'}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )}
      {rights.move && voiceChannelId && (
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => update(`disconnect ${name}`, { channelId: null })}
        >
          <PhoneOff /> Disconnect
        </DropdownMenuItem>
      )}
      {voiceItems && (rights.kick || rights.ban) && <DropdownMenuSeparator />}
      {rights.kick && (
        <DropdownMenuItem variant="destructive" onSelect={() => onDialog('kick')}>
          <UserMinus /> Kick
        </DropdownMenuItem>
      )}
      {rights.ban && (
        <DropdownMenuItem variant="destructive" onSelect={() => onDialog('ban')}>
          <Ban /> Ban
        </DropdownMenuItem>
      )}
    </>
  )
}

/** The kick and ban confirm windows. They live outside the popover, which closes when one opens. */
export function ModerationDialogs(props: {
  guildId: string | null
  userId: string
  name: string
  open: ModerationDialog | null
  onClose: () => void
}): React.JSX.Element | null {
  const { guildId, userId, name, open, onClose } = props
  const [reason, setReason] = useState('')
  if (!guildId) return null
  return (
    <>
      <ConfirmDialog
        open={open === 'kick'}
        onClose={onClose}
        title={`Kick ${name}?`}
        body="They leave the guild now. They can come back with a new invite."
        confirmLabel="Kick"
        what={`kick ${name}`}
        tone="danger"
        icon={<UserMinus />}
        onConfirm={() => hachiman.rest.kickMember(guildId, userId)}
      />
      <ConfirmDialog
        open={open === 'ban'}
        onClose={() => {
          setReason('')
          onClose()
        }}
        title={`Ban ${name}?`}
        body={
          <div className="grid gap-3">
            <p>
              They leave the guild now and cannot join again with an invite until you unban them.
            </p>
            <Field id="ban-reason" label="Reason (optional)">
              <Input
                id="ban-reason"
                value={reason}
                maxLength={512}
                placeholder="Only members who can ban see it"
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
          </div>
        }
        confirmLabel="Ban"
        what={`ban ${name}`}
        tone="danger"
        icon={<Ban />}
        onConfirm={() =>
          hachiman.rest.banMember(guildId, userId, { reason: reason.trim() || null })
        }
      />
    </>
  )
}
