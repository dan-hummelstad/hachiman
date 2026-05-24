'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { TrashIcon } from 'lucide-react'
import { toast } from 'sonner'
import { z } from 'zod'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
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
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

const editFormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80, 'Name is too long'),
  description: z.string().max(1000, 'Description is too long'),
})

type FormValues = z.infer<typeof editFormSchema>

interface Props {
  serverId: string
  name: string
  description: string | null
  host: string
  port: number
  slug: string
}

export function EditServerForm({
  serverId,
  name,
  description,
  host,
  port,
  slug,
}: Props): React.JSX.Element {
  const router = useRouter()
  const [submitting, setSubmitting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  const form = useForm<FormValues>({
    resolver: zodResolver(editFormSchema),
    defaultValues: {
      name,
      description: description ?? '',
    },
  })

  async function onSubmit(values: FormValues): Promise<void> {
    setServerError(null)
    setSubmitting(true)
    try {
      const res = await fetch(`/api/servers/${serverId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: values.name,
          description: values.description || null,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setServerError(body?.error ?? `Request failed (${res.status})`)
        return
      }
      toast.success('Server updated')
      router.refresh()
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setSubmitting(false)
    }
  }

  async function onDelete(): Promise<void> {
    setDeleting(true)
    try {
      const res = await fetch(`/api/servers/${serverId}`, { method: 'DELETE' })
      if (!res.ok) {
        toast.error('Failed to delete server')
        return
      }
      toast.success('Server deleted')
      router.push('/servers')
      router.refresh()
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="grid gap-6">
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-4">
          {serverError ? (
            <Alert variant="destructive">
              <AlertTitle>Couldn&apos;t save</AlertTitle>
              <AlertDescription>{serverError}</AlertDescription>
            </Alert>
          ) : null}

          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Name</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="description"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Description</FormLabel>
                <FormControl>
                  <Textarea
                    placeholder="What is this server for?"
                    value={field.value ?? ''}
                    onChange={field.onChange}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="grid gap-2 sm:grid-cols-3">
            <div className="grid gap-1">
              <span className="text-xs font-medium text-muted-foreground">Host</span>
              <code className="rounded-md bg-muted px-3 py-2 font-mono text-sm">{host}</code>
            </div>
            <div className="grid gap-1">
              <span className="text-xs font-medium text-muted-foreground">Port</span>
              <code className="rounded-md bg-muted px-3 py-2 font-mono text-sm">{port}</code>
            </div>
            <div className="grid gap-1">
              <span className="text-xs font-medium text-muted-foreground">Slug</span>
              <code className="rounded-md bg-muted px-3 py-2 font-mono text-sm">{slug}</code>
            </div>
          </div>

          <div className="flex justify-end">
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </form>
      </Form>

      <div className="border-t pt-6">
        <h3 className="text-sm font-semibold text-destructive">Danger zone</h3>
        <p className="text-sm text-muted-foreground">
          Deleting this server removes it from the registry, including all invite
          codes and DNS verifications.
        </p>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="destructive" className="mt-3">
              <TrashIcon /> Delete server
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete this server?</DialogTitle>
              <DialogDescription>
                This cannot be undone. The slug <code>{slug}</code> will become
                available for someone else to claim.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="destructive" onClick={onDelete} disabled={deleting}>
                {deleting ? 'Deleting…' : 'Yes, delete'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}
