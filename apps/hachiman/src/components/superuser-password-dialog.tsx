/**
 * SuperUserPasswordDialog — prompts for the Mumble SuperUser password on
 * reconnect. We never persist the password (per project decision), so this
 * dialog appears whenever a SuperUser-typed server is selected and not
 * already connected. Submitting calls the parent's onSubmit with the raw
 * password; errors re-thrown by the parent are surfaced inline.
 */
import { useEffect, useState } from 'react'

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

interface SuperUserPasswordDialogProps {
  open: boolean
  serverUrl: string
  onCancel: () => void
  /** Resolve to indicate success; throw to keep the dialog open with an error. */
  onSubmit: (password: string) => Promise<void>
}

export function SuperUserPasswordDialog(props: SuperUserPasswordDialogProps): React.JSX.Element {
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!props.open) {
      setPassword('')
      setError(null)
      setSubmitting(false)
    }
  }, [props.open])

  const handleSubmit = async (): Promise<void> => {
    if (!password) return
    setSubmitting(true)
    setError(null)
    try {
      await props.onSubmit(password)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to connect')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={(next) => {
        if (!next && !submitting) props.onCancel()
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>SuperUser password</DialogTitle>
          <DialogDescription>
            Signing in as <strong>SuperUser</strong> on{' '}
            <code className="font-mono">{props.serverUrl}</code>. The password is not stored on this
            device.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void handleSubmit()
          }}
          className="grid gap-3"
        >
          <Label htmlFor="su-password">Password</Label>
          <Input
            id="su-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            autoFocus
          />
          {error ? <div className="text-destructive text-sm">{error}</div> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onCancel} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={!password || submitting}>
              {submitting ? 'Connecting…' : 'Sign in'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
