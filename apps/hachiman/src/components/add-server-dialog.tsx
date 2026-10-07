import { useState } from 'react'
import { ChevronRight, Link2, Lock, Plus, Sparkles } from 'lucide-react'
import { FEATURE_TILE, type Feature } from '@/components/ui/feature'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ErrorText, Field } from '@/components/ui/field'
import { ModalWindow } from '@/components/ui/modal-window'
import { RegionSelect } from '@/components/region-select'
import { useAction } from '@/hooks/use-action'
import type { CreateGuildBody, GuildFull } from '@hachiman/client'
import { adminActionService } from '@/services/AdminActionService'
import { parseInviteLink } from '@/lib/invite-link'
import { acceptInvite, stashInviteKey } from '@/services/InviteService'
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
        icon={<Plus />}
        feature="voice"
        actions={
          <>
            <span className="text-text-secondary text-meta mr-auto flex items-center gap-1.5 self-center">
              <Lock aria-hidden className="text-feature-voice-text size-3.5" />
              Every guild is end-to-end encrypted.
            </span>
            <Button variant="quiet" onClick={close}>
              Cancel
            </Button>
          </>
        }
      >
        <p className="text-text-secondary text-sm">
          A guild is where you and your friends chat and talk. Make your own, or join one you were
          invited to.
        </p>
        <div className="grid gap-3">
          <ChoiceRow
            icon={<Sparkles />}
            feature="accent"
            title="Create a guild"
            hint="Your own place. You’re the owner and set the rules."
            onClick={() => goto('create')}
          />
          <ChoiceRow
            icon={<Link2 />}
            feature="voice"
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
      icon={step === 'create' ? <Sparkles /> : <Link2 />}
      feature={step === 'create' ? 'accent' : 'voice'}
      description={
        step === 'create'
          ? 'Give it a name. You can change it later in guild settings.'
          : 'Paste the invite link someone sent you, or just the code at its end.'
      }
      actions={
        <>
          <Button type="button" variant="quiet" className="mr-auto" onClick={() => goto('choose')}>
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

/** One option card: icon tile and hover border in the feature colour, chevron to the next step. */
function ChoiceRow(props: {
  icon: React.ReactNode
  feature: Extract<Feature, 'accent' | 'voice'>
  title: string
  hint: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        'rounded-option border-line-hairline bg-surface-raised hover:bg-surface-hover focus-visible:outline-line-focus group flex items-center gap-3 border px-3.5 py-3 text-left transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-1',
        props.feature === 'voice' ? 'hover:border-feature-voice' : 'hover:border-accent-primary'
      )}
    >
      <span
        aria-hidden
        className={cn(
          'rounded-control flex size-11 shrink-0 items-center justify-center [&_svg]:size-5',
          FEATURE_TILE[props.feature]
        )}
      >
        {props.icon}
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="text-label text-text-primary">{props.title}</span>
        <span className="text-meta text-text-secondary">{props.hint}</span>
      </span>
      <ChevronRight className="text-text-tertiary group-hover:text-text-primary size-4" />
    </button>
  )
}
