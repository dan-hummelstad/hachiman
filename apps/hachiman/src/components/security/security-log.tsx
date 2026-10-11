import { useState } from 'react'
import { Check, RefreshCw, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react'
import type { DeviceSummary, KtSelfCheckResult } from '@hachiman/crypto'
import { SectionLabel } from '@/components/mobile/list'
import { DockedFoot, MobileFoot } from '@/components/mobile/foot'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Chip } from '@/components/ui/chip'
import { FEATURE_TILE } from '@/components/ui/feature'
import { ErrorText, SectionHeading } from '@/components/ui/field'
import { PlatformIcon, useOwnDevices } from '@/components/security/devices-panel'
import { friendly } from '@/components/security/errors'
import { useAction } from '@/hooks/use-action'
import { useLayout } from '@/hooks/use-layout'
import { PLATFORM_ICON, PLATFORM_LABEL } from '@/lib/device-platform'
import { dayStart, formatDayMonthYear } from '@/lib/time-format'
import { cn } from '@/lib/utils'
import { cryptoService } from '@/services/CryptoService'
import { usePlatform } from '@/shared/PlatformContext'
import { dismissKtAlerts, useCryptoStore } from '@/stores/cryptoStore'
import { useUserStore } from '@/stores/userStore'

const ENTRY_TYPE: Record<number, string> = {
  1: 'Security key',
  2: 'Device signing key',
  3: 'Device added',
  4: 'Device removed'
}

const ALERT_TEXT: Record<string, string> = {
  self_unknown_entry:
    'The key log has a key change for your account that none of your devices made.',
  split_view: 'The server showed two different versions of the key log.',
  bad_proof: 'The server could not prove that a key is in the key log.',
  kt_missing: 'The server sent a key that is not in the key log. The key was rejected.'
}

const ALERT_ADVICE =
  'Look at your device list. Sign out each device that you do not know, then make a new recovery key.'

const DAY = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })
const TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

/**
 * The day of a key log row on the mobile layout: "Today", else the day and month ("14 Sep"), with
 * the year when it is not this year's ("2 Aug 2025"). A time in the future (clock skew) is today.
 * Empty for a broken time.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function keyLogDay(iso: string, now: number = Date.now(), locale?: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  if (dayStart(ms) >= dayStart(now)) return 'Today'
  return formatDayMonthYear(ms, now, locale)
}

/** One row of the key log timeline: a device of this account. */
export interface KeyLogRow {
  device: DeviceSummary
  /** "Added this device", "Added Hachiman Desktop". */
  title: string
  /** Mobile: the kind of app, then "has your security key" or "signed out". */
  meta: string
  /** Mobile: see `keyLogDay`. */
  day: string
}

/**
 * The key log timeline (§12.14): the devices of this account, newest first. The Worker checks the
 * real log; the rows show the devices that it holds the account's changes against.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function keyLogRows(
  devices: readonly DeviceSummary[] | null,
  now: number = Date.now(),
  locale?: string
): KeyLogRow[] {
  return [...(devices ?? [])]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((d) => {
      const state =
        d.status === 'revoked' ? 'signed out' : d.primary ? 'has your security key' : null
      return {
        device: d,
        title: `Added ${d.current ? 'this device' : d.name}`,
        meta: state ? `${PLATFORM_LABEL[d.platform]} · ${state}` : PLATFORM_LABEL[d.platform],
        day: keyLogDay(d.createdAt, now, locale)
      }
    })
}

/** The time of a check: "today, 09:39", or "14 Sep, 09:39" after midnight. */
function checkedAt(at: Date): string {
  const now = Date.now()
  const day = dayStart(at.getTime()) === dayStart(now) ? 'today' : formatDayMonthYear(at, now)
  return `${day}, ${TIME.format(at)}`
}

interface KtCheck {
  value: KtSelfCheckResult
  at: Date
}

/**
 * The key transparency self-check on demand (§12.14). The result lives while the page shows. A
 * haptic tells the result on iOS: success for a clean log, warning for changes or an error.
 */
function useKtCheck(): {
  result: KtCheck | null
  busy: boolean
  error: string | null
  check: () => Promise<void>
} {
  const platform = usePlatform()
  const [result, setResult] = useState<KtCheck | null>(null)
  const { run, busy, error } = useAction()
  const check = async (): Promise<void> => {
    const r = await run('check the key log', () => friendly(cryptoService.client().ktSelfCheck()))
    platform.haptic(r.ok && r.value.ok ? 'success' : 'warning')
    if (r.ok) setResult({ value: r.value, at: new Date() })
  }
  return { result, busy, error, check }
}

/**
 * User settings → Security log (H4 on the desktop layout, M28 on the mobile layout, §12.14): the
 * key transparency self-check as one status card, the alerts, and the devices of this account as
 * a timeline. The Worker checks the log every 24 hours and on each key change of this account.
 */
export function SecurityLog(): React.JSX.Element {
  return useLayout() === 'mobile' ? <SecurityLogMobile /> : <SecurityLogDesktop />
}

function SecurityLogDesktop(): React.JSX.Element {
  const alerts = useCryptoStore((s) => s.ktAlerts)
  const me = useUserStore((s) => s.me?.username)
  const { devices } = useOwnDevices()
  const { result, busy, error, check } = useKtCheck()

  const bad = alerts.length > 0 || result?.value.ok === false
  const timeline = keyLogRows(devices)

  return (
    <div className="grid gap-6">
      <div
        className={cn(
          'flex items-center gap-3 border px-4 py-3',
          bad
            ? 'border-feature-danger/50 bg-feature-danger/5'
            : 'bg-surface-panel border-line-hairline'
        )}
      >
        <span
          className={cn(
            'flex size-9 shrink-0 items-center justify-center [&_svg]:size-5',
            bad
              ? 'bg-feature-danger/15 text-feature-danger-text'
              : result
                ? 'bg-feature-voice/15 text-feature-voice-text'
                : 'bg-surface-raised text-text-tertiary'
          )}
        >
          {bad ? <ShieldAlert /> : result ? <ShieldCheck /> : <ShieldQuestion />}
        </span>
        <div className="grid min-w-0 flex-1" role="status">
          <span className="text-label">
            {bad
              ? 'The log has changes that none of your devices made'
              : result
                ? 'All clear'
                : 'Not checked from this window yet'}
          </span>
          <span className="text-meta text-text-tertiary">
            {result
              ? `Last checked at ${TIME.format(result.at)} · the log has ${result.value.treeSize} entries`
              : 'Your devices also check it every 24 hours and on each key change.'}
          </span>
        </div>
        <Button variant="secondary" size="lg" disabled={busy} onClick={() => void check()}>
          <RefreshCw className={cn(busy && 'animate-spin')} />
          {busy ? 'Checking…' : 'Check the key log'}
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>

      {result && !result.value.ok && <UnknownEntries result={result.value} />}

      {alerts.length > 0 && (
        <section className="grid gap-2">
          <SectionHeading className="mb-0">Alerts</SectionHeading>
          {alerts.map((a, i) => (
            <Callout key={i} tone="danger">
              <b>{ALERT_TEXT[a.kind] ?? a.kind}</b>
              {a.detail && <span className="text-text-tertiary block">{a.detail}</span>}
            </Callout>
          ))}
          <p className="text-meta text-text-tertiary">{ALERT_ADVICE}</p>
          <div>
            <Button variant="quiet" size="sm" onClick={dismissKtAlerts}>
              Dismiss alerts
            </Button>
          </div>
        </section>
      )}

      {timeline.length > 0 && (
        <section>
          <SectionHeading>Devices{me && ` · ${me}`}</SectionHeading>
          <ol className="grid">
            {timeline.map(({ device: d, title }, i) => (
              <li key={d.id} className="relative flex gap-3 pb-4">
                {i < timeline.length - 1 && (
                  <span
                    aria-hidden
                    className="bg-line-strong absolute top-9 bottom-0 left-[17px] w-0.5"
                  />
                )}
                <span className="bg-surface-raised border-line-hairline text-text-secondary flex size-9 shrink-0 items-center justify-center rounded-full border [&_svg]:size-4">
                  <PlatformIcon platform={d.platform} />
                </span>
                <div className="grid min-w-0 flex-1 pt-1">
                  <span className="text-label">{title}</span>
                  <span className="text-meta text-text-tertiary">
                    {d.status === 'revoked'
                      ? 'Signed out since'
                      : d.primary
                        ? 'Has your security key'
                        : PLATFORM_LABEL[d.platform]}
                  </span>
                </div>
                <span className="text-meta text-text-tertiary shrink-0 pt-1">
                  {DAY.format(new Date(d.createdAt))}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  )
}

/** The entries of a failed check that no own device made. */
function UnknownEntries({ result }: { result: KtSelfCheckResult }): React.JSX.Element {
  return (
    <ul className="grid gap-1 text-sm">
      {result.unknownEntries.map((e) => (
        <li
          key={e.index}
          className="text-feature-danger-text font-mono text-[13px] [overflow-wrap:anywhere]"
        >
          #{e.index} {ENTRY_TYPE[e.type] ?? `Type ${e.type}`}
          {e.deviceId && ` · device ${e.deviceId}`}
        </li>
      ))}
    </ul>
  )
}

/**
 * M28: the status card with no button, the alerts, "KEY LOG · name" as a timeline (node 32, the
 * line, title, date), and "Check now" docked at the foot, so it stays in reach when
 * the body scrolls (iPhone SE). Each row gets the "Yours" chip only after a check on this page
 * came back clean. The intro paragraph comes from the settings screen.
 */
function SecurityLogMobile(): React.JSX.Element {
  const alerts = useCryptoStore((s) => s.ktAlerts)
  const me = useUserStore((s) => s.me?.username)
  const { devices } = useOwnDevices()
  const { result, busy, error, check } = useKtCheck()
  const [root, setRoot] = useState<HTMLDivElement | null>(null)

  const bad = alerts.length > 0 || result?.value.ok === false
  const yours = !bad && result?.value.ok === true
  const rows = keyLogRows(devices)

  return (
    <div ref={setRoot} className="flex flex-col gap-3">
      <div
        role="status"
        className={cn(
          'flex items-center gap-3.5 border px-4 py-3.5',
          bad
            ? 'border-feature-danger/22 bg-feature-danger/5'
            : result
              ? 'border-feature-voice/22 bg-feature-voice/5'
              : 'border-line-hairline bg-white/2'
        )}
      >
        <span
          aria-hidden
          className={cn(
            'flex size-10 shrink-0 items-center justify-center [&_svg]:size-5',
            bad
              ? FEATURE_TILE.danger
              : result
                ? FEATURE_TILE.voice
                : 'bg-surface-raised text-text-tertiary'
          )}
        >
          {bad ? <ShieldAlert /> : result ? <ShieldCheck /> : <ShieldQuestion />}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-text-primary text-[15.5px] leading-5 font-extrabold">
            {bad
              ? 'The log has changes that none of your devices made'
              : result
                ? 'All clear'
                : 'Not checked yet'}
          </p>
          <p className="text-text-secondary text-[13px] leading-[1.45] font-medium">
            {result
              ? `Last checked ${checkedAt(result.at)}${result.value.ok ? ' · every change came from your devices' : ''}`
              : 'Your devices also check it every 24 hours and on each key change.'}
          </p>
        </div>
      </div>
      {error && (
        <p
          role="alert"
          className="text-feature-danger-text text-[13px] leading-[1.4] font-semibold"
        >
          {error}
        </p>
      )}

      {result && !result.value.ok && <UnknownEntries result={result.value} />}

      {alerts.length > 0 && (
        <section className="flex flex-col gap-2.5">
          <SectionLabel className="pt-2">Alerts</SectionLabel>
          {alerts.map((a, i) => (
            <Callout key={i} size="touch" tone="danger" title={ALERT_TEXT[a.kind] ?? a.kind}>
              {a.detail}
            </Callout>
          ))}
          <p className="text-text-tertiary text-[13px] leading-[1.5] font-medium">{ALERT_ADVICE}</p>
          <Button variant="quiet" size="lg" className="self-start" onClick={dismissKtAlerts}>
            Dismiss alerts
          </Button>
        </section>
      )}

      {rows.length > 0 && (
        <section className="flex flex-col">
          <SectionLabel className="pt-2">
            Key log{me && <span className="normal-case"> · {me}</span>}
          </SectionLabel>
          <ol className="flex flex-col pt-4">
            {rows.map(({ device: d, title, meta, day }, i) => {
              const Icon = PLATFORM_ICON[d.platform]
              return (
                <li key={d.id} className="flex gap-3">
                  <span aria-hidden className="flex w-8 shrink-0 flex-col items-center">
                    <span className="bg-surface-raised border-line-hairline text-text-secondary flex size-8 shrink-0 items-center justify-center rounded-full border [&_svg]:size-[15px]">
                      <Icon />
                    </span>
                    {i < rows.length - 1 && (
                      <span className="bg-line-hairline min-h-[30px] w-0.5 flex-1" />
                    )}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-[5px] pb-3">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-text-primary min-w-0 text-[14.5px] leading-5 font-bold [overflow-wrap:anywhere]">
                        {title}
                      </span>
                      {yours && (
                        <Chip tone="voice" icon={<Check />}>
                          Yours
                        </Chip>
                      )}
                    </div>
                    <span className="text-text-tertiary text-[12.5px] leading-4 font-medium">
                      {meta}
                    </span>
                  </div>
                  <span className="text-text-tertiary shrink-0 pt-[7px] text-[12.5px] leading-4 font-semibold">
                    {day}
                  </span>
                </li>
              )
            })}
          </ol>
        </section>
      )}

      {/* M28's footnote is not here: the intro of the settings screen already says it. */}
      <DockedFoot anchor={root}>
        <MobileFoot className="bg-surface-content -mx-4">
          <Button variant="secondary" size="mobile" disabled={busy} onClick={() => void check()}>
            <RefreshCw className={cn(busy && 'animate-spin')} />
            {busy ? 'Checking…' : 'Check now'}
          </Button>
        </MobileFoot>
      </DockedFoot>
    </div>
  )
}
