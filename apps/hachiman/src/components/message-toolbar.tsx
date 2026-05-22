import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { useState } from 'react'

interface MessageToolbarProps {
  onSendMessage: (message: string) => void
}

export function MessageToolbar({ onSendMessage }: MessageToolbarProps): React.JSX.Element {
  const [message, setMessage] = useState('')

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSendMessage(message)
      setMessage('')
    }
  }
  return (
    <div className="flex items-center p-4 gap-4">
      <Textarea
        placeholder="Message"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyUp={handleKey}
      />
      <Button
        onClick={() => {
          onSendMessage(message)
          setMessage('')
        }}
      >
        Send
      </Button>
    </div>
  )
}
