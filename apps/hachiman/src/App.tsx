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
  const [createChannelType, setCreateChannelType] = useState<ChannelType | null>(null)
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
  useEffect(() => {
    if (!selectedServerId) return
    const server = servers.get(selectedServerId)
    if (!server) return
    // Already connected? `serversService.getServer()` returns the live IMumbleService
    // from the connection manager — if it's there, nothing to do.
    if (serversService.getServer(selectedServerId)) return

    const portStr = String(server.port)
    const username = server.username ?? 'HachimanUser'
    // SuperUser auth always requires a password we don't persist. Stop here
    // and surface a modal so the user can enter it — the modal's submit path
    // calls reconnectServer with the password in-memory.
    if (server.useOracle === false && username.toLowerCase() === 'superuser') {
      setPendingSuperUserPrompt({ url: selectedServerId, port: portStr, username })
      return
    }

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
  }, [selectedServerId, servers])

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
    if (submission.kind === 'manual') {
      await serversService.addServer({
        url: submission.url,
        port: submission.port,
        username: submission.username,
        useOracle: false,
        ...(submission.password ? { password: submission.password } : {})
      })
      await channelsService.getChannelsForServer(submission.url)
    } else if (submission.kind === 'oracle') {
      const handle = oracleSession?.user.handle ?? 'HachimanUser'
      await serversService.addServer({
        url: submission.url,
        port: submission.port,
        username: handle,
        useOracle: true
      })
      await channelsService.getChannelsForServer(submission.url)
    } else {
      // Join-code path reuses addAndConnect so the server record gets the
      // friendly display name and (eventually) any serverId carried by the
      // signed invite payload.
      await serversService.addAndConnect({
        host: submission.host,
        port: submission.port,
        name: submission.name,
        username: oracleSession?.user.handle ?? 'HachimanUser'
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
    await channelsService.createChannel(selectedServerId, name, type)
  }

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
          open={settingsServerId !== null}
          serverId={settingsServerId}
          onClose={() => setSettingsServerId(null)}
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
          onCreateChannel={(type) => setCreateChannelType(type)}
        />
        <CreateChannelDialog
          type={createChannelType}
          onClose={() => setCreateChannelType(null)}
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
