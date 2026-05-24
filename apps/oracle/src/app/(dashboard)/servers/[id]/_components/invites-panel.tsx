'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { CopyIcon, PlusIcon, TicketIcon, XCircleIcon } from 'lucide-react'
import { toast } from 'sonner'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

export interface InviteRow {
  id: string
  code: string
  createdAt: string
  expiresAt: string | null
  maxUses: number | null
  useCount: number
  revoked: boolean
}

interface Props {
  serverId: string
  initialInvites: InviteRow[]
}

type FormValues = {
  expiresInDays: number | ''
  maxUses: number | ''
}

export function InvitesPanel({ serverId, initialInvites }: Props): React.JSX.Element {
  const router = useRouter()
  const [invites, setInvites] = useState<InviteRow[]>(initialInvites)
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const form = useForm<FormValues>({
    defaultValues: { expiresInDays: 7, maxUses: '' },
  })

  async function createInvite(values: FormValues): Promise<void> {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/servers/${serverId}/invites`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expiresInDays: values.expiresInDays === '' ? null : Number(values.expiresInDays),
          maxUses: values.maxUses === '' ? null : Number(values.maxUses),
        }),
      })
      const body = await res.json()
      if (!res.ok) {
        throw new Error(body?.error ?? `Request failed (${res.status})`)
      }
      setInvites((prev) => [
        {
          id: body.invite.id,
          code: body.code,
          createdAt: body.invite.createdAt,
          expiresAt: body.invite.expiresAt,
          maxUses: body.invite.maxUses,
          useCount: body.invite.useCount,
          revoked: body.invite.revoked,
        },
        ...prev,
      ])
      toast.success(`Invite ${body.code} created`)
      setOpen(false)
      form.reset({ expiresInDays: 7, maxUses: '' })
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setSubmitting(false)
    }
  }

  async function copyUrl(code: string): Promise<void> {
    const url = `${window.location.origin}/i/${code}`
    await navigator.clipboard.writeText(url)
    toast.success('Invite URL copied')
  }

  async function revoke(code: string): Promise<void> {
    const res = await fetch(`/api/servers/${serverId}/invites/${code}/revoke`, {
      method: 'POST',
    })
    if (!res.ok) {
      toast.error('Failed to revoke invite')
      return
    }
    setInvites((prev) =>
      prev.map((i) => (i.code === code ? { ...i, revoked: true } : i)),
    )
    toast.success('Invite revoked')
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="flex items-center gap-2">
            <TicketIcon className="size-4" /> Invite codes
          </CardTitle>
          <CardDescription>
            Hand these out to give people a one-click join URL.
          </CardDescription>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm">
              <PlusIcon /> New invite
            </Button>
          </DialogTrigger>
          <DialogContent>
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(createInvite)}
                className="grid gap-4"
              >
                <DialogHeader>
                  <DialogTitle>Create invite</DialogTitle>
                  <DialogDescription>
                    Leave a field blank for no limit.
                  </DialogDescription>
                </DialogHeader>

                {error ? (
                  <Alert variant="destructive">
                    <AlertTitle>Couldn&apos;t create invite</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                ) : null}

                <FormField
                  control={form.control}
                  name="expiresInDays"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Expires in (days)</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={1}
                          max={365}
                          value={field.value}
                          onChange={(e) =>
                            field.onChange(
                              e.target.value === '' ? '' : Number(e.target.value),
                            )
                          }
                        />
                      </FormControl>
                      <FormDescription>1-365 days, or blank for never.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="maxUses"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Max uses</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={1}
                          value={field.value}
                          onChange={(e) =>
                            field.onChange(
                              e.target.value === '' ? '' : Number(e.target.value),
                            )
                          }
                        />
                      </FormControl>
                      <FormDescription>Blank for unlimited.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <DialogFooter>
                  <Button type="submit" disabled={submitting}>
                    {submitting ? 'Creating…' : 'Create invite'}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent className="px-0">
        {invites.length === 0 ? (
          <p className="px-6 text-sm text-muted-foreground">
            No invites yet. Create one to share with others.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Code</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Uses</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pr-6 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invites.map((invite) => {
                const expired =
                  invite.expiresAt !== null &&
                  new Date(invite.expiresAt).getTime() <= Date.now()
                const exhausted =
                  invite.maxUses !== null && invite.useCount >= invite.maxUses
                return (
                  <TableRow key={invite.id}>
                    <TableCell className="pl-6 font-mono">{invite.code}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(invite.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {invite.expiresAt
                        ? new Date(invite.expiresAt).toLocaleDateString()
                        : '—'}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {invite.useCount}
                      {invite.maxUses !== null ? `/${invite.maxUses}` : ''}
                    </TableCell>
                    <TableCell>
                      {invite.revoked ? (
                        <Badge variant="destructive">Revoked</Badge>
                      ) : expired ? (
                        <Badge variant="outline">Expired</Badge>
                      ) : exhausted ? (
                        <Badge variant="outline">Exhausted</Badge>
                      ) : (
                        <Badge variant="secondary">Active</Badge>
                      )}
                    </TableCell>
                    <TableCell className="pr-6">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label="Copy URL"
                          onClick={() => copyUrl(invite.code)}
                        >
                          <CopyIcon />
                        </Button>
                        {!invite.revoked ? (
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label="Revoke"
                            onClick={() => revoke(invite.code)}
                          >
                            <XCircleIcon />
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
