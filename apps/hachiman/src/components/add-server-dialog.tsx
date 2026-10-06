import { useState } from 'react'
import { ChevronRight, Link2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ErrorText, Field } from '@/components/ui/field'
import { ModalWindow } from '@/components/ui/modal-window'
import { RegionSelect } from '@/components/region-select'
import { useAction } from '@/hooks/use-action'
import type { CreateGuildBody, GuildFull } from '@hachiman/client'
import { adminActionService } from '@/services/AdminActionService'
import { acceptInvite, parseInviteLink, stashInviteKey } from '@/services/InviteService'
import { openDialog, useDialog } from '@/stores/dialogStore'
import { selectGuild } from '@/stores/navStore'

/** POST /guilds, then the owner's genesis admin action (§12.16), then select the guild. */
async function createSignedGuild(body: CreateGuildBody): Promise<GuildFull> {
  const guild = await adminActionService.createGuild(body)
  selectGuild(guild.id)
  return guild
}

type Step = 'choose' | 'create' | 'join'

const TITLES: Record<Step, string> = {
  choose: 'Add a guild',
  create: 'Create a guild',
  join: 'Join a guild'
}

/** Rail "+": first pick create or join (like Discord), then a one-field form. */
export function AddServerDialog(): React.JSX.Element {
  const { open, close } = useDialog('addGuild')
  const [step, setStep] = useState<Step>('choose')
  const [value, setValue] = useState('')
  const [region, setRegion] = useState('') // '' = automatic
  const { run, busy, error, setError, clearError } = useAction()

  const goto = (next: Step): void => {
    setStep(next)
    setValue('')
    setRegion('')
    clearError()
  }

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (step === 'create') {
      const created = await run('create the guild', () =>
        createSignedGuild({ name: value.trim(), region: region || undefined })
      )
      if (!created.ok) return
    } else {
      const link = parseInviteLink(value)
      if (!link) {
        setError(
          'That isn’t an invite link or code. Paste the whole link, or just the code at its end.'
        )
        return
      }
      if (link.key) {
        // An invite with history: the join window shows it, and keeps the key out of stores.
        stashInviteKey(link.code, link.key)
        openDialog({ kind: 'joinInvite', code: link.code })
        return
      }
      if (!(await run('join', () => acceptInvite(link.code))).ok) return
    }
    close()
  }

  if (step === 'choose') {
    return (
      <ModalWindow
        open={open}
        onClose={close}
        title={TITLES.choose}
        description="A guild is where you and your friends chat and talk. Make your own, or join one you were invited to."
      >
        <div className="grid gap-2">
          <ChoiceRow
            icon={<Plus />}
            title="Create a guild"
            hint="Your own place. You’re the owner and set the rules."
            onClick={() => goto('create')}
          />
          <ChoiceRow
            icon={<Link2 />}
            title="Join with an invite"
            hint="Paste a link or code someone sent you."
            onClick={() => goto('join')}
          />
        </div>
      </ModalWindow>
    )
  }

  const formId = 'add-guild-form'
  return (
    <ModalWindow
      open={open}
      onClose={close}
      title={TITLES[step]}
      description={
        step === 'create'
          ? 'Give it a name. You can change it later in guild settings.'
          : 'Paste the invite link someone sent you, or just the code at its end.'
      }
      actions={
        <>
          <Button type="button" variant="ghost" className="mr-auto" onClick={() => goto('choose')}>
            Back
          </Button>
          <Button type="submit" form={formId} disabled={busy || !value.trim()}>
            {step === 'create'
              ? busy
                ? 'Creating…'
                : 'Create guild'
              : busy
                ? 'Joining…'
                : 'Join guild'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => void submit(e)} className="grid gap-3">
        {step === 'create' ? (
          <>
            <Field id="guild-name" label="Guild name">
              <Input
                id="guild-name"
                value={value}
                maxLength={100}
                onChange={(e) => setValue(e.target.value)}
                autoFocus
              />
            </Field>
            <Field id="guild-region" label="Voice region">
              <RegionSelect id="guild-region" value={region} onChange={setRegion} />
            </Field>
          </>
        ) : (
          <Field id="invite" label="Invite link or code">
            <Input
              id="invite"
              className="font-mono text-[13px]"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
            />
          </Field>
        )}
        <ErrorText>{error}</ErrorText>
      </form>
    </ModalWindow>
  )
}

function ChoiceRow(props: {
  icon: React.ReactNode
  title: string
  hint: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="bg-card hover:bg-accent hover:border-muted-foreground group flex items-center gap-3 border p-3 text-left"
    >
      <span className="bg-primary text-primary-foreground flex size-10 shrink-0 items-center justify-center [&_svg]:size-5">
        {props.icon}
      </span>
      <span className="grid min-w-0 flex-1">
        <span className="text-sm font-semibold">{props.title}</span>
        <span className="text-muted-foreground text-xs leading-4">{props.hint}</span>
      </span>
      <ChevronRight className="text-muted-foreground group-hover:text-foreground size-4" />
    </button>
  )
}
