import { useState } from 'react'
import { Crown, Pencil, Plus, Search } from 'lucide-react'
import type { Guild, Member, Role } from '@hachiman/client'
import { GuildMembersMobile } from '@/components/settings/guild-members-mobile'
import { filterMembers, kickCopy } from '@/components/settings/member-gates'
import { useMemberEdit, useMemberGates } from '@/components/settings/use-member-gates'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ErrorText } from '@/components/ui/field'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { RoleChip } from '@/components/ui/role-chip'
import { SystemTag } from '@/components/ui/system-tag'
import { useAction, type Action } from '@/hooks/use-action'
import { useLatched } from '@/hooks/use-latched'
import { useLayout } from '@/hooks/use-layout'
import { useMemberView } from '@/hooks/use-member'
import { displayName, memberRoles } from '@/lib/model'
import { ROLE_INK_SCOPE } from '@/lib/role-ink'
import { cn } from '@/lib/utils'
import { hachiman } from '@/services/hachiman'

const GRID = 'grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_5rem] gap-3 px-3.5'

/** Guild settings → Members: the desktop table, or the phone list (M54). */
export function GuildMembersTab({ guild }: { guild: Guild }): React.JSX.Element {
  return useLayout() === 'mobile' ? (
    <GuildMembersMobile guild={guild} />
  ) : (
    <GuildMembersDesktop guild={guild} />
  )
}

/**
 * Members table with nick + roles. Per-row actions are gated like the server (contract §4):
 * roles → MANAGE_ROLES + hierarchy; nick → self CHANGE_NICKNAME / others MANAGE_NICKNAMES;
 * kick → KICK_MEMBERS, never the owner or yourself.
 */
function GuildMembersDesktop({ guild }: { guild: Guild }): React.JSX.Element {
  const { sorted, roles, assignable, gate } = useMemberGates(guild)
  const [query, setQuery] = useState('')
  const [kicking, setKicking] = useState<Member | null>(null)
  // The name stays in the window while it fades out.
  const kicked = useLatched(kicking)
  const kick = kickCopy(kicked ? displayName(kicked) : '')
  const action = useAction()
  const shown = filterMembers(sorted, query)

  return (
    <div className={cn('grid gap-3', ROLE_INK_SCOPE)}>
      <div className="flex items-center justify-end">
        <div className="relative w-64">
          <Search className="text-text-tertiary pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input
            aria-label="Search members"
            placeholder="Search members"
            className="h-10 pl-9"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      <ErrorText>{action.error}</ErrorText>
      <div
        role="table"
        aria-label="Members"
        className="bg-surface-panel border-line-hairline border"
      >
        <div
          role="row"
          className={`section-label bg-surface-raised/60 border-line-hairline border-b py-2.5 ${GRID}`}
        >
          <span role="columnheader">Name</span>
          <span role="columnheader">Roles</span>
          <span role="columnheader" className="sr-only">
            Actions
          </span>
        </div>
        {shown.map((m) => {
          const { isSelf, isOwner, canNick, canKick } = gate(m)
          return (
            <MemberRow
              key={m.user.id}
              member={m}
              roles={roles}
              isOwner={isOwner}
              isSelf={isSelf}
              canNick={canNick}
              assignable={assignable}
              onKick={canKick ? () => setKicking(m) : undefined}
              run={action.run}
            />
          )
        })}
        {shown.length === 0 && (
          <p className="text-text-tertiary px-2 py-6 text-center text-sm">
            No members match “{query.trim()}”.
          </p>
        )}
      </div>
      <ConfirmDialog
        open={kicking !== null}
        onClose={() => setKicking(null)}
        title={kick.title}
        body={kick.body}
        confirmLabel="Kick"
        what={kick.what}
        tone="danger"
        onConfirm={async () => {
          if (kicking) await hachiman.rest.kickMember(guild.id, kicking.user.id)
        }}
      />
    </div>
  )
}

function MemberRow(props: {
  member: Member
  roles: Map<string, Role> | undefined
  isOwner: boolean
  isSelf: boolean
  canNick: boolean
  /** Roles I may add/remove on this member; empty = no role editing. */
  assignable: Role[]
  /** Absent = no kick button. */
  onKick?: () => void
  run: Action['run']
}): React.JSX.Element {
  const { member, roles, isOwner, isSelf, canNick, assignable, onKick, run } = props
  const { guildId } = member
  const id = member.user.id
  const { name, ink } = useMemberView(guildId, id)
  const [nick, setNick] = useState<string | null>(null) // non-null = editing
  const edit = useMemberEdit(member, name, run)

  const setRoles = (next: string[]): void => void edit.setRoles(next)
  const saveNick = (e: React.FormEvent): void => {
    e.preventDefault()
    void edit.saveNick(nick ?? '')
    setNick(null)
  }
  const canRemove = (r: Role): boolean => assignable.some((a) => a.id === r.id)

  return (
    <div role="row" className={`group hover:bg-surface-hover items-center py-2 ${GRID}`}>
      <div role="cell" className="flex min-w-0 items-center gap-2.5">
        <UserAvatar name={name} avatar={member.user.avatar} color={ink} />
        {nick !== null ? (
          <form onSubmit={saveNick} className="flex min-w-0 flex-1 gap-1">
            <Input
              autoFocus
              aria-label="Nickname"
              data-esc-local
              className="h-7"
              value={nick}
              placeholder={member.user.username}
              onChange={(e) => setNick(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setNick(null)}
            />
            <Button type="submit" size="sm">
              Save
            </Button>
          </form>
        ) : (
          <div className="grid min-w-0">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-medium" style={ink ? { color: ink } : undefined}>
                {name}
              </span>
              {isSelf && <SystemTag kind="you" />}
              {isOwner && (
                <Crown aria-label="Owner" className="text-feature-event-text size-3.5 shrink-0" />
              )}
              {canNick && (
                <IconButton
                  size="sm"
                  label={`Change nickname for ${name}`}
                  className="size-5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={() => setNick(member.nick ?? '')}
                >
                  <Pencil />
                </IconButton>
              )}
            </span>
            {member.nick && (
              <span className="text-text-tertiary truncate font-mono text-xs">
                {member.user.username}
              </span>
            )}
          </div>
        )}
      </div>
      <div role="cell" className="flex min-w-0 flex-wrap items-center gap-1">
        {memberRoles(member, roles).map((r) => (
          <RoleChip
            key={r.id}
            role={r}
            removeLabel={`Remove ${r.name} from ${name}`}
            onRemove={
              canRemove(r) ? () => setRoles(member.roles.filter((x) => x !== r.id)) : undefined
            }
          />
        ))}
        {assignable.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                size="sm"
                label={`Edit roles for ${name}`}
                className="rounded-check border-line-strong border"
              >
                <Plus />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {assignable.map((r) => {
                const on = member.roles.includes(r.id)
                return (
                  <DropdownMenuCheckboxItem
                    key={r.id}
                    checked={on}
                    onSelect={(e) => e.preventDefault()}
                    onCheckedChange={() => void edit.toggleRole(r.id)}
                  >
                    {r.name}
                  </DropdownMenuCheckboxItem>
                )
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <div role="cell" className="flex justify-end">
        {onKick && (
          <Button
            variant="quiet"
            size="sm"
            aria-label={`Kick ${name}`}
            className="text-text-tertiary hover:bg-feature-danger/15 hover:text-feature-danger-text"
            onClick={onKick}
          >
            Kick
          </Button>
        )}
      </div>
    </div>
  )
}
