'use client'

import { useRouter } from 'next/navigation'
import { useState, type ReactNode } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { CopyIcon, KeyRoundIcon, PlusIcon } from 'lucide-react'
import { toast } from 'sonner'

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
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { createServerSchema, type CreateServerInput } from '@/lib/server-schemas'

type FormValues = Omit<CreateServerInput, 'ownerUserId'>

interface CreatedSecret {
  oidcClientId: string
  oidcClientSecret: string
}

export function NewServerDialog({ trigger }: { trigger?: ReactNode }): React.JSX.Element {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [created, setCreated] = useState<CreatedSecret | null>(null)

  const form = useForm<FormValues>({
    resolver: zodResolver(createServerSchema),
    defaultValues: {
      name: '',
      slug: '',
      host: '',
      port: 64738,
      description: '',
    },
  })

  async function onSubmit(values: FormValues): Promise<void> {
    setServerError(null)
    setSubmitting(true)
    try {
      const res = await fetch('/api/servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(values),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        if (body?.error === 'SlugTaken') {
          form.setError('slug', { message: 'This slug is already taken' })
          return
        }
        if (body?.error === 'ValidationError') {
          setServerError('Some fields are invalid. Please check and try again.')
          return
        }
        setServerError(body?.error ?? `Request failed (${res.status})`)
        return
      }
      const body = await res.json()
      setCreated({
        oidcClientId: body.oidcClientId,
        oidcClientSecret: body.oidcClientSecret,
      })
      toast.success('Server registered')
      router.refresh()
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setSubmitting(false)
    }
  }

  function reset(): void {
    setCreated(null)
    setServerError(null)
    form.reset()
  }

  async function copySecret(): Promise<void> {
    if (!created) return
    await navigator.clipboard.writeText(created.oidcClientSecret)
    toast.success('Secret copied to clipboard')
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        setOpen(next)
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button>
            <PlusIcon /> New server
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Save your OIDC client secret</DialogTitle>
              <DialogDescription>
                This secret will not be shown again. Store it somewhere safe — your
                Mumble server needs it to verify users through Takusen.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <div className="grid gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  Client ID
                </span>
                <code className="rounded-md bg-muted px-3 py-2 font-mono text-sm">
                  {created.oidcClientId}
                </code>
              </div>
              <div className="grid gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  Client secret
                </span>
                <div className="flex items-center gap-2">
                  <code className="flex-1 overflow-hidden rounded-md bg-muted px-3 py-2 font-mono text-sm break-all">
                    {created.oidcClientSecret}
                  </code>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={copySecret}
                    aria-label="Copy secret"
                  >
                    <CopyIcon />
                  </Button>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button
                onClick={() => {
                  setOpen(false)
                  reset()
                }}
              >
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-4">
              <DialogHeader>
                <DialogTitle>Register a Mumble server</DialogTitle>
                <DialogDescription>
                  After registration you&apos;ll need to verify the host&apos;s domain
                  via DNS before it appears in the public directory.
                </DialogDescription>
              </DialogHeader>

              {serverError ? (
                <Alert variant="destructive">
                  <KeyRoundIcon />
                  <AlertTitle>Couldn&apos;t register</AlertTitle>
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
                      <Input placeholder="My Mumble Server" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="slug"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Slug</FormLabel>
                    <FormControl>
                      <Input placeholder="my-mumble-server" {...field} />
                    </FormControl>
                    <FormDescription>
                      Used in URLs like <code>takusen.app/servers/{field.value || 'slug'}</code>.
                      Lowercase, 3-32 chars, kebab-case.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="host"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Host</FormLabel>
                    <FormControl>
                      <Input placeholder="mumble.example.com" {...field} />
                    </FormControl>
                    <FormDescription>
                      DNS name where your Mumble server is reachable.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="port"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Port</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        max={65535}
                        value={field.value ?? 64738}
                        onChange={(e) => field.onChange(Number.parseInt(e.target.value, 10))}
                      />
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
                    <FormLabel>Description (optional)</FormLabel>
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

              <DialogFooter>
                <Button type="submit" disabled={submitting}>
                  {submitting ? 'Registering…' : 'Register server'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  )
}
