import { useEffect, useRef, useState } from 'react'

import { serversService } from '@renderer/services/ServersService'

import { Separator } from '@renderer/components/ui/separator'
import { AppSidebar } from '@renderer/components/server-sidenav'
import { SidebarProvider, SidebarInset, SidebarTrigger } from '@renderer/components/ui/sidebar'
import { useServerStore } from '@renderer/stores/serverStore'
import { AddServerDialog } from '@renderer/components/add-server-dialog'
import { useChannelStore } from '@renderer/stores/channelStore'
import { channelsService } from './services/ChannelsService'
import { MessageToolbar } from './components/message-toolbar'
import { ChatHistory } from './components/chat-history'

function App(): React.JSX.Element {
  const { servers, selectedServerId } = useServerStore()
  const { channels, selectedChannelId } = useChannelStore()
  const [openAddServerDialog, setOpenAddServerDialog] = useState(false)
  const audioOutputRef = useRef<HTMLAudioElement>(null)

  const onAddServer = async (url: string, port: string): Promise<void> => {
    try {
      await serversService.addServer(url, port, 'HachimanUser')
      await channelsService.getChannelsForServer(url)
      setOpenAddServerDialog(false)
    } catch (error) {
      console.error('Error adding server:', error)
    }
  }

  const onClickChannel = async (channelId: number): Promise<void> => {
    if (!selectedServerId) {
      return
    }
    await channelsService.moveClientToChannel(selectedServerId, channelId)
  }

  const onClickSendMessage = async (message: string): Promise<void> => {
    if (!selectedServerId || !selectedChannelId) {
      return
    }
    await channelsService.sendMessageToChannel(selectedServerId, selectedChannelId, message)
  }

  useEffect(() => {
    const audioElement = audioOutputRef.current
    if (!audioElement || !selectedServerId) {
      return
    }
    audioElement.volume = 1.0
    // channelsService.listenToAudioStream(selectedServerId, audioElement)
  }, [selectedServerId])

  const serversList = Array.from(servers.values())

  return (
    <>
      <audio ref={audioOutputRef} />
      <AddServerDialog
        isOpen={openAddServerDialog}
        onClose={() => setOpenAddServerDialog(false)}
        onAddServer={onAddServer}
      />
      <SidebarProvider
        style={
          {
            '--sidebar-width': '250px',
            '--sidebar-width-icon': '2.5rem'
          } as React.CSSProperties
        }
      >
        <AppSidebar
          selectedServerId={selectedServerId}
          serverIds={serversList.map((s) => s.id)}
          onSelectServer={(serverId) => serversService.moveToServer(serverId)}
          onAddServer={() => setOpenAddServerDialog(true)}
          getServerChannels={(serverId) => (channels.has(serverId) ? channels.get(serverId)! : [])}
          onSelectChannel={onClickChannel}
          selectedChannelId={selectedChannelId}
        />
        <SidebarInset>
          <div className="flex flex-col h-screen overflow-hidden">
            <header className="h-16 bg-background sticky top-0 flex shrink-0 items-center gap-2 border-b p-4">
              <SidebarTrigger className="-ml-1" />
              <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
              <h1 className="text-lg font-semibold">{channels.get(selectedServerId!)?.find((channel) => channel.id === selectedChannelId)?.name}</h1>
            </header>
            <div className="flex-1 overflow-y-auto">
              <ChatHistory channelId={selectedChannelId} />
            </div>
            <footer className="h-24 bg-background sticky bottom-0 shrink-0 items-center border-b">
              <MessageToolbar onSendMessage={(msg) => onClickSendMessage(msg)} />
            </footer>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </>
  )
}

export default App
