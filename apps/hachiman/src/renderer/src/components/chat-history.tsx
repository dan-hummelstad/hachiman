import { ScrollArea } from '@renderer/components/ui/scroll-area'
import { Avatar, AvatarFallback, AvatarImage } from '@renderer/components/ui/avatar'
import { useMessageStore, type Message } from '@renderer/stores/messagesStore'

interface ChatHistoryProps {
  channelId: number | null
}

export function ChatHistory(props: ChatHistoryProps): React.JSX.Element {
  const { history: messageHistory } = useMessageStore()
  const messages = props.channelId !== null ? messageHistory.get(props.channelId) || [] : []
  if (props.channelId === null) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-muted-foreground">Select a channel to view messages</p>
      </div>
    )
  }
  return (
    <ScrollArea variant="start-scroll-bottom" className="flex-1 flex-col">
      <div className="flex flex-col-reverse justify-start min-h-full">
        <div className="flex flex-col">
          {/* Welcome message */}
          <div className="px-4 py-6 border-b">
            <h2 className="text-xl font-semibold mb-1">Welcome to #general</h2>
            <p className="text-sm text-muted-foreground">
              This is the beginning of your conversation in this channel.
            </p>
          </div>
          {/* Messages */}
          <div className="flex flex-col">
            {messages.map((message) => (
              <MessageItem key={message.id} message={message} />
            ))}
          </div>
        </div>
      </div>
    </ScrollArea>
  )
}

function MessageItem({ message }: { message: Message }): React.JSX.Element {
  // if (message.isSystemMessage) {
  //   return (
  //     <div className="flex items-center gap-2 px-4 py-1">
  //       <span className="text-xs text-muted-foreground italic">{message.content}</span>
  //       <span className="text-xs text-muted-foreground">{message.timestamp}</span>
  //     </div>
  //   )
  // }

  return (
    <div className="group hover:bg-muted/50 px-4 py-2 flex gap-3">
      <Avatar className="h-10 w-10 mt-0.5">
        <AvatarImage src={message.avatar} alt={message.author} />
        <AvatarFallback>{message.author[0].toUpperCase()}</AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold text-sm">{message.author}</span>
          <span className="text-xs text-muted-foreground">{message.date.toLocaleTimeString()}</span>
        </div>
        <p className="text-sm text-foreground/90 wrap-break-word">{message.content}</p>
      </div>
    </div>
  )
}
