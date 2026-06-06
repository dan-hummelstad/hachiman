import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { serversService } from '@/services/ServersService'
import { channelsService } from '@/services/ChannelsService'

import { AddServerDialog, type AddServerSubmission } from '@/components/add-server-dialog'
import { CreateChannelDialog } from '@/components/create-channel-dialog'
import { JoinServerModal } from '@/components/join-server-modal'
import { RemoveServerDialog } from '@/components/remove-server-dialog'
import { ServerIconRail } from '@/components/server-icon-rail'
import { ServerSettingsDialog } from '@/components/server-settings-dialog'
import { SuperUserPasswordDialog } from '@/components/superuser-password-dialog'
import { ChannelSidebar } from '@/components/channel-sidebar'
import { ChatArea } from '@/components/chat-area'
import { MemberList } from '@/components/member-list'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { TooltipProvider } from '@/components/ui/tooltip'

import { useTakusenJoinUri } from '@/hooks/use-takusen-join-uri'
import { useServerStore } from '@/stores/serverStore'
import { useChannelStore, type Channel, type ChannelType } from '@/stores/channelStore'
import { useVoiceStore } from '@/stores/voiceStore'
import { useOracleStore } from '@/stores/oracleStore'

// Stable empty-array reference for the no-channels case so downstream
// memoization and prop equality holds across renders.
const EMPTY_CHANNELS: Channel[] = []

function App(): React.JSX.Element {
  const { servers, selectedServerId } = useServerStore(
    useShallow((s) => ({ servers: s.servers, selectedServerId: s.selectedServerId }))
  )
  const { channels, selectedChannelByServer } = useChannelStore(
    useShallow((s) => ({
      channels: s.channels,
      selectedChannelByServer: s.selectedChannelByServer
    }))
  )
  const voiceChannelByServer = useVoiceStore((s) => s.voiceChannelByServer)
  const oracleSession = useOracleStore((s) => s.session)
  const [openAddServerDialog, setOpenAddServerDialog] = useState(false)
  // createChannelTarget carries the prospective parent id alongside the
  // type so the dialog can label itself ("Create Subchannel of #general")
  // and the create call can nest correctly. parentId === undefined means
  // top-level (under root) — the section "+" button path.
  const [createChannelTarget, setCreateChannelTarget] = useState<{
    type: ChannelType
    parentId?: number
  } | null>(null)
  // When set by the channel-sidebar context menu's "Manage Channel" item,
  // opens ServerSettingsDialog pre-targeted at the Channels tab with this
  // channel selected. Cleared on dialog close so the next plain "Server
  // Settings" open lands back on the Roles tab.
  const [manageChannelTarget, setManageChannelTarget] = useState<{
    serverId: string
    channelId: number
  } | null>(null)
  // The right-click "Delete channel" target awaiting user confirmation.
  // Deletion is destructive (cascades to subchannels + persisted text
  // history server-side; see Server.RemoveChannel) so we always route
  // through a confirm step rather than letting the menu item fire
  // straight through to ChannelsService.deleteChannel.
  const [deleteChannelTarget, setDeleteChannelTarget] = useState<{
    serverId: string
    channelId: number
  } | null>(null)
  const [membersOpen, setMembersOpen] = useState(true)
  // SuperUser sessions need a fresh password per connect (never persisted).
  // When `pendingSuperUserPrompt` is non-null, a modal blocks reconnect until
  // the user supplies the password (or cancels, which leaves the server
  // selected but unconnected).
  const [pendingSuperUserPrompt, setPendingSuperUserPrompt] = useState<{
    url: string
    port: string
    username: string
  } | null>(null)
  const [settingsServerId, setSettingsServerId] = useState<string | null>(null)
  const [removingServerId, setRemovingServerId] = useState<string | null>(null)
  const lastSyncedUserId = useRef<string | null>(null)

  // Deep-link (takusen://join…) arrival → open the join modal. We derive
  // `joinModalOpen` from `arrivalCount` so a dismiss doesn't fight with the
  // hook: incrementing arrivalCount (next URI arrived) > lastDismissedArrival
  // re-opens.
  const joinUri = useTakusenJoinUri()
  const [lastDismissedArrival, setLastDismissedArrival] = useState(0)
  const joinModalOpen = joinUri.result?.ok === true && joinUri.arrivalCount > lastDismissedArrival

  // On Oracle sign-in (session.user.id transitions), reconcile local server
  // list with the remote one. Fires once per distinct user id so an idle
  // re-render doesn't kick off duplicate syncs.
  useEffect(() => {
    const id = oracleSession?.user.id ?? null
    if (id && id !== lastSyncedUserId.current) {
      lastSyncedUserId.current = id
      void serversService.syncWithOracle().catch((e) => {
        console.warn('[app] Oracle sync failed', e)
      })
    }
    if (!id) lastSyncedUserId.current = null
  }, [oracleSession?.user.id])

  const serverIds = useMemo(() => Array.from(servers.keys()), [servers])
  const serverChannels = selectedServerId
    ? (channels.get(selectedServerId) ?? EMPTY_CHANNELS)
    : EMPTY_CHANNELS
  const selectedChannelId = selectedServerId
    ? (selectedChannelByServer.get(selectedServerId) ?? null)
    : null
  const voiceChannelId = selectedServerId
    ? (voiceChannelByServer.get(selectedServerId) ?? null)
    : null
  const selectedChannel = serverChannels.find((c) => c.id === selectedChannelId) ?? null
  const selectedChannelName = selectedChannel?.name ?? null
  const selectedChannelType = selectedChannel?.type ?? null

  // Reconnect + fetch channels when a persisted-but-disconnected server is
  // selected. `connected` is wiped on rehydrate (serverStore.sanitizeForPersist),
  // so on a fresh page load the rail shows restored servers with no live
  // Mumble session. Without this effect, clicking one would just set the
  // selection and leave the chat area empty.
  //
  // Auto-reconnect policy (anonymous joins are gone):
  //   - `server.superUser`           → prompt for the password, then connect.
  //   - `server.useOracle` + session → auto-reconnect (token mint is silent).
  //   - `server.useOracle` w/o session → skip; the Oracle sign-in prompt
  //     elsewhere in the UI is what gets them moving.
  //   - Legacy rows with neither flag → log a clear warning; the user has to
  //     remove + re-add via the dialog. We don't auto-migrate because we have
  //     no way to ask "did you mean SuperUser or Oracle?" from this surface.
  useEffect(() => {
    if (!selectedServerId) return undefined
    // Read the server snapshot via getState() instead of from the
    // `servers` closure so this effect can OMIT `servers` from its deps.
    // The fields we read (port / superUser / useOracle) are set at
    // add-time and never mutate; meanwhile the connect we kick off below
    // ends with `updateServer(url, { connected: true })`, which DOES
    // change the `servers` Map reference. With `servers` as a dep, that
    // post-connect mutation re-triggers this effect mid-flight, the
    // cleanup flips `cancelled=true`, the awaited `getChannelsForServer`
    // never runs, and the freshly-bound IMumbleService is left without a
    // channel-lifecycle listener — new channel broadcasts arrive on the
    // wire and silently die in the (empty) EventEmitter.
    const server = useServerStore.getState().servers.get(selectedServerId)
    if (!server) return undefined
    // Already connected? `serversService.getServer()` returns the live IMumbleService
    // from the connection manager — if it's there, nothing to do.
    if (serversService.getServer(selectedServerId)) return undefined

    const portStr = String(server.port)

    // SuperUser auth always requires a password we don't persist. Stop here
    // and surface a modal so the user can enter it — the modal's submit path
    // calls reconnectServer with the password in-memory.
    if (server.superUser === true) {
      setPendingSuperUserPrompt({ url: selectedServerId, port: portStr, username: 'SuperUser' })
      return undefined
    }

    // Oracle path. Without a session we can't mint a token, so skip rather
    // than attempt — the user's only path forward is signing in.
    if (server.useOracle === true) {
      if (oracleSession === null) return undefined
      let cancelled = false
      void (async () => {
        try {
          await serversService.reconnectServer({ url: selectedServerId, port: portStr })
          if (cancelled) return
          await channelsService.getChannelsForServer(selectedServerId)
        } catch (err) {
          if (!cancelled) console.error('[app] reconnect-on-select failed', err)
        }
      })()
      return () => {
        cancelled = true
      }
    }

    // Legacy / invalid entry — no auth mode declared. We refuse to reconnect
    // and ask the user to re-add the server (see ServersService.reconnectServer
    // which throws the same way; surfaces in the error toast if anything calls
    // through).
    console.warn(
      `[app] Server "${selectedServerId}" has no auth mode (legacy entry). Remove and re-add via Add Server.`
    )
    return undefined
  }, [selectedServerId, oracleSession])

  // When a server is freshly selected and has channels but no selection,
  // default to the first channel so the chat area isn't empty.
  useEffect(() => {
    if (!selectedServerId) return
    if (selectedChannelId !== null) return
    const list = channels.get(selectedServerId)
    if (list && list.length > 0) {
      channelsService.selectChannel(selectedServerId, list[0].id)
    }
  }, [selectedServerId, selectedChannelId, channels])

  const onAddServer = async (submission: AddServerSubmission): Promise<void> => {
    if (submission.kind === 'superuser') {
      await serversService.addServer({
        url: submission.url,
        port: submission.port,
        // Username is hardcoded inside ServersService for SuperUser, but the
        // ConnectOptions interface still requires the field — pass the literal
        // for clarity.
        username: 'SuperUser',
        useOracle: false,
        superUser: true,
        password: submission.password
      })
      await channelsService.getChannelsForServer(submission.url)
    } else {
      // Join-code path. `addAndConnect` itself refuses without an Oracle
      // session, so the dialog's gate is the only sanctioned entry point.
      // The fallback to `''` keeps the call type-correct; the service
      // throws a clean error before this value is consumed.
      const handle = oracleSession?.user.handle ?? ''
      await serversService.addAndConnect({
        host: submission.host,
        port: submission.port,
        name: submission.name,
        serverId: submission.serverId,
        username: handle
      })
      await channelsService.getChannelsForServer(submission.host)
    }
    setOpenAddServerDialog(false)
  }

  const onSuperUserSubmit = async (password: string): Promise<void> => {
    if (!pendingSuperUserPrompt) return
    try {
      await serversService.reconnectServer({
        url: pendingSuperUserPrompt.url,
        port: pendingSuperUserPrompt.port,
        username: pendingSuperUserPrompt.username,
        useOracle: false,
        password
      })
      await channelsService.getChannelsForServer(pendingSuperUserPrompt.url)
      setPendingSuperUserPrompt(null)
    } catch (err) {
      // Surface failure into the modal so the user can retry without
      // dismissing. We re-throw so the dialog flips into its error state.
      throw err
    }
  }

  const onSelectServer = (serverId: string): void => {
    serversService.moveToServer(serverId)
  }

  const onSelectChannel = (channelId: number): void => {
    if (!selectedServerId) return
    channelsService.selectChannel(selectedServerId, channelId)
  }

  const onJoinVoice = async (channelId: number): Promise<void> => {
    if (!selectedServerId) return
    try {
      await channelsService.joinVoiceChannel(selectedServerId, channelId)
    } catch (err) {
      console.error('Failed to join voice channel:', err)
    }
  }

  const onLeaveVoice = async (): Promise<void> => {
    if (!selectedServerId) return
    try {
      await channelsService.leaveVoiceChannel(selectedServerId)
    } catch (err) {
      console.error('Failed to leave voice channel:', err)
    }
  }

  const onSendMessage = async (message: string): Promise<void> => {
    if (!selectedServerId || selectedChannelId === null) return
    if (!message.trim()) return
    await channelsService.sendTextMessage(selectedServerId, message)
  }

  const onCreateChannel = async (name: string, type: ChannelType): Promise<void> => {
    if (!selectedServerId) return
    await channelsService.createChannel(selectedServerId, name, type, createChannelTarget?.parentId)
  }

  // The Manage Channel context-menu item routes through the settings dialog
  // pre-targeted at the Channels tab; we also stash the channel id so the
  // dialog can pick it up via initialChannelId. Setting both at the same
  // time ensures the dialog reads them together on open.
  const onManageChannel = (channelId: number): void => {
    if (!selectedServerId) return
    setManageChannelTarget({ serverId: selectedServerId, channelId })
  }

  // Stage a delete request — the actual call lives behind a confirm
  // dialog below. We capture the serverId at request time rather than
  // re-reading selectedServerId on confirm, so a stray server switch
  // between right-click and confirm-click can't accidentally delete a
  // channel on the wrong server.
  const onDeleteChannel = (channelId: number): void => {
    if (!selectedServerId) return
    setDeleteChannelTarget({ serverId: selectedServerId, channelId })
  }

  const onConfirmDeleteChannel = async (): Promise<void> => {
    if (!deleteChannelTarget) return
    const { serverId: url, channelId } = deleteChannelTarget
    setDeleteChannelTarget(null)
    try {
      await channelsService.deleteChannel(url, channelId)
    } catch (err) {
      console.error('[app] delete channel failed', err)
    }
  }

  // Look up the channel about to be deleted so the confirm dialog can
  // reference its name + type. Reads off the same `serverChannels` the
  // sidebar uses — kept in sync via the channelRemove broadcast.
  const deleteChannelMeta =
    deleteChannelTarget !== null
      ? (serverChannels.find((c) => c.id === deleteChannelTarget.channelId) ?? null)
      : null

  // Look up the parent channel name (if any) so the create dialog can show
  // "Create Subchannel of #general" instead of the bare "Create Channel".
  const createChannelParentName =
    createChannelTarget?.parentId !== undefined
      ? (serverChannels.find((c) => c.id === createChannelTarget.parentId)?.name ?? null)
      : null

  return (
    <TooltipProvider delayDuration={200}>
      <AddServerDialog
        isOpen={openAddServerDialog}
        onClose={() => setOpenAddServerDialog(false)}
        onSubmit={onAddServer}
      />
      <SuperUserPasswordDialog
        open={pendingSuperUserPrompt !== null}
        serverUrl={pendingSuperUserPrompt?.url ?? ''}
        onCancel={() => setPendingSuperUserPrompt(null)}
        onSubmit={onSuperUserSubmit}
      />
      <JoinServerModal
        open={joinModalOpen}
        payload={joinUri.result?.ok ? joinUri.result.payload : null}
        verified={joinUri.result?.ok ? joinUri.result.verified : false}
        onClose={() => {
          setLastDismissedArrival(joinUri.arrivalCount)
          joinUri.clear()
        }}
      />
      <div className="bg-background text-foreground flex h-screen w-screen overflow-hidden">
        <ServerIconRail
          serverIds={serverIds}
          selectedServerId={selectedServerId}
          onSelectServer={onSelectServer}
          onAddServer={() => setOpenAddServerDialog(true)}
          onOpenServerSettings={(id) => setSettingsServerId(id)}
          onRemoveServer={(id) => setRemovingServerId(id)}
        />
        <ServerSettingsDialog
          open={settingsServerId !== null || manageChannelTarget !== null}
          serverId={manageChannelTarget?.serverId ?? settingsServerId}
          initialTab={manageChannelTarget ? 'channels' : undefined}
          initialChannelId={manageChannelTarget?.channelId ?? null}
          onClose={() => {
            setSettingsServerId(null)
            setManageChannelTarget(null)
          }}
        />
        <RemoveServerDialog serverId={removingServerId} onClose={() => setRemovingServerId(null)} />
        <ChannelSidebar
          serverId={selectedServerId}
          channels={serverChannels}
          selectedChannelId={selectedChannelId}
          voiceChannelId={voiceChannelId}
          onSelectChannel={onSelectChannel}
          onJoinVoice={(id) => void onJoinVoice(id)}
          onLeaveVoice={() => void onLeaveVoice()}
          onCreateChannel={(type, parentId) => setCreateChannelTarget({ type, parentId })}
          onManageChannel={onManageChannel}
          onDeleteChannel={onDeleteChannel}
        />
        <Dialog
          open={deleteChannelTarget !== null}
          onOpenChange={(open) => {
            if (!open) setDeleteChannelTarget(null)
          }}
        >
          <DialogContent className="sm:max-w-100">
            <DialogHeader>
              <DialogTitle>
                Delete {deleteChannelMeta?.type === 'voice' ? 'voice' : 'text'} channel?
              </DialogTitle>
              <DialogDescription>
                {deleteChannelMeta ? (
                  <>
                    This will permanently remove{' '}
                    <span className="text-foreground font-medium">
                      {deleteChannelMeta.type === 'voice' ? '🔊' : '#'}
                      {deleteChannelMeta.name}
                    </span>
                    {deleteChannelMeta.type === 'text'
                      ? ', including all persisted chat history,'
                      : ''}{' '}
                    along with every subchannel underneath it. This cannot be undone.
                  </>
                ) : (
                  'This channel will be permanently removed along with all subchannels.'
                )}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="ghost">
                  Cancel
                </Button>
              </DialogClose>
              <Button
                type="button"
                variant="destructive"
                onClick={() => void onConfirmDeleteChannel()}
              >
                Delete channel
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <CreateChannelDialog
          type={createChannelTarget?.type ?? null}
          parentName={createChannelParentName}
          onClose={() => setCreateChannelTarget(null)}
          onCreate={onCreateChannel}
        />
        <ChatArea
          channelId={selectedChannelId}
          channelName={selectedChannelName}
          channelType={selectedChannelType}
          membersOpen={membersOpen}
          onToggleMembers={() => setMembersOpen((v) => !v)}
          onSendMessage={(text) => void onSendMessage(text)}
        />
        {membersOpen && <MemberList serverId={selectedServerId} />}
      </div>
    </TooltipProvider>
  )
}

export default App
