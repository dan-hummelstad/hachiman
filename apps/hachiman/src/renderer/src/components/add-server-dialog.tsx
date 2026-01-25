import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { useState } from 'react'

interface AddServerDialogProps {
  isOpen: boolean
  onClose: () => void
  onAddServer: (url: string, port: string) => Promise<void>
}

export function AddServerDialog(props: AddServerDialogProps): React.JSX.Element {
  const [serverUrl, setServerUrl] = useState('localhost')
  const [serverPort, setServerPort] = useState('64738')
  return (
    <Dialog open={props.isOpen} onOpenChange={props.onClose}>
      <DialogContent className="sm:max-w-106.25">
        <DialogHeader>
          <DialogTitle>Add Server</DialogTitle>
          <DialogDescription>Enter the details of the server you want to add.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-3">
            <Label htmlFor="address-1">Server Address</Label>
            <Input
              id="address-1"
              name="address"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
            />
          </div>
          <div className="grid gap-3">
            <Label htmlFor="port-1">Server Port</Label>
            <Input
              id="port-1"
              name="port"
              value={serverPort}
              onChange={(e) => setServerPort(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button
            disabled={
              !serverUrl || serverUrl.length === 0 || !serverPort || serverPort.length === 0
            }
            onClick={() => props.onAddServer(serverUrl, serverPort)}
          >
            Connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
