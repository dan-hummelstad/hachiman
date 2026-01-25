import * as React from 'react'
import { Command, PlusIcon } from 'lucide-react'

import { NavUser } from '@renderer/components/nav-user'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar
} from '@renderer/components/ui/sidebar'
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar'
import { useEffect } from 'react'
import { Channel } from '@renderer/stores/channelStore'

// This is sample data
const data = {
  user: {
    name: 'shadcn',
    email: 'm@example.com',
    avatar: '/avatars/shadcn.jpg'
  },
  navMain: [],
  mails: []
}

interface ServerSidenavProps {
  selectedServerId: string | null
  selectedChannelId: number | null
  serverIds: string[]
  onSelectServer: (serverId: string) => void
  onAddServer: () => void
  getServerChannels: (serverId: string) => Channel[]
  onSelectChannel: (channelId: number) => void
}

export function AppSidebar({
  ...props
}: React.ComponentProps<typeof Sidebar> & ServerSidenavProps): React.JSX.Element {
  const {
    selectedServerId,
    selectedChannelId,
    serverIds,
    getServerChannels,
    onSelectServer,
    onAddServer,
    onSelectChannel,
    ...sidebarProps
  } = props
  const { setOpen } = useSidebar()

  useEffect(() => {
    if (props.serverIds.length === 0) {
      setOpen(false)
    }
  }, [props.serverIds, setOpen])

  const serverChannels = selectedServerId ? getServerChannels(selectedServerId) : []

  return (
    <Sidebar
      collapsible="icon"
      className="overflow-hidden *:data-[sidebar=sidebar]:flex-row"
      {...sidebarProps}
    >
      <Sidebar collapsible="none" className="w-[calc(var(--sidebar-width-icon))] border-r">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" asChild className="md:h-8 md:p-0">
                <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                  <Command className="size-4" />
                </div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent className="px-1.5 md:px-0">
              <SidebarMenu>
                {serverIds.map((item) => (
                  <SidebarMenuItem key={item}>
                    <SidebarMenuButton
                      tooltip={{
                        children: item,
                        hidden: false
                      }}
                      onClick={() => {
                        onSelectServer(item)
                        setOpen(true)
                      }}
                      isActive={selectedServerId === item}
                      className="px-2.5 md:px-2"
                    >
                      <Avatar className="h-8 w-8 rounded-lg">
                        <AvatarImage src="" alt={item} />
                        <AvatarFallback className="rounded-lg">{item}</AvatarFallback>
                      </Avatar>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
                <SidebarMenuItem>
                  <SidebarMenuButton
                    tooltip={{
                      children: 'Add Server',
                      hidden: false
                    }}
                    onClick={() => {
                      onAddServer()
                    }}
                    className="px-2.5 md:px-2"
                  >
                    <PlusIcon />
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <NavUser user={data.user} />
        </SidebarFooter>
      </Sidebar>

      <Sidebar collapsible="none" className="hidden flex-1 md:flex">
        <SidebarHeader className="gap-3.5 border-b p-4">
          <div className="flex w-full items-center justify-between">
            <h1 className="text-foreground text-base font-medium">{selectedServerId}</h1>
          </div>
          <SidebarInput placeholder="Type to search..." />
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup className="px-0">
            <SidebarGroupContent>
              <SidebarMenu>
                {serverChannels.map((channel) => (
                  <SidebarMenuItem
                    key={channel.id}
                    className="hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex flex-col items-start gap-2 border-b text-sm leading-tight whitespace-nowrap p-2"
                  >
                    <SidebarMenuButton
                      onClick={() => onSelectChannel(channel.id)}
                      isActive={selectedChannelId === channel.id}
                      className="flex w-full items-center gap-2"
                    >
                      <span># {channel.name}</span> <span className="ml-auto text-xs">---</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
    </Sidebar>
  )
}
