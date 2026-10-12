import { useId, useMemo, useRef, useState } from 'react'
import { Crown, Lock, Search, UserCog, UserMinus } from 'lucide-react'
import type { Guild, Member, Role } from '@hachiman/client'
import { ListGroup, ListRow, SectionLabel } from '@/components/mobile/list'
import { MobileField } from '@/components/mobile/field'
import { Sheet, SheetBody, SheetContent, SheetFoot, SheetHeader } from '@/components/mobile/sheet'
import {
  filterMembers,
  kickCopy,
  membersLine,
  toggleRole,
  type MemberGate
} from '@/components/settings/member-gates'
import { useMemberEdit, useMemberGates } from '@/components/settings/use-member-gates'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ErrorText } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { RoleChip } from '@/components/ui/role-chip'
import { SystemTag } from '@/components/ui/system-tag'
import { useAction } from '@/hooks/use-action'
import { useLatched } from '@/hooks/use-latched'
import { LONG_PRESS_TARGET, useLongPress } from '@/hooks/use-long-press'
import { useMemberView } from '@/hooks/use-member'
import { useOnlineCount } from '@/hooks/use-online-count'
import { displayName, hexColor, memberRoles, rolesByPositionDesc } from '@/lib/model'
import { ROLE_INK_SCOPE } from '@/lib/role-ink'
import { cn } from '@/lib/utils'
import { hachiman } from '@/services/hachiman'
import { usePlatform } from '@/shared/PlatformContext'

/** The server's nickname limit (PATCH members, `nick` max 32). */
const NICK_MAX = 32

/**
 * M54: guild settings → Members on the phone. A search field (filters live), the member and online
 * counts, then one 62 row per member: avatar, the name in its role colour, the username in mono
 * when a nickname hides it, YOU, the owner's crown, the role chips, and Kick where I may kick. A
 * tap or a hold on a row that I may change opens `MemberEditSheet`. Kick asks in a centred
 * confirm (M50).
 */
export function GuildMembersMobile({ guild }: { guild: Guild }): React.JSX.Element {
  const { sorted, roles, assignable, gate } = useMemberGates(guild)
  const online = useOnlineCount(guild.id)
  const platform = usePlatform()
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const editId = useLatched(editing)
  const [kicking, setKicking] = useState<Member | null>(null)
  // The name stays in the window while it fades out.
  const kicked = useLatched(kicking)
  const kick = kickCopy(kicked ? displayName(kicked) : '')
  const shown = useMemo(() => filterMembers(sorted, query), [sorted, query])

  const askKick = (member: Member): void => {
    platform.haptic('warning')
    setKicking(member)
  }

  return (
    <div className={cn('flex flex-col gap-3', ROLE_INK_SCOPE)}>
      <Input
        type="search"
        size="touch"
        lead={<Search />}
        aria-label="Search members"
        placeholder="Search members"
        enterKeyHint="search"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        className="h-11 appearance-none"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        // Search runs as you type: the return key only drops the keyboard.
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      <SectionLabel>{membersLine(sorted.length, online)}</SectionLabel>
      {shown.length > 0 ? (
        <ListGroup role="list" aria-label="Members">
          {shown.map((m) => {
            const memberGate = gate(m)
            return (
              <MemberRow
                key={m.user.id}
                member={m}
                roles={roles}
                gate={memberGate}
                editable={memberGate.canNick || assignable.length > 0 || memberGate.canKick}
                lit={editing === m.user.id || kicking?.user.id === m.user.id}
                kickOpen={kicking?.user.id === m.user.id}
                onOpen={() => setEditing(m.user.id)}
                onKick={() => askKick(m)}
              />
            )
          })}
        </ListGroup>
      ) : (
        query.trim() && (
          <p className="text-text-tertiary px-2 py-6 text-center text-[14.5px] leading-5 font-medium">
            No members match “{query.trim()}”.
          </p>
        )
      )}
      {editId && (
        <MemberEditSheet
          guild={guild}
          userId={editId}
          open={editing !== null}
          onOpenChange={(open) => !open && setEditing(null)}
          roles={roles}
          assignable={assignable}
          gate={gate}
          onKick={askKick}
        />
      )}
      <ConfirmDialog
        open={kicking !== null}
        onClose={() => setKicking(null)}
        title={kick.title}
        description={guild.name}
        body={kick.body}
        confirmLabel="Kick"
        what={kick.what}
        tone="danger"
        icon={<UserMinus />}
        onConfirm={async () => {
          if (!kicking) return
          await hachiman.rest.kickMember(guild.id, kicking.user.id)
          // The member is gone: their sheet under the confirm closes with it.
          setEditing(null)
        }}
      />
    </div>
  )
}

/**
 * One member (M54): 62 high, padding 0/12, gap 12. The name is a button whose hit area covers the
 * row (`after:inset-0`), so the row is the target of the tap and the hold; Kick sits above it.
 * `lit` marks the row while its sheet or its kick confirm is open, and `kickOpen` keeps Kick red
 * under its confirm, as pressed. Rows off screen skip layout and paint (`content-visibility`).
 */
function MemberRow({
  member,
  roles,
  gate,
  editable,
  lit,
  kickOpen,
  onOpen,
  onKick
}: {
  member: Member
  roles: Map<string, Role> | undefined
  gate: MemberGate
  /** I may change the nickname, the roles or kick: the row opens the sheet. */
  editable: boolean
  lit: boolean
  kickOpen: boolean
  onOpen: () => void
  onKick: () => void
}): React.JSX.Element {
  const { name, ink } = useMemberView(member.guildId, member.user.id)
  const press = useLongPress(onOpen, { enabled: editable })
  const held = memberRoles(member, roles)
  const nameClass = 'min-w-0 truncate text-[15px] leading-[18px] font-bold'
  const nameStyle = ink ? { color: ink } : undefined

  return (
    <div
      role="listitem"
      data-lit={lit || undefined}
      className={cn(
        'relative flex min-h-[62px] items-center gap-3 px-3 py-2 select-none',
        '[contain-intrinsic-size:auto_62px] [content-visibility:auto]',
        'data-lit:bg-surface-hover has-[[data-slot=member-open]:active]:bg-surface-hover'
      )}
    >
      <UserAvatar name={name} avatar={member.user.avatar} color={ink} size={36} />
      <div className="flex min-w-0 flex-1 flex-col gap-[5px]">
        <span className="text-text-primary flex min-w-0 items-center gap-1.5">
          {editable ? (
            <button
              type="button"
              data-slot="member-open"
              aria-haspopup="dialog"
              aria-label={`Edit ${name}`}
              onClick={onOpen}
              {...press}
              className={cn(
                nameClass,
                LONG_PRESS_TARGET,
                'text-left outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-line-focus'
              )}
              style={nameStyle}
            >
              {name}
            </button>
          ) : (
            <span className={nameClass} style={nameStyle}>
              {name}
            </span>
          )}
          {member.nick && (
            <span className="text-text-tertiary min-w-0 shrink-[2] truncate font-mono text-[11.5px] leading-4 font-medium">
              {member.user.username}
            </span>
          )}
          {gate.isSelf && <SystemTag kind="you" className="h-4 px-[5px] text-[9.5px]" />}
          {gate.isOwner && (
            <Crown aria-label="Owner" className="text-feature-event-text size-3.5 shrink-0" />
          )}
        </span>
        <RoleChips roles={held} />
      </div>
      {gate.canKick && (
        <button
          type="button"
          aria-label={`Kick ${name}`}
          aria-haspopup="dialog"
          data-state={kickOpen ? 'open' : undefined}
          onClick={onKick}
          className={cn(
            'rounded-control text-text-secondary relative flex h-9 shrink-0 items-center border border-transparent bg-(--fill-control) px-3 text-[13.5px] leading-4 font-bold outline-none',
            'focus-visible:outline-line-focus focus-visible:outline-2 focus-visible:outline-offset-1',
            'active:border-feature-danger/35 active:bg-feature-danger/15 active:text-feature-danger-text',
            'data-[state=open]:border-feature-danger/35 data-[state=open]:bg-feature-danger/15 data-[state=open]:text-feature-danger-text'
          )}
        >
          Kick
        </button>
      )}
    </div>
  )
}

/** The role chips of a member (22, they wrap), or "No role". */
function RoleChips({ roles }: { roles: Role[] }): React.JSX.Element {
  if (roles.length === 0) {
    return <span className="text-text-tertiary text-xs leading-4 font-semibold">No role</span>
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      {roles.map((r) => (
        <RoleChip key={r.id} role={r} size="sm" className="max-w-full overflow-hidden" />
      ))}
    </span>
  )
}

/**
 * The edit sheet of one member (H3; not the chat's `MemberSheet`): the nickname, the role
 * checklist and Kick, each where I may use it. A role toggle saves at once, as a signed admin
 * action. The nickname saves from the foot, which shows while the field differs. It closes by
 * itself when the member leaves the guild.
 */
export function MemberEditSheet({
  guild,
  userId,
  open,
  onOpenChange,
  roles,
  assignable,
  gate,
  onKick
}: {
  guild: Guild
  userId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  roles: Map<string, Role> | undefined
  /** The roles I may add or remove; empty: the roles show read-only. */
  assignable: Role[]
  gate: (member: Member) => MemberGate
  /** Asks to kick: the confirm opens over the sheet. */
  onKick: (member: Member) => void
}): React.JSX.Element | null {
  const { member: live } = useMemberView(guild.id, userId)
  // Keeps the content while the sheet slides out after the member left.
  const member = useLatched(live)
  if (!member) return null
  return (
    <Sheet open={open && live !== undefined} onOpenChange={onOpenChange}>
      <SheetContent>
        <MemberEditBody
          guild={guild}
          member={member}
          roles={roles}
          assignable={assignable}
          gate={gate(member)}
          onKick={() => onKick(member)}
        />
      </SheetContent>
    </Sheet>
  )
}

/** The sheet's content. It mounts with each open, so the nickname draft starts fresh. */
function MemberEditBody({
  guild,
  member,
  roles,
  assignable,
  gate,
  onKick
}: {
  guild: Guild
  member: Member
  roles: Map<string, Role> | undefined
  assignable: Role[]
  gate: MemberGate
  onKick: () => void
}): React.JSX.Element {
  // The kept member, so the name stays while the sheet slides out after they left.
  const name = displayName(member)
  const action = useAction()
  const edit = useMemberEdit(member, name, action.run)
  const formId = useId()
  const nickId = useId()
  const nickInput = useRef<HTMLInputElement>(null)
  const username = member.user.username
  const [draft, setDraft] = useState(member.nick ?? '')
  const dirty = gate.canNick && draft.trim() !== (member.nick ?? '')

  // A role toggle shows at once; the store's roles take over when the member update arrives.
  const [optimistic, setOptimistic] = useState<{ base: string[]; next: string[] } | null>(null)
  const current = optimistic?.base === member.roles ? optimistic.next : member.roles

  const toggle = async (roleId: string): Promise<void> => {
    const next = toggleRole(current, roleId)
    setOptimistic({ base: member.roles, next })
    if (!(await edit.setRoles(next)).ok) setOptimistic(null)
  }

  const saveNick = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!dirty || action.busy) return
    const next = draft.trim()
    if ((await edit.saveNick(next)).ok) {
      setDraft(next)
      nickInput.current?.blur()
    }
  }

  // The checklist: the roles I may change, and the member's roles above my reach (locked).
  const assignableIds = new Set(assignable.map((r) => r.id))
  const held = memberRoles(member, roles)
  const checklist =
    assignable.length > 0
      ? rolesByPositionDesc([...assignable, ...held.filter((r) => !assignableIds.has(r.id))])
      : null

  return (
    <>
      <SheetHeader
        icon={<UserCog />}
        title={name}
        subtitle={member.nick ? `${username} · ${guild.name}` : guild.name}
      />
      <SheetBody>
        {gate.canNick && (
          <form id={formId} onSubmit={(e) => void saveNick(e)}>
            <MobileField
              id={nickId}
              label="Nickname"
              hint={`Shown in ${guild.name} in place of ${username}. Leave it empty to show the username.`}
            >
              <Input
                ref={nickInput}
                size="touch"
                value={draft}
                placeholder={username}
                maxLength={NICK_MAX}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                enterKeyHint="done"
                onChange={(e) => setDraft(e.target.value)}
              />
            </MobileField>
          </form>
        )}
        <section className="flex flex-col gap-2" aria-label="Roles">
          <SectionLabel>Roles</SectionLabel>
          {checklist ? (
            <ListGroup>
              {checklist.map((r) => (
                <RoleCheckRow
                  key={r.id}
                  role={r}
                  checked={current.includes(r.id)}
                  locked={!assignableIds.has(r.id)}
                  disabled={action.busy}
                  onToggle={() => void toggle(r.id)}
                />
              ))}
            </ListGroup>
          ) : (
            <div className="px-1">
              <RoleChips roles={held} />
            </div>
          )}
        </section>
        {gate.canKick && (
          <ListGroup tone="danger">
            <ListRow tone="danger" icon={<UserMinus />} label={`Kick ${name}`} onClick={onKick} />
          </ListGroup>
        )}
        <ErrorText>{action.error}</ErrorText>
      </SheetBody>
      {dirty && (
        <SheetFoot>
          <Button type="submit" form={formId} size="mobile" disabled={action.busy}>
            Save nickname
          </Button>
        </SheetFoot>
      )}
    </>
  )
}

/**
 * A 48 checklist row: the whole row is the checkbox's label. A locked role (at or above my top
 * role) shows checked with a lock and does not change.
 */
function RoleCheckRow({
  role,
  checked,
  locked,
  disabled,
  onToggle
}: {
  role: Role
  checked: boolean
  locked: boolean
  disabled: boolean
  onToggle: () => void
}): React.JSX.Element {
  const id = useId()
  const off = locked || disabled
  return (
    <label
      htmlFor={id}
      className={cn(
        'flex min-h-12 items-center gap-3 px-3.5',
        off ? 'cursor-default' : 'active:bg-surface-hover cursor-pointer',
        locked && 'opacity-60'
      )}
    >
      <Checkbox
        id={id}
        size="lg"
        checked={checked}
        disabled={off}
        aria-describedby={locked ? `${id}-locked` : undefined}
        onChange={onToggle}
      />
      <span
        aria-hidden
        className="size-2 shrink-0"
        style={{ background: role.color ? hexColor(role.color) : 'var(--text-secondary)' }}
      />
      <span className="text-text-primary min-w-0 flex-1 truncate text-[15px] leading-[18px] font-semibold">
        {role.name}
      </span>
      {locked && (
        <>
          <Lock aria-hidden className="text-text-tertiary size-4 shrink-0" />
          <span id={`${id}-locked`} className="sr-only">
            Above your highest role
          </span>
        </>
      )}
    </label>
  )
}
