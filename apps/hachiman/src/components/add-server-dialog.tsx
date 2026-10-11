import { useState } from 'react'
import { ChevronRight, ClipboardPaste, Link2, Lock, Plus, Sparkles } from 'lucide-react'
import { MobileField } from '@/components/mobile/field'
import { FEATURE_TILE, type Feature } from '@/components/ui/feature'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ErrorText, Field } from '@/components/ui/field'
import { ModalWindow } from '@/components/ui/modal-window'
import { RegionSelect } from '@/components/region-select'
import { useAction } from '@/hooks/use-action'
import { useLayout } from '@/hooks/use-layout'
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

/** The Sheet Header subtitle of each step on the mobile layout (M44): one short line. */
const MOBILE_SUBTITLES: Record<Step, string> = {
  choose: 'Start your own, or join one',
  create: 'You’re the owner and set the rules.',
  join: 'Paste a link or code someone sent you.'
}

/**
 * Rail "+": first pick create or join (like Discord), then a one-field form. On the mobile layout
 * it is one sheet (M44): no Cancel (the Sheet Header closes it), the E2EE note in the body, and
 * Back as a 48 button above the submit.
 */
export function AddServerDialog(): React.JSX.Element {
  const { open, close } = useDialog('addGuild')
  const mobile = useLayout() === 'mobile'
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
        description={mobile ? MOBILE_SUBTITLES.choose : undefined}
        icon={<Plus />}
        feature="voice"
        actions={
          mobile ? undefined : (
            <>
              <span className="text-text-secondary text-meta mr-auto flex items-center gap-1.5 self-center">
                <Lock aria-hidden className="text-feature-voice-text size-3.5" />
                Every guild is end-to-end encrypted.
              </span>
              <Button variant="quiet" onClick={close}>
                Cancel
              </Button>
            </>
          )
        }
      >
        <p className="text-text-secondary mobile:text-[15px] mobile:leading-[23px] mobile:font-medium text-sm">
          A guild is where you and your friends chat and talk. Make your own, or join one you were
          invited to.
        </p>
        <div className="mobile:gap-2.5 grid gap-3">
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
        {mobile && (
          <p className="text-text-tertiary flex items-center justify-center gap-1.5 pt-1 text-[13px] leading-4 font-semibold">
            <Lock aria-hidden className="text-feature-voice-text size-[13px] shrink-0" />
            Every guild is end-to-end encrypted.
          </p>
        )}
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
        mobile
          ? MOBILE_SUBTITLES[step]
          : step === 'create'
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
      <form id={formId} onSubmit={(e) => void submit(e)} className="mobile:gap-4 grid gap-3">
        {mobile ? (
          // No autoFocus: the keyboard rises when the user taps a field (spec §2.8).
          step === 'create' ? (
            <>
              <MobileField id="guild-name" label="Guild name">
                <Input
                  size="touch"
                  value={value}
                  maxLength={100}
                  enterKeyHint="go"
                  onChange={(e) => setValue(e.target.value)}
                />
              </MobileField>
              <MobileField id="guild-region" label="Voice region">
                <RegionSelect size="touch" className="w-full" value={region} onChange={setRegion} />
              </MobileField>
              <ErrorText>{error}</ErrorText>
            </>
          ) : (
            <MobileField id="invite" label="Invite link or code" error={error}>
              <InvitePasteField
                value={value}
                onChange={(text) => {
                  setValue(text)
                  clearError()
                }}
              />
            </MobileField>
          )
        ) : (
          <>
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
          </>
        )}
      </form>
    </ModalWindow>
  )
}

/**
 * The mono invite field of the mobile join step, with a Paste button at its end that reads the
 * clipboard (on iOS the system asks first; a refusal changes nothing). No button where the page
 * cannot read the clipboard: the field's own paste works there.
 */
function InvitePasteField({
  value,
  onChange
}: {
  value: string
  onChange: (text: string) => void
}): React.JSX.Element {
  const canRead = typeof navigator.clipboard?.readText === 'function'
  const paste = (): void => {
    navigator.clipboard.readText().then(
      (text) => onChange(text.trim()),
      () => undefined
    )
  }
  return (
    <span className="relative flex w-full min-w-0">
      <Input
        size="touch"
        className={cn('font-mono', canRead && 'pr-[94px]')}
        value={value}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        enterKeyHint="go"
        onChange={(e) => onChange(e.target.value)}
      />
      {canRead && (
        <button
          type="button"
          onClick={paste}
          className="text-text-primary active:bg-fill-control-strong focus-visible:outline-line-focus absolute top-1.5 right-1.5 flex h-9 items-center gap-1.5 bg-fill-control rounded-[6px] px-3 text-[14px] font-bold outline-none focus-visible:outline-2 focus-visible:-outline-offset-2"
        >
          <ClipboardPaste aria-hidden className="size-4" />
          Paste
        </button>
      )}
    </span>
  )
}

/** The rest look of a choice card on the mobile layout (M44): tinted, with a tinted border. */
const CHOICE_TINT: Record<'accent' | 'voice', string> = {
  accent:
    'mobile:border-accent-primary/40 mobile:bg-accent-primary/6 mobile:active:bg-accent-primary/12',
  voice:
    'mobile:border-feature-voice/30 mobile:bg-feature-voice/5 mobile:active:bg-feature-voice/10'
}

/** The chevron of a choice card on the mobile layout: in the feature colour. */
const CHOICE_CHEVRON: Record<'accent' | 'voice', string> = {
  accent: 'mobile:text-accent-text',
  voice: 'mobile:text-feature-voice-text'
}

/**
 * One option card: icon tile and hover border in the feature colour, chevron to the next step.
 * On the mobile layout (no hover on touch) the card is tinted at rest (M44).
 */
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
        props.feature === 'voice' ? 'hover:border-feature-voice' : 'hover:border-accent-primary',
        'mobile:gap-3.5 mobile:p-3.5',
        CHOICE_TINT[props.feature]
      )}
    >
      <span
        aria-hidden
        className={cn(
          'mobile:[&_svg]:size-[22px] flex size-11 shrink-0 items-center justify-center [&_svg]:size-5',
          FEATURE_TILE[props.feature]
        )}
      >
        {props.icon}
      </span>
      <span className="mobile:gap-[3px] grid min-w-0 flex-1 gap-0.5">
        <span className="text-label text-text-primary mobile:text-[16px] mobile:leading-[19px] mobile:font-extrabold">
          {props.title}
        </span>
        <span className="text-meta text-text-secondary mobile:text-[13.5px] mobile:leading-[19px] mobile:font-medium">
          {props.hint}
        </span>
      </span>
      <ChevronRight
        className={cn(
          'text-text-tertiary group-hover:text-text-primary mobile:size-[18px] size-4',
          CHOICE_CHEVRON[props.feature]
        )}
      />
    </button>
  )
}
