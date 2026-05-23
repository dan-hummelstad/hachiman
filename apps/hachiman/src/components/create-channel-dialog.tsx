import { useEffect, useState } from 'react'
import { Hash, Volume2 } from 'lucide-react'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { ChannelType } from '@/stores/channelStore'

interface CreateChannelDialogProps {
  /**
   * Which type of channel to create. Set when the dialog opens (the trigger
   * was one section's "+" button), so the dialog itself doesn't ask. Null
   * keeps the dialog closed.
   */
  type: ChannelType | null
  onClose: () => void
  onCreate: (name: string, type: ChannelType) => Promise<void>
}

export function CreateChannelDialog(props: CreateChannelDialogProps): React.JSX.Element {
  const { type, onClose, onCreate } = props
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Reset the name field each time the dialog reopens so it doesn't leak the
  // previous attempt's text into the next session.
  useEffect(() => {
    if (type !== null) setName('')
  }, [type])

  const isOpen = type !== null
  const Icon = type === 'voice' ? Volume2 : Hash

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (type === null) return
    const trimmed = name.trim()
    if (!trimmed) return
    setSubmitting(true)
    try {
      await onCreate(trimmed, type)
      onClose()
    } catch (err) {
      console.error('Failed to create channel:', err)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-106.25">
        <form onSubmit={(e) => void handleSubmit(e)}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Icon className="h-4 w-4" />
              Create {type === 'voice' ? 'Voice' : 'Text'} Channel
            </DialogTitle>
            <DialogDescription>
              {type === 'voice'
                ? 'Voice channels carry audio plus a live (non-persistent) chat.'
                : 'Text channels keep persistent chat history. No voice.'}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-3">
              <Label htmlFor="channel-name">Channel name</Label>
              <Input
                id="channel-name"
                name="channel-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={type === 'voice' ? 'General' : 'general'}
                autoFocus
                disabled={submitting}
              />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost" disabled={submitting}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={submitting || !name.trim()}>
              {submitting ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
