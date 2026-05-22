import { useEffect, useMemo, useState } from 'react'

import { serversService } from '@/services/ServersService'
import { channelsService } from '@/services/ChannelsService'

import { AddServerDialog } from '@/components/add-server-dialog'
import { ServerIconRail } from '@/components/server-icon-rail'
import { ChannelSidebar } from '@/components/channel-sidebar'
import { ChatArea } from '@/components/chat-area'
import { MemberList } from '@/components/member-list'
import { TooltipProvider } from '@/components/ui/tooltip'

import { useServerStore } from '@/stores/serverStore'
import { useChannelStore } from '@/stores/channelStore'
import { useVoiceStore } from '@/stores/voiceStore'

function App(): React.JSX.Element {
  const { servers, selectedServerId } = useServerStore()
  const { channels, selectedChannelByServer } = useChannelStore()
  const voiceChannelByServer = useVoiceStore((s) => s.voiceChannelByServer)
  const [openAddServerDialog, setOpenAddServerDialog] = useState(false)
  const [membersOpen, setMembersOpen] = useState(true)

  const serverIds = useMemo(() => Array.from(servers.keys()), [servers])
  const serverChannels = selectedServerId ? (channels.get(selectedServerId) ?? []) : []
  const selectedChannelId = selectedServerId
    ? (selectedChannelByServer.get(selectedServerId) ?? null)
    : null
  const voiceChannelId = selectedServerId
    ? (voiceChannelByServer.get(selectedServerId) ?? null)
    : null
  const selectedChannelName = serverChannels.find((c) => c.id === selectedChannelId)?.name ?? null

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

  const onAddServer = async (url: string, port: string): Promise<void> => {
    try {
      await serversService.addServer(url, port, 'HachimanUser')
      await channelsService.getChannelsForServer(url)
      setOpenAddServerDialog(false)
    } catch (error) {
      console.error('Error adding server:', error)
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

  return (
    <TooltipProvider delayDuration={200}>
      <AddServerDialog
        isOpen={openAddServerDialog}
        onClose={() => setOpenAddServerDialog(false)}
        onAddServer={onAddServer}
      />
      <div className="bg-background text-foreground flex h-screen w-screen overflow-hidden">
        <ServerIconRail
          serverIds={serverIds}
          selectedServerId={selectedServerId}
          onSelectServer={onSelectServer}
          onAddServer={() => setOpenAddServerDialog(true)}
        />
        <ChannelSidebar
          serverId={selectedServerId}
          channels={serverChannels}
          selectedChannelId={selectedChannelId}
          voiceChannelId={voiceChannelId}
          onSelectChannel={onSelectChannel}
          onJoinVoice={(id) => void onJoinVoice(id)}
          onLeaveVoice={() => void onLeaveVoice()}
        />
        <ChatArea
          channelId={selectedChannelId}
          channelName={selectedChannelName}
          membersOpen={membersOpen}
          onToggleMembers={() => setMembersOpen((v) => !v)}
          onSendMessage={(text) => void onSendMessage(text)}
        />
        {membersOpen && (
          <MemberList
            serverId={selectedServerId}
            channelId={selectedChannelId}
            channelName={selectedChannelName}
          />
        )}
      </div>
    </TooltipProvider>
  )
}

export default App
