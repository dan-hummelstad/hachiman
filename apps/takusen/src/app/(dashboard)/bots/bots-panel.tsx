'use client'

import { BotIcon, KeyRoundIcon, PlusIcon, Trash2Icon, RotateCcwIcon, UserPlusIcon } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { toast } from 'sonner'

import { Tag } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Panel, PanelFooter, PanelHeader, PanelList } from '@/components/ui/card'
import { ConfirmAction, orThrow } from '@/components/ui/confirm-dialog'
import { CopyButton } from '@/components/ui/copy-button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import type { BotSummary } from '@/lib/bot-accounts'
import { formatRelative, plural } from '@/lib/format'

import {
  addBotToGuildAction,
  createBotAction,
  deleteBotAction,
  resetBotKeysAction,
  resetBotTokenAction,
  type BotActionResult
} from './actions'

export interface ManageableGuild {
  id: string
  name: string
}

/** The token, shown once after a create or a reset. It lives only in component state. */
function TokenReveal({ token, origin }: { token: string; origin: string }): React.JSX.Element {
  return (
    <div className="grid gap-2 border border-gold/30 bg-gold-tint p-3">
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate font-mono text-[13px]" title={token}>
          {token}
        </code>
        <CopyButton value={token} label="Copy the token" />
      </div>
      <p className="text-[13px] leading-[1.4] text-text-secondary">
        Use this as your bot&apos;s token. It is all the bot needs: the token names this server (
        <code className="font-mono">{origin}</code>). You see the token only now.
      </p>
    </div>
  )
}

/** Adds the bot to a guild where the viewer has Manage server, as Discord's bot invite. */
function AddToGuild({ botId, guilds }: { botId: string; guilds: ManageableGuild[] }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" disabled={busy || guilds.length === 0} title={guilds.length === 0 ? 'You manage no guild' : undefined}>
          <UserPlusIcon aria-hidden />
          Add to guild
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Guilds you manage</DropdownMenuLabel>
        {guilds.map((g) => (
          <DropdownMenuItem
            key={g.id}
            onSelect={async () => {
              setBusy(true)
              const res = await addBotToGuildAction(botId, g.id).finally(() => setBusy(false))
              if (res.ok) toast.success(`Added to ${res.name ?? g.name}`)
              else toast.error(res.error ?? 'Something went wrong. Try again.')
            }}
          >
            {g.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function BotRow({ entry, origin, guilds }: { entry: BotSummary; origin: string; guilds: ManageableGuild[] }): React.JSX.Element {
  const router = useRouter()
  const [token, setToken] = useState<string | null>(null)
  const { bot } = entry
  const meta = entry.lastUsedAt ? `Token last used ${formatRelative(entry.lastUsedAt)}` : 'Token not used yet'

  return (
    <li className="grid gap-2 rounded-control p-3">
      <div className="flex flex-wrap items-center gap-3.5">
        <span className="flex size-[38px] shrink-0 items-center justify-center border border-line-hairline bg-surface-raised">
          <BotIcon aria-hidden className="size-[18px] text-text-secondary" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-[14.5px] leading-5 font-extrabold">{bot.username}</span>
            <Tag tone="hachiman">Bot</Tag>
          </div>
          <span className="text-[13px] leading-[18px] font-medium text-text-tertiary">{meta}</span>
        </div>
        <div className="flex gap-1">
          <AddToGuild botId={bot.id} guilds={guilds} />
          <ConfirmAction
            label="Reset token"
            icon={KeyRoundIcon}
            variant="secondary"
            title={`Reset the token of ${bot.username}?`}
            body="The current token stops working at once. The bot needs the new token to connect."
            confirmLabel="Reset token"
            done="Token reset"
            action={async () => {
              const res = await resetBotTokenAction(bot.id)
              if (!res.ok || !res.token) throw new Error(res.error ?? 'Something went wrong. Try again.')
              setToken(res.token)
            }}
          />
          <ConfirmAction
            label="Reset keys"
            icon={RotateCcwIcon}
            variant="secondary"
            title={`Reset the encryption keys of ${bot.username}?`}
            body="Only for a bot that lost its state directory and its recovery key. The bot gets a new identity and a new token, and people in its guilds see that its key changed. It cannot read its old messages."
            confirmLabel="Reset keys"
            done="Keys reset"
            action={async () => {
              const res = await resetBotKeysAction(bot.id)
              if (!res.ok || !res.token) throw new Error(res.error ?? 'Something went wrong. Try again.')
              setToken(res.token)
            }}
          />
          <ConfirmAction
            label="Delete"
            icon={Trash2Icon}
            destructive
            title={`Delete ${bot.username}?`}
            body="This deletes the bot account, its token, its guilds and its messages. You cannot undo this."
            confirmLabel="Delete bot"
            done="Bot deleted"
            action={() => orThrow(deleteBotAction(bot.id))}
            onDone={() => router.refresh()}
          />
        </div>
      </div>
      {token && <TokenReveal token={token} origin={origin} />}
    </li>
  )
}

export function BotsPanel({
  bots,
  origin,
  guilds
}: {
  bots: BotSummary[]
  origin: string
  guilds: ManageableGuild[]
}): React.JSX.Element {
  return (
    <Panel aria-labelledby="bots-title">
      <PanelHeader title={<span id="bots-title">Your bots</span>} meta={plural(bots.length, 'bot')} />
      {bots.length > 0 ? (
        <PanelList>
          {bots.map((b) => (
            <BotRow key={b.bot.id} entry={b} origin={origin} guilds={guilds} />
          ))}
        </PanelList>
      ) : (
        <p className="p-5 text-[13px] text-text-tertiary">You have no bots yet.</p>
      )}
    </Panel>
  )
}

function CreateButton(): React.JSX.Element {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending}>
      <PlusIcon aria-hidden />
      {pending ? 'Creating…' : 'Create bot'}
    </Button>
  )
}

export function CreateBotPanel({ origin }: { origin: string }): React.JSX.Element {
  const [state, formAction] = useActionState<BotActionResult | undefined, FormData>(createBotAction, undefined)
  const error = state && !state.ok ? state.error : undefined

  return (
    <Panel>
      <PanelHeader title="New bot" />
      <form action={formAction} className="flex flex-1 flex-col">
        <div className="flex flex-1 flex-col gap-5 p-5">
          <Field id="bot-name" label="Name" hint="2 to 32 characters. Shown to people in the bot's guilds." error={error}>
            <Input
              id="bot-name"
              name="name"
              type="text"
              leading={<BotIcon aria-hidden />}
              required
              minLength={2}
              maxLength={32}
              autoComplete="off"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'bot-name-error' : 'bot-name-hint'}
            />
          </Field>
          {state?.ok && state.token && (
            <div className="grid gap-2">
              <span className="text-[13px] font-bold">{state.name} is ready.</span>
              <TokenReveal token={state.token} origin={origin} />
            </div>
          )}
        </div>
        <PanelFooter className="bg-transparent px-5 py-3">
          <p className="min-w-0 flex-1 text-[13px] text-text-tertiary">
            To add the bot to a guild, give it an invite code.
          </p>
          <CreateButton />
        </PanelFooter>
      </form>
    </Panel>
  )
}
