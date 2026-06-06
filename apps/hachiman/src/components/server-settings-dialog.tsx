/**
 * Server Settings dialog. Opens from a right-click on the active server icon.
 *
 * Three tabs:
 *
 *   Roles ────── manages groups on the root channel (channel 0). Mumble's
 *                permission system propagates root-channel groups into every
 *                child channel by default, so this is the Discord-equivalent
 *                "server roles" view. Each role has:
 *                  • a name
 *                  • a member list (pulled from the server's registered-users
 *                    table, so offline users are addable too)
 *                  • a per-permission allow / deny / inherit tri-state
 *
 *   Channels ── per-channel ACL overrides. Pick a channel, see its raw ACL
 *                entries (one per group or user target), and edit grant/deny
 *                masks. Mirrors Discord's "Channel Permissions" page.
 *
 *   Health ──── operator voice-relay diagnostics. Fetches a live relay
 *                thin/on-path snapshot over the authenticated control channel
 *                (`IMumbleService.fetchRelayMetrics`) and renders the
 *                forwarding path + per-hop latency. Operator-gated server-side;
 *                shows an "operator only" state when the server denies.
 *
 * Persists by calling `IMumbleService.fetchAcl` / `saveAcl`. The save payload
 * mirrors what Mumble Client sends: groups with `inherited:false` (so the
 * server treats them as locally-defined), and `acls` containing every entry
 * we want kept (Mumble's `saveAcl` is a wholesale replace, not a diff).
 *
 * SuperUser is required to read or write ACLs server-side; we surface a
 * friendly disabled state if the current user isn't admin.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ACL, ACL_ChanACL, ACL_ChanGroup, Channel } from '@hachiman/hachiman-node'
import { PermissionDeniedError } from '@hachiman/hachiman-node'
import { CheckIcon, MinusIcon, PlusIcon, TrashIcon, XIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  ALL_PERMISSIONS,
  BUILTIN_GROUPS,
  CHANNEL_PERMISSIONS,
  ROOT_PERMISSIONS,
  type PermissionDef
} from '@/lib/mumble-permissions'
import { fmtMs, placeholderRelayPath, type RelayPathSnapshot } from '@/lib/connection-quality'
import type { IMumbleService } from '@/shared/IMumbleService'
import { connectionManager } from '@/services/ServersService'
import { useServerStore } from '@/stores/serverStore'

interface ServerSettingsDialogProps {
  open: boolean
  serverId: string | null
  onClose: () => void
  /**
   * When set, the dialog opens directly on `initialTab` (defaults to
   * 'channels') with `initialChannelId` pre-selected in the Channels tab.
   * Used by the channel-sidebar context menu's "Manage Channel" action.
   * Cleared internally on close so the next open without these props
   * falls back to the default Roles tab.
   */
  initialTab?: 'roles' | 'channels' | 'health'
  initialChannelId?: number | null
}

type RegisteredUser = { userId: number; name: string }

type TriState = 'allow' | 'deny' | 'inherit'

const ROOT_CHANNEL_ID = 0

function bitState(grant: number, deny: number, bit: number): TriState {
  if ((grant & bit) !== 0) return 'allow'
  if ((deny & bit) !== 0) return 'deny'
  return 'inherit'
}

function withBitState(
  grant: number,
  deny: number,
  bit: number,
  next: TriState
): { grant: number; deny: number } {
  let g = grant & ~bit
  let d = deny & ~bit
  if (next === 'allow') g |= bit
  else if (next === 'deny') d |= bit
  return { grant: g, deny: d }
}

function findGroup(acl: ACL, name: string): ACL_ChanGroup | undefined {
  return acl.groups.find((g) => g.name === name)
}

/** Clone an ACL so React state changes don't mutate the wire object. */
function cloneAcl(acl: ACL): ACL {
  return {
    ...acl,
    groups: acl.groups.map((g) => ({
      ...g,
      add: [...g.add],
      remove: [...g.remove],
      inheritedMembers: [...g.inheritedMembers]
    })),
    acls: acl.acls.map((a) => ({ ...a }))
  }
}

export function ServerSettingsDialog(props: ServerSettingsDialogProps): React.JSX.Element {
  // Memoize the service lookup so a render doesn't churn the effect dep array
  // (Map.get returns a stable reference, but we re-read on every render which
  // makes React's Object.is comparison flap if the connection drops).
  const service = useMemo(
    () => (props.serverId ? connectionManager.get(props.serverId) : null),
    [props.serverId]
  )
  const isConnected = service?.isConnected() ?? false
  const isSuperUser = service?.currentUser?.userId === 0

  // The server's configured voice region, for the Health tab's relay-path
  // labelling. Forward-declared in serverStore (not populated by the sync
  // layer yet — REGION-CONTRACT); reads as a single primitive (string | null
  // | undefined), so no fresh-literal selector concern. null/undefined → the
  // Health tab shows an "unplaced / region unknown" label.
  const relayRegion = useServerStore((s) =>
    props.serverId ? (s.servers.get(props.serverId)?.region ?? null) : null
  )

  const [tab, setTab] = useState<'roles' | 'channels' | 'health'>('roles')
  const [registeredUsers, setRegisteredUsers] = useState<RegisteredUser[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)

  // Per-tab state. The Roles tab always operates on the root channel; the
  // Channels tab tracks the user's selection.
  const [rootAcl, setRootAcl] = useState<ACL | null>(null)
  const [rootSelectedGroup, setRootSelectedGroup] = useState<string | null>(null)
  const [rootSaving, setRootSaving] = useState(false)

  const [channelAclByChannel, setChannelAclByChannel] = useState<Map<number, ACL>>(new Map())
  const [selectedChannelId, setSelectedChannelId] = useState<number | null>(null)
  const [channelSaving, setChannelSaving] = useState(false)

  // Inline add-role + delete-role UI replaces window.prompt/window.confirm,
  // which Electron's renderer blocks outright (`prompt() is not supported`).
  const [addRoleDraft, setAddRoleDraft] = useState<string | null>(null)
  const [addRoleError, setAddRoleError] = useState<string | null>(null)
  const [deleteRoleCandidate, setDeleteRoleCandidate] = useState<string | null>(null)

  // De-dupe the initial fetch across StrictMode's double-mount. Without this,
  // we'd queue two identical fetchAcl commands on the same channelId; the
  // server only emits one ACL response, so the second command sits forever
  // (until its 10s timeout), and during that window the next Ping fights for
  // a socket that may already be half-closed. Key includes (serverId, open)
  // so a real reopen still triggers a refresh.
  const loadedKeyRef = useRef<string | null>(null)

  const channels: Channel[] = useMemo(() => service?.channels ?? [], [service])

  // Reset state every time the dialog reopens (or switches server). If the
  // caller seeded an initial tab / channel (right-click "Manage Channel"),
  // honor those instead of defaulting to the Roles tab.
  useEffect(() => {
    if (!props.open) return
    setTab(props.initialTab ?? 'roles')
    setRegisteredUsers([])
    setLoadError(null)
    setRootAcl(null)
    setRootSelectedGroup(null)
    setRootSaving(false)
    setChannelAclByChannel(new Map())
    setSelectedChannelId(props.initialChannelId ?? null)
    setChannelSaving(false)
    setAddRoleDraft(null)
    setAddRoleError(null)
    setDeleteRoleCandidate(null)
    loadedKeyRef.current = null
  }, [props.open, props.serverId, props.initialTab, props.initialChannelId])

  // Initial load: registered users + root ACL. Both require RegisterPermission
  // / WritePermission server-side — so we *only* fire when the current session
  // is SuperUser. Issuing these as a normal user gets PermissionDenied (no
  // matching ACL response, our command times out, and in StrictMode the
  // duplicate compounds it). The friendly "SuperUser required" panel below
  // covers the gated case.
  useEffect(() => {
    if (!props.open || !service || !isConnected || !isSuperUser) return
    const key = `${props.serverId}`
    if (loadedKeyRef.current === key) return
    loadedKeyRef.current = key

    let cancelled = false
    void (async () => {
      try {
        const [users, acl] = await Promise.all([
          service.fetchRegisteredUsers(),
          service.fetchAcl(ROOT_CHANNEL_ID)
        ])
        if (cancelled) return
        setRegisteredUsers(users)
        setRootAcl(cloneAcl(acl))
        // Default to the first non-builtin group, or fall through to the
        // first one if none qualify (typical first-boot servers have only
        // `admin` and `auth`).
        const firstUserGroup = acl.groups.find((g) => !BUILTIN_GROUPS.has(g.name)) ?? acl.groups[0]
        setRootSelectedGroup(firstUserGroup?.name ?? null)
      } catch (err) {
        if (!cancelled) {
          // Reset the dedupe key so a retry (e.g. re-open) can re-attempt.
          loadedKeyRef.current = null
          setLoadError(
            err instanceof Error
              ? err.message
              : 'Failed to load ACLs — SuperUser is required to manage permissions.'
          )
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [props.open, props.serverId, service, isConnected, isSuperUser])

  // Lazy-load per-channel ACLs the first time the user picks a channel.
  useEffect(() => {
    if (!service || selectedChannelId === null) return
    if (channelAclByChannel.has(selectedChannelId)) return
    let cancelled = false
    void (async () => {
      try {
        const acl = await service.fetchAcl(selectedChannelId)
        if (cancelled) return
        setChannelAclByChannel((prev) => {
          const next = new Map(prev)
          next.set(selectedChannelId, cloneAcl(acl))
          return next
        })
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'Failed to load channel ACL.')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [service, selectedChannelId, channelAclByChannel])

  const userNameById = useMemo(() => {
    const m = new Map<number, string>()
    for (const u of registeredUsers) m.set(u.userId, u.name)
    return m
  }, [registeredUsers])

  // ---- Roles tab handlers ----

  const updateRootAcl = useCallback((mutator: (draft: ACL) => void) => {
    setRootAcl((prev) => {
      if (!prev) return prev
      const draft = cloneAcl(prev)
      mutator(draft)
      return draft
    })
  }, [])

  const beginAddRole = (): void => {
    setAddRoleError(null)
    setAddRoleDraft('')
  }

  const cancelAddRole = (): void => {
    setAddRoleDraft(null)
    setAddRoleError(null)
  }

  const commitAddRole = (): void => {
    const name = (addRoleDraft ?? '').trim()
    if (!name) {
      setAddRoleError('Name is required.')
      return
    }
    if (rootAcl?.groups.some((g) => g.name === name)) {
      setAddRoleError(`A role named "${name}" already exists.`)
      return
    }
    updateRootAcl((draft) => {
      draft.groups.push({
        name,
        inherited: false,
        inherit: true,
        inheritable: true,
        add: [],
        remove: [],
        inheritedMembers: []
      })
    })
    setRootSelectedGroup(name)
    setAddRoleDraft(null)
    setAddRoleError(null)
  }

  const requestDeleteRole = (name: string): void => {
    if (BUILTIN_GROUPS.has(name)) return
    setDeleteRoleCandidate(name)
  }

  const confirmDeleteRole = (): void => {
    const name = deleteRoleCandidate
    if (!name) return
    updateRootAcl((draft) => {
      draft.groups = draft.groups.filter((g) => g.name !== name)
      draft.acls = draft.acls.filter((a) => a.group !== name)
    })
    if (rootSelectedGroup === name) {
      setRootSelectedGroup(rootAcl?.groups.find((g) => g.name !== name)?.name ?? null)
    }
    setDeleteRoleCandidate(null)
  }

  const toggleRoleMember = (groupName: string, userId: number): void => {
    updateRootAcl((draft) => {
      const grp = findGroup(draft, groupName)
      if (!grp) return
      const has = grp.add.includes(userId)
      grp.add = has ? grp.add.filter((id) => id !== userId) : [...grp.add, userId]
      // Editing a group locally also flips `inherited:false` so the server
      // treats it as defined here rather than purely inherited from a parent.
      grp.inherited = false
    })
  }

  const setRolePermission = (groupName: string, perm: PermissionDef, next: TriState): void => {
    updateRootAcl((draft) => {
      let entry = draft.acls.find((a) => a.group === groupName && a.userId === undefined)
      if (!entry) {
        entry = {
          applyHere: true,
          applySubs: true,
          inherited: false,
          group: groupName,
          grant: 0,
          deny: 0
        }
        draft.acls.push(entry)
      }
      const { grant, deny } = withBitState(entry.grant ?? 0, entry.deny ?? 0, perm.bit, next)
      entry.grant = grant
      entry.deny = deny
      entry.inherited = false
      // Drop empty entries to keep the saved ACL tidy.
      if (entry.grant === 0 && entry.deny === 0) {
        draft.acls = draft.acls.filter((a) => a !== entry)
      }
    })
  }

  const saveRoles = async (): Promise<void> => {
    if (!service || !rootAcl) return
    setRootSaving(true)
    setLoadError(null)
    try {
      await service.saveAcl(ROOT_CHANNEL_ID, {
        ...rootAcl,
        channelId: ROOT_CHANNEL_ID,
        // Server expects query=false (the absence is fine) when persisting.
        query: false
      })
      const fresh = await service.fetchAcl(ROOT_CHANNEL_ID)
      setRootAcl(cloneAcl(fresh))
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to save roles.')
    } finally {
      setRootSaving(false)
    }
  }

  // ---- Channels tab handlers ----

  const selectedChannelAcl =
    selectedChannelId !== null ? (channelAclByChannel.get(selectedChannelId) ?? null) : null

  const updateChannelAcl = useCallback((channelId: number, mutator: (draft: ACL) => void) => {
    setChannelAclByChannel((prev) => {
      const existing = prev.get(channelId)
      if (!existing) return prev
      const next = new Map(prev)
      const draft = cloneAcl(existing)
      mutator(draft)
      next.set(channelId, draft)
      return next
    })
  }, [])

  const addChannelAclEntry = (
    channelId: number,
    target: { kind: 'group'; group: string } | { kind: 'user'; userId: number }
  ): void => {
    updateChannelAcl(channelId, (draft) => {
      draft.acls.push({
        applyHere: true,
        applySubs: false,
        inherited: false,
        ...(target.kind === 'group' ? { group: target.group } : { userId: target.userId }),
        grant: 0,
        deny: 0
      })
    })
  }

  const removeChannelAclEntry = (channelId: number, index: number): void => {
    updateChannelAcl(channelId, (draft) => {
      draft.acls.splice(index, 1)
    })
  }

  const setChannelAclPermission = (
    channelId: number,
    index: number,
    perm: PermissionDef,
    next: TriState
  ): void => {
    updateChannelAcl(channelId, (draft) => {
      const entry = draft.acls[index]
      if (!entry) return
      const { grant, deny } = withBitState(entry.grant ?? 0, entry.deny ?? 0, perm.bit, next)
      entry.grant = grant
      entry.deny = deny
      entry.inherited = false
    })
  }

  const setChannelAclScope = (
    channelId: number,
    index: number,
    key: 'applyHere' | 'applySubs',
    value: boolean
  ): void => {
    updateChannelAcl(channelId, (draft) => {
      const entry = draft.acls[index]
      if (!entry) return
      entry[key] = value
      entry.inherited = false
    })
  }

  const saveChannelAcl = async (): Promise<void> => {
    if (!service || selectedChannelId === null || !selectedChannelAcl) return
    setChannelSaving(true)
    setLoadError(null)
    try {
      await service.saveAcl(selectedChannelId, {
        ...selectedChannelAcl,
        channelId: selectedChannelId,
        query: false
      })
      const fresh = await service.fetchAcl(selectedChannelId)
      setChannelAclByChannel((prev) => {
        const next = new Map(prev)
        next.set(selectedChannelId, cloneAcl(fresh))
        return next
      })
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to save channel ACL.')
    } finally {
      setChannelSaving(false)
    }
  }

  const handleOpenChange = (next: boolean): void => {
    if (!next) props.onClose()
  }

  return (
    <Dialog open={props.open && props.serverId !== null} onOpenChange={handleOpenChange}>
      {/* Override the primitive's default `grid` layout with `flex flex-col`
          (tw-merge keeps the later display class) so the body fills the
          dialog and the ScrollAreas inside can constrain themselves. */}
      <DialogContent className="flex h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>Server Settings — {props.serverId}</DialogTitle>
          <DialogDescription>
            Manage roles and per-channel permissions. SuperUser access required.
          </DialogDescription>
        </DialogHeader>

        {!isConnected ? (
          <div className="text-muted-foreground p-6 text-sm">
            You need an active connection to this server to manage its settings.
          </div>
        ) : !isSuperUser ? (
          <div className="text-muted-foreground p-6 text-sm">
            Only the SuperUser (or users in the <code className="font-mono">admin</code> group) can
            read and edit ACLs. Reconnect as SuperUser to continue.
          </div>
        ) : (
          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as 'roles' | 'channels' | 'health')}
            className="flex min-h-0 flex-1 flex-col gap-0"
          >
            <div className="px-6 pt-3">
              <TabsList>
                <TabsTrigger value="roles">Roles</TabsTrigger>
                <TabsTrigger value="channels">Channels</TabsTrigger>
                <TabsTrigger value="health">Health</TabsTrigger>
              </TabsList>
            </div>
            <Separator className="mt-3" />
            {loadError ? (
              <div className="text-destructive border-destructive/40 bg-destructive/10 mx-6 mt-3 rounded-md border px-3 py-2 text-sm">
                {loadError}
              </div>
            ) : null}

            <TabsContent value="roles" className="overflow-hidden">
              <RolesTab
                acl={rootAcl}
                selectedGroup={rootSelectedGroup}
                onSelectGroup={setRootSelectedGroup}
                onBeginAddRole={beginAddRole}
                onChangeAddRoleDraft={setAddRoleDraft}
                onCancelAddRole={cancelAddRole}
                onCommitAddRole={commitAddRole}
                addRoleDraft={addRoleDraft}
                addRoleError={addRoleError}
                onRequestDeleteRole={requestDeleteRole}
                onToggleMember={toggleRoleMember}
                onSetPermission={setRolePermission}
                registeredUsers={registeredUsers}
                saving={rootSaving}
                onSave={() => void saveRoles()}
              />
            </TabsContent>
            {/* Delete-role confirm. Lives inside the outer Dialog so it
                naturally sits above the settings UI without needing a portal
                handoff. Two-step pattern matches the user's request that
                destructive actions get an explicit confirm step. */}
            <Dialog
              open={deleteRoleCandidate !== null}
              onOpenChange={(next) => {
                if (!next) setDeleteRoleCandidate(null)
              }}
            >
              <DialogContent className="sm:max-w-sm">
                <DialogHeader>
                  <DialogTitle>Delete role</DialogTitle>
                  <DialogDescription>
                    This removes the <code className="font-mono">{deleteRoleCandidate}</code> role
                    and any per-channel overrides referencing it. Click Save afterwards to persist
                    on the server.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setDeleteRoleCandidate(null)}>
                    Cancel
                  </Button>
                  <Button variant="destructive" onClick={confirmDeleteRole}>
                    Delete
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <TabsContent value="channels" className="overflow-hidden">
              <ChannelsTab
                channels={channels}
                selectedChannelId={selectedChannelId}
                onSelectChannel={setSelectedChannelId}
                acl={selectedChannelAcl}
                rootGroups={rootAcl?.groups.map((g) => g.name) ?? []}
                registeredUsers={registeredUsers}
                userNameById={userNameById}
                onAddEntry={(target) =>
                  selectedChannelId !== null && addChannelAclEntry(selectedChannelId, target)
                }
                onRemoveEntry={(idx) =>
                  selectedChannelId !== null && removeChannelAclEntry(selectedChannelId, idx)
                }
                onSetPermission={(idx, perm, next) =>
                  selectedChannelId !== null &&
                  setChannelAclPermission(selectedChannelId, idx, perm, next)
                }
                onSetScope={(idx, key, value) =>
                  selectedChannelId !== null &&
                  setChannelAclScope(selectedChannelId, idx, key, value)
                }
                saving={channelSaving}
                onSave={() => void saveChannelAcl()}
              />
            </TabsContent>

            <TabsContent value="health" className="overflow-hidden">
              <HealthTab relayRegion={relayRegion} service={service} active={tab === 'health'} />
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ───────────────────────── Health / Diagnostics tab ─────────────────────────

/**
 * Operator voice-health view: the forwarding path (client → regional ingress →
 * on-host wake proxy → SFU), the per-hop added latency, and an on-path
 * indicator.
 *
 * Live data, fetched over the authenticated control channel. On mount (when the
 * tab is shown) we call `IMumbleService.fetchRelayMetrics()`, which sends a
 * `RelayMetricsQuery` and maps the `RelayMetricsSnapshot` reply onto the
 * `RelayPathSnapshot` shape rendered below. The server gates the query on
 * operator privilege (SuperUser / root-channel Write) and rejects everyone else
 * with PermissionDenied — surfaced here as a clearly-marked "operator only"
 * state. While loading (or on any other error) we fall back to the
 * `placeholderRelayPath` topology with null latencies (em-dashes), so the
 * intended path shape is always visible without inventing numbers.
 */
type HealthStatus = 'loading' | 'ready' | 'denied' | 'error'

function HealthTab({
  relayRegion,
  service,
  active
}: {
  relayRegion: string | null
  service: IMumbleService | null
  active: boolean
}): React.JSX.Element {
  // Stable placeholder identity for the not-yet-loaded / denied / error states.
  const placeholder: RelayPathSnapshot = useMemo(
    () => placeholderRelayPath(relayRegion),
    [relayRegion]
  )

  const [status, setStatus] = useState<HealthStatus>('loading')
  const [data, setData] = useState<RelayPathSnapshot | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // De-dupe the fetch across StrictMode's double-mount and re-renders. Keyed on
  // (active, connected) so toggling away and back, or a reconnect, re-fetches.
  const isConnected = service?.isConnected() ?? false
  const fetchedKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!active || !service || !isConnected) return
    const key = `${active}|${isConnected}`
    if (fetchedKeyRef.current === key) return
    fetchedKeyRef.current = key

    let cancelled = false
    // State resets live inside the async body (not synchronously in the effect)
    // to avoid a cascading re-render; mirrors the ACL-load effect above.
    void (async () => {
      setStatus('loading')
      setErrorMsg(null)
      try {
        const snap = await service.fetchRelayMetrics()
        if (cancelled) return
        setData(snap)
        setStatus('ready')
      } catch (err) {
        if (cancelled) return
        // Reset the dedupe key so a re-open / reconnect can retry.
        fetchedKeyRef.current = null
        if (err instanceof PermissionDeniedError) {
          setStatus('denied')
        } else {
          setStatus('error')
          setErrorMsg(err instanceof Error ? err.message : 'Failed to load relay metrics.')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [active, service, isConnected])

  // Render the live snapshot once ready; otherwise the placeholder topology.
  const snapshot = status === 'ready' && data ? data : placeholder

  // onPath === null → unknown (no metrics yet); true/false → real verdict.
  const onPathLabel =
    snapshot.onPath === null ? 'Unknown' : snapshot.onPath ? 'On-path' : 'Off-path'
  const onPathColor =
    snapshot.onPath === null
      ? 'bg-muted-foreground'
      : snapshot.onPath
        ? 'bg-green-500'
        : 'bg-destructive'

  return (
    <ScrollArea className="h-full min-h-0">
      <div className="space-y-6 p-6">
        {/* Summary row: region + on-path verdict */}
        <section className="grid grid-cols-2 gap-4">
          <div className="border-border rounded-md border p-4">
            <span className="text-muted-foreground text-xs font-semibold uppercase">
              Voice region
            </span>
            <p className="mt-1 text-sm font-medium">
              {snapshot.relayRegion ?? 'Unplaced (no region selected)'}
            </p>
          </div>
          <div className="border-border rounded-md border p-4">
            <span className="text-muted-foreground text-xs font-semibold uppercase">On-path</span>
            <p className="mt-1 flex items-center gap-2 text-sm font-medium">
              <span className={`h-2.5 w-2.5 rounded-full ${onPathColor}`} />
              {onPathLabel}
            </p>
          </div>
        </section>

        {/* Forwarding path with per-hop region + latency */}
        <section className="space-y-3">
          <Label>Voice forwarding path</Label>
          <ol className="border-border divide-border divide-y rounded-md border">
            {snapshot.hops.map((hop, idx) => {
              const hopOnPathColor =
                hop.onPath === null
                  ? 'bg-muted-foreground'
                  : hop.onPath
                    ? 'bg-green-500'
                    : 'bg-destructive'
              return (
                <li
                  key={`${hop.label}-${idx}`}
                  className="flex items-center justify-between gap-3 px-3 py-2.5"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${hopOnPathColor}`} />
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium">{hop.label}</span>
                      <span className="text-muted-foreground text-xs">
                        {hop.region ?? 'region —'}
                      </span>
                    </div>
                  </div>
                  <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                    {fmtMs(hop.latencyMs)}
                  </span>
                </li>
              )
            })}
          </ol>
        </section>

        {/* Thin-hop latency budget */}
        <section className="space-y-3">
          <Label>Relay forwarding hop (thin budget)</Label>
          <div className="border-border grid grid-cols-3 gap-px overflow-hidden rounded-md border bg-border">
            <HealthStat label="Mean added" value={fmtMs(snapshot.hopMeanMs)} />
            <HealthStat label="Max added" value={fmtMs(snapshot.hopMaxMs)} />
            <HealthStat label="Budget" value={fmtMs(snapshot.hopBudgetMs)} />
          </div>
          {snapshot.overBudgetCount != null && snapshot.overBudgetCount > 0 ? (
            <p className="text-destructive text-xs">
              {snapshot.overBudgetCount} forwarding hop
              {snapshot.overBudgetCount === 1 ? '' : 's'} exceeded the thin-hop latency budget.
            </p>
          ) : null}
        </section>

        {/* Status footer: reflects the live fetch state. */}
        {status === 'denied' ? (
          <p className="text-muted-foreground border-t pt-3 text-[11px] leading-snug">
            Relay metrics are <span className="font-medium">operator only</span>. The server
            requires SuperUser access (or Write permission on the root channel) to read them. The
            path and on-path indicator above reflect the intended topology; live values are
            unavailable for your account.
          </p>
        ) : status === 'error' ? (
          <p className="text-destructive border-t pt-3 text-[11px] leading-snug">
            Couldn&rsquo;t load live relay metrics{errorMsg ? `: ${errorMsg}` : '.'} Showing the
            intended path shape with values as <span className="font-mono">—</span>.
          </p>
        ) : status === 'loading' ? (
          <p className="text-muted-foreground border-t pt-3 text-[11px] leading-snug">
            Measuring… fetching live relay metrics from the server. Values shown as{' '}
            <span className="font-mono">—</span> until the snapshot arrives.
          </p>
        ) : (
          <p className="text-muted-foreground border-t pt-3 text-[11px] leading-snug">
            Live relay metrics fetched over the authenticated control channel. The relay only
            instruments its own forwarding hop, so upstream hop latencies show as{' '}
            <span className="font-mono">—</span>.
          </p>
        )}
      </div>
    </ScrollArea>
  )
}

function HealthStat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="bg-background flex flex-col gap-1 p-3">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="text-sm font-medium tabular-nums">{value}</span>
    </div>
  )
}

// ───────────────────────── Roles tab ─────────────────────────

interface RolesTabProps {
  acl: ACL | null
  selectedGroup: string | null
  onSelectGroup: (name: string) => void
  /** null = no add UI; string = input visible with this current draft value. */
  addRoleDraft: string | null
  addRoleError: string | null
  onBeginAddRole: () => void
  onChangeAddRoleDraft: (next: string) => void
  onCancelAddRole: () => void
  onCommitAddRole: () => void
  onRequestDeleteRole: (name: string) => void
  onToggleMember: (group: string, userId: number) => void
  onSetPermission: (group: string, perm: PermissionDef, next: TriState) => void
  registeredUsers: RegisteredUser[]
  saving: boolean
  onSave: () => void
}

function RolesTab(props: RolesTabProps): React.JSX.Element {
  const group = props.acl?.groups.find((g) => g.name === props.selectedGroup) ?? null
  const entry =
    group && props.acl
      ? props.acl.acls.find((a) => a.group === group.name && a.userId === undefined)
      : null

  const addingRole = props.addRoleDraft !== null

  return (
    // `min-h-0` here + on `<aside>` / `<section>` lets the inner ScrollAreas
    // shrink to fit the dialog instead of pushing the layout past it.
    <div className="flex h-full min-h-0">
      <aside className="flex w-56 min-h-0 flex-col border-r">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-muted-foreground text-xs font-semibold uppercase">Roles</span>
          {!addingRole && (
            <Button
              size="icon"
              variant="ghost"
              className="size-6"
              onClick={props.onBeginAddRole}
              aria-label="Add role"
            >
              <PlusIcon className="size-4" />
            </Button>
          )}
        </div>
        {addingRole && (
          <div className="flex flex-col gap-1 px-3 pb-2">
            <Input
              autoFocus
              value={props.addRoleDraft ?? ''}
              placeholder="Role name…"
              className="h-7 text-xs"
              onChange={(e) => props.onChangeAddRoleDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') props.onCommitAddRole()
                if (e.key === 'Escape') props.onCancelAddRole()
              }}
            />
            <div className="flex justify-end gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                onClick={props.onCancelAddRole}
              >
                Cancel
              </Button>
              <Button size="sm" className="h-6 px-2 text-xs" onClick={props.onCommitAddRole}>
                Add
              </Button>
            </div>
            {props.addRoleError ? (
              <span className="text-destructive text-[11px]">{props.addRoleError}</span>
            ) : null}
          </div>
        )}
        <ScrollArea className="flex-1 min-h-0">
          <ul className="px-1 pb-2">
            {(props.acl?.groups ?? []).map((g) => {
              const builtin = BUILTIN_GROUPS.has(g.name)
              const active = g.name === props.selectedGroup
              return (
                <li key={g.name}>
                  <button
                    type="button"
                    onClick={() => props.onSelectGroup(g.name)}
                    className={`hover:bg-accent flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm ${
                      active ? 'bg-accent' : ''
                    }`}
                  >
                    <span className={builtin ? 'text-muted-foreground italic' : ''}>{g.name}</span>
                    {builtin ? (
                      <span className="text-muted-foreground text-[10px] uppercase">built-in</span>
                    ) : null}
                  </button>
                </li>
              )
            })}
          </ul>
        </ScrollArea>
      </aside>
      <section className="flex flex-1 flex-col overflow-hidden min-h-0">
        {!group ? (
          <div className="text-muted-foreground p-6 text-sm">
            Select a role or add a new one to edit its members and permissions.
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between border-b px-6 py-3">
              <div className="flex flex-col">
                <h3 className="text-base font-semibold">{group.name}</h3>
                <span className="text-muted-foreground text-xs">
                  {BUILTIN_GROUPS.has(group.name)
                    ? 'Built-in group — membership is computed by the server.'
                    : `${group.add.length + group.inheritedMembers.length} member${
                        group.add.length + group.inheritedMembers.length === 1 ? '' : 's'
                      }`}
                </span>
              </div>
              {!BUILTIN_GROUPS.has(group.name) && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => props.onRequestDeleteRole(group.name)}
                  aria-label="Delete role"
                >
                  <TrashIcon className="text-destructive size-4" />
                </Button>
              )}
            </div>
            <ScrollArea className="flex-1 min-h-0">
              <div className="space-y-6 p-6">
                {!BUILTIN_GROUPS.has(group.name) && (
                  <section className="space-y-3">
                    <Label>Members</Label>
                    <MemberPicker
                      registeredUsers={props.registeredUsers}
                      selectedUserIds={[...group.add, ...group.inheritedMembers]}
                      addableUserIds={group.add}
                      inheritedUserIds={group.inheritedMembers}
                      onToggle={(userId) => props.onToggleMember(group.name, userId)}
                    />
                  </section>
                )}
                <section className="space-y-3">
                  <Label>Permissions</Label>
                  <PermissionMatrix
                    permissions={[...CHANNEL_PERMISSIONS, ...ROOT_PERMISSIONS]}
                    grant={entry?.grant ?? 0}
                    deny={entry?.deny ?? 0}
                    onChange={(perm, next) => props.onSetPermission(group.name, perm, next)}
                  />
                </section>
              </div>
            </ScrollArea>
          </>
        )}
        <div className="flex items-center justify-end gap-2 border-t px-6 py-3">
          <Button onClick={props.onSave} disabled={props.saving || !props.acl}>
            {props.saving ? 'Saving…' : 'Save roles'}
          </Button>
        </div>
      </section>
    </div>
  )
}

// ───────────────────────── Channels tab ─────────────────────────

interface ChannelsTabProps {
  channels: Channel[]
  selectedChannelId: number | null
  onSelectChannel: (id: number) => void
  acl: ACL | null
  rootGroups: string[]
  registeredUsers: RegisteredUser[]
  userNameById: Map<number, string>
  onAddEntry: (target: { kind: 'group'; group: string } | { kind: 'user'; userId: number }) => void
  onRemoveEntry: (index: number) => void
  onSetPermission: (index: number, perm: PermissionDef, next: TriState) => void
  onSetScope: (index: number, key: 'applyHere' | 'applySubs', value: boolean) => void
  saving: boolean
  onSave: () => void
}

function ChannelsTab(props: ChannelsTabProps): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-56 min-h-0 flex-col border-r">
        <div className="px-3 py-2">
          <span className="text-muted-foreground text-xs font-semibold uppercase">Channels</span>
        </div>
        <ScrollArea className="flex-1 min-h-0">
          <ul className="px-1 pb-2">
            {props.channels.map((c) => {
              const active = c.id === props.selectedChannelId
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => props.onSelectChannel(c.id)}
                    className={`hover:bg-accent flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm ${
                      active ? 'bg-accent' : ''
                    }`}
                  >
                    <span>{c.name || `Channel ${c.id}`}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </ScrollArea>
      </aside>
      <section className="flex flex-1 flex-col overflow-hidden min-h-0">
        {props.selectedChannelId === null ? (
          <div className="text-muted-foreground p-6 text-sm">
            Select a channel to edit its permission overrides.
          </div>
        ) : !props.acl ? (
          <div className="text-muted-foreground p-6 text-sm">Loading channel ACL…</div>
        ) : (
          <ChannelAclEditor {...props} acl={props.acl} />
        )}
      </section>
    </div>
  )
}

interface ChannelAclEditorProps extends ChannelsTabProps {
  acl: ACL
}

function ChannelAclEditor(props: ChannelAclEditorProps): React.JSX.Element {
  const [addTarget, setAddTarget] = useState<string>('')
  const addOptions = useMemo(() => {
    const groupOptions = props.rootGroups.map((g) => ({
      value: `group:${g}`,
      label: `Group · ${g}`
    }))
    const userOptions = props.registeredUsers.map((u) => ({
      value: `user:${u.userId}`,
      label: `User · ${u.name}`
    }))
    return [...groupOptions, ...userOptions]
  }, [props.rootGroups, props.registeredUsers])

  return (
    <>
      <ScrollArea className="flex-1 min-h-0">
        <div className="space-y-4 p-6">
          {props.acl.acls.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No per-channel overrides. Inherits from parent channels.
            </p>
          ) : null}
          {props.acl.acls.map((entry, idx) => (
            <ChannelAclRow
              key={`${entry.group ?? entry.userId}-${idx}`}
              entry={entry}
              userName={
                entry.userId !== undefined
                  ? (props.userNameById.get(entry.userId) ?? `#${entry.userId}`)
                  : null
              }
              onRemove={() => props.onRemoveEntry(idx)}
              onSetPermission={(perm, next) => props.onSetPermission(idx, perm, next)}
              onSetScope={(key, value) => props.onSetScope(idx, key, value)}
            />
          ))}
          <div className="border-border flex items-end gap-2 border-t pt-4">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="add-acl-target">Add override for</Label>
              <select
                id="add-acl-target"
                className="border-input bg-background h-9 rounded-md border px-3 text-sm"
                value={addTarget}
                onChange={(e) => setAddTarget(e.target.value)}
              >
                <option value="">Select a group or user…</option>
                {addOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <Button
              type="button"
              disabled={!addTarget}
              onClick={() => {
                const [kind, value] = addTarget.split(':')
                if (kind === 'group') props.onAddEntry({ kind: 'group', group: value })
                if (kind === 'user') props.onAddEntry({ kind: 'user', userId: Number(value) })
                setAddTarget('')
              }}
            >
              <PlusIcon className="size-4" /> Add
            </Button>
          </div>
        </div>
      </ScrollArea>
      <div className="flex items-center justify-end gap-2 border-t px-6 py-3">
        <Button onClick={props.onSave} disabled={props.saving}>
          {props.saving ? 'Saving…' : 'Save channel'}
        </Button>
      </div>
    </>
  )
}

interface ChannelAclRowProps {
  entry: ACL_ChanACL
  userName: string | null
  onRemove: () => void
  onSetPermission: (perm: PermissionDef, next: TriState) => void
  onSetScope: (key: 'applyHere' | 'applySubs', value: boolean) => void
}

function ChannelAclRow(props: ChannelAclRowProps): React.JSX.Element {
  const targetLabel =
    props.entry.userId !== undefined ? `User · ${props.userName}` : `Group · ${props.entry.group}`

  return (
    <div className="border-border rounded-md border p-4">
      <div className="flex items-center justify-between gap-2 pb-3">
        <span className="text-sm font-medium">{targetLabel}</span>
        <Button variant="ghost" size="icon" onClick={props.onRemove} aria-label="Remove override">
          <XIcon className="size-4" />
        </Button>
      </div>
      <div className="flex gap-4 pb-3 text-xs">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={props.entry.applyHere ?? true}
            onChange={(e) => props.onSetScope('applyHere', e.target.checked)}
          />
          Apply to this channel
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={props.entry.applySubs ?? false}
            onChange={(e) => props.onSetScope('applySubs', e.target.checked)}
          />
          Apply to sub-channels
        </label>
      </div>
      <PermissionMatrix
        permissions={CHANNEL_PERMISSIONS}
        grant={props.entry.grant ?? 0}
        deny={props.entry.deny ?? 0}
        onChange={props.onSetPermission}
      />
    </div>
  )
}

// ───────────────────────── Shared widgets ─────────────────────────

function PermissionMatrix(props: {
  permissions: PermissionDef[]
  grant: number
  deny: number
  onChange: (perm: PermissionDef, next: TriState) => void
}): React.JSX.Element {
  return (
    <div className="divide-border divide-y rounded-md border">
      {props.permissions.map((perm) => {
        const state = bitState(props.grant, props.deny, perm.bit)
        return (
          <div key={perm.key} className="flex items-start justify-between gap-3 px-3 py-2">
            <div className="flex min-w-0 flex-col">
              <span className="text-sm font-medium">{perm.label}</span>
              <span className="text-muted-foreground text-xs">{perm.description}</span>
            </div>
            <TriStateToggle value={state} onChange={(next) => props.onChange(perm, next)} />
          </div>
        )
      })}
    </div>
  )
}

function TriStateToggle(props: {
  value: TriState
  onChange: (next: TriState) => void
}): React.JSX.Element {
  const options: Array<{ value: TriState; icon: React.ReactNode; label: string }> = [
    { value: 'deny', icon: <XIcon className="size-3.5" />, label: 'Deny' },
    { value: 'inherit', icon: <MinusIcon className="size-3.5" />, label: 'Inherit' },
    { value: 'allow', icon: <CheckIcon className="size-3.5" />, label: 'Allow' }
  ]
  return (
    <div className="border-border inline-flex shrink-0 overflow-hidden rounded-md border">
      {options.map((o) => {
        const active = o.value === props.value
        const bg =
          active && o.value === 'allow'
            ? 'bg-primary text-primary-foreground'
            : active && o.value === 'deny'
              ? 'bg-destructive text-destructive-foreground'
              : active
                ? 'bg-muted text-foreground'
                : 'hover:bg-accent'
        return (
          <button
            key={o.value}
            type="button"
            aria-label={o.label}
            onClick={() => props.onChange(o.value)}
            className={`inline-flex h-7 w-7 items-center justify-center text-xs transition-colors ${bg}`}
          >
            {o.icon}
          </button>
        )
      })}
    </div>
  )
}

function MemberPicker(props: {
  registeredUsers: RegisteredUser[]
  selectedUserIds: number[]
  addableUserIds: number[]
  inheritedUserIds: number[]
  onToggle: (userId: number) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return props.registeredUsers
      .filter((u) => u.userId !== 0) // SuperUser is implicit; don't expose
      .filter((u) => !q || u.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [props.registeredUsers, query])

  const isInherited = (id: number): boolean => props.inheritedUserIds.includes(id)
  const isAdded = (id: number): boolean => props.addableUserIds.includes(id)

  return (
    <div className="border-border rounded-md border">
      <div className="border-b p-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search registered users (includes offline)…"
          className="h-8"
        />
      </div>
      <ScrollArea className="h-48">
        {filtered.length === 0 ? (
          <p className="text-muted-foreground p-3 text-sm">No matching users.</p>
        ) : (
          <ul>
            {filtered.map((u) => {
              const added = isAdded(u.userId)
              const inherited = isInherited(u.userId)
              return (
                <li key={u.userId} className="hover:bg-accent flex items-center gap-2 px-3 py-1.5">
                  <input
                    type="checkbox"
                    checked={added || inherited}
                    disabled={inherited && !added}
                    onChange={() => props.onToggle(u.userId)}
                  />
                  <span className="text-sm">{u.name}</span>
                  {inherited ? (
                    <span className="text-muted-foreground ml-auto text-xs">inherited</span>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </ScrollArea>
    </div>
  )
}

// Re-export so other files don't import from the proto package directly when
// they only need the role-list view of the catalog.
export { ALL_PERMISSIONS }
