// Takusen REST client. Contract: docs/gateway-protocol.md §4.
import type {
  Attachment,
  Channel,
  Guild,
  GuildFull,
  Invite,
  InvitePreview,
  Limits,
  Member,
  Message,
  Role,
  User,
} from './types'

/** Must resolve to a fresh, valid Takusen access token. */
export type TokenProvider = () => Promise<string>

/** Non-2xx response. `code` is the body's `error` field (e.g. `MissingPermissions`) or `HTTP_<status>`. */
export class RestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'RestError'
  }
}

function restError(status: number, body: unknown): RestError {
  const err = body as { error?: string; message?: string } | null
  return new RestError(status, err?.error ?? `HTTP_${status}`, err?.message)
}

// `| undefined` on optionals so callers can spread partial form state under exactOptionalPropertyTypes.
type Opt<T> = T | undefined

export interface CreateGuildBody {
  name: string
  region?: Opt<string>
}
export interface UpdateMeBody {
  /** Upload id, or null to clear. */
  avatar?: Opt<string | null>
}
export interface UpdateGuildBody {
  name?: Opt<string>
  /** Upload id, or null to clear. */
  icon?: Opt<string | null>
  /** Upload id, or null to clear. */
  banner?: Opt<string | null>
  region?: Opt<string | null>
}
export interface CreateChannelBody {
  name: string
  type: 'text' | 'voice' | 'category'
  parentId?: Opt<string | null>
  topic?: Opt<string | null>
}
export interface UpdateChannelBody {
  name?: Opt<string>
  topic?: Opt<string | null>
  parentId?: Opt<string | null>
  position?: Opt<number>
}
export interface ChannelPosition {
  id: string
  position: number
  parentId?: Opt<string | null>
}
export interface OverwriteBody {
  type: 'role' | 'member'
  allow: number
  deny: number
}
export interface MessageQuery {
  before?: Opt<string>
  limit?: Opt<number>
}
export interface SendMessageBody {
  content: string
  nonce?: Opt<string>
  /** Upload ids from {@link RestClient.upload}. */
  attachments?: Opt<string[]>
}
export interface UploadOptions {
  filename: string
  width?: Opt<number>
  height?: Opt<number>
  signal?: Opt<AbortSignal>
  onProgress?: Opt<(loaded: number, total: number) => void>
}
export interface UpdateMemberBody {
  nick?: Opt<string | null>
  roles?: Opt<string[]>
}
export interface CreateRoleBody {
  name: string
  color?: Opt<number>
  permissions?: Opt<number>
}
export interface UpdateRoleBody {
  name?: Opt<string>
  color?: Opt<number>
  permissions?: Opt<number>
}
export interface RolePosition {
  id: string
  position: number
}
export interface CreateInviteBody {
  maxAgeSeconds?: Opt<number>
  maxUses?: Opt<number>
}

const e = encodeURIComponent

export class RestClient {
  constructor(private readonly opts: { baseUrl: string; getToken: TokenProvider }) {}

  getMe = () => this.req<User>('GET', '/users/@me')
  updateMe = (body: UpdateMeBody) => this.req<User>('PATCH', '/users/@me', body)
  getUser = (id: string) => this.req<User>('GET', `/users/${e(id)}`)

  createGuild = (body: CreateGuildBody) => this.req<GuildFull>('POST', '/guilds', body)
  getGuild = (id: string) => this.req<GuildFull>('GET', `/guilds/${e(id)}`)
  updateGuild = (id: string, body: UpdateGuildBody) => this.req<Guild>('PATCH', `/guilds/${e(id)}`, body)
  deleteGuild = (id: string) => this.req<undefined>('DELETE', `/guilds/${e(id)}`)

  createChannel = (guildId: string, body: CreateChannelBody) =>
    this.req<Channel>('POST', `/guilds/${e(guildId)}/channels`, body)
  reorderChannels = (guildId: string, body: ChannelPosition[]) =>
    this.req<undefined>('PATCH', `/guilds/${e(guildId)}/channels`, body)
  updateChannel = (id: string, body: UpdateChannelBody) =>
    this.req<Channel>('PATCH', `/channels/${e(id)}`, body)
  deleteChannel = (id: string) => this.req<undefined>('DELETE', `/channels/${e(id)}`)
  putOverwrite = (channelId: string, targetId: string, body: OverwriteBody) =>
    this.req<undefined>('PUT', `/channels/${e(channelId)}/permissions/${e(targetId)}`, body)
  deleteOverwrite = (channelId: string, targetId: string) =>
    this.req<undefined>('DELETE', `/channels/${e(channelId)}/permissions/${e(targetId)}`)

  getMessages = (channelId: string, q: MessageQuery = {}) => {
    const qs = new URLSearchParams()
    if (q.before !== undefined) qs.set('before', q.before)
    if (q.limit !== undefined) qs.set('limit', String(q.limit))
    const s = qs.toString()
    return this.req<Message[]>('GET', `/channels/${e(channelId)}/messages${s ? `?${s}` : ''}`)
  }
  sendMessage = (channelId: string, body: SendMessageBody) =>
    this.req<Message>('POST', `/channels/${e(channelId)}/messages`, body)
  editMessage = (channelId: string, messageId: string, body: { content: string }) =>
    this.req<Message>('PATCH', `/channels/${e(channelId)}/messages/${e(messageId)}`, body)
  deleteMessage = (channelId: string, messageId: string) =>
    this.req<undefined>('DELETE', `/channels/${e(channelId)}/messages/${e(messageId)}`)
  triggerTyping = (channelId: string) => this.req<undefined>('POST', `/channels/${e(channelId)}/typing`)

  getMembers = (guildId: string) => this.req<Member[]>('GET', `/guilds/${e(guildId)}/members`)
  updateMember = (guildId: string, userId: string, body: UpdateMemberBody) =>
    this.req<Member>('PATCH', `/guilds/${e(guildId)}/members/${e(userId)}`, body)
  kickMember = (guildId: string, userId: string) =>
    this.req<undefined>('DELETE', `/guilds/${e(guildId)}/members/${e(userId)}`)
  leaveGuild = (guildId: string) => this.req<undefined>('DELETE', `/users/@me/guilds/${e(guildId)}`)

  getRoles = (guildId: string) => this.req<Role[]>('GET', `/guilds/${e(guildId)}/roles`)
  createRole = (guildId: string, body: CreateRoleBody) =>
    this.req<Role>('POST', `/guilds/${e(guildId)}/roles`, body)
  reorderRoles = (guildId: string, body: RolePosition[]) =>
    this.req<Role[]>('PATCH', `/guilds/${e(guildId)}/roles`, body)
  updateRole = (guildId: string, roleId: string, body: UpdateRoleBody) =>
    this.req<Role>('PATCH', `/guilds/${e(guildId)}/roles/${e(roleId)}`, body)
  deleteRole = (guildId: string, roleId: string) =>
    this.req<undefined>('DELETE', `/guilds/${e(guildId)}/roles/${e(roleId)}`)

  getInvites = (guildId: string) => this.req<Invite[]>('GET', `/guilds/${e(guildId)}/invites`)
  createInvite = (guildId: string, body: CreateInviteBody = {}) =>
    this.req<Invite>('POST', `/guilds/${e(guildId)}/invites`, body)
  deleteInvite = (code: string) => this.req<undefined>('DELETE', `/invites/${e(code)}`)
  /** Public, non-consuming — works signed out. */
  previewInvite = (code: string) => this.req<InvitePreview>('GET', `/invites/${e(code)}`, undefined, false)
  acceptInvite = (code: string) => this.req<GuildFull>('POST', `/invites/${e(code)}`)

  getDmChannels = () => this.req<Channel[]>('GET', '/users/@me/channels')
  openDm = (recipientIds: string[]) => this.req<Channel>('POST', '/users/@me/channels', { recipientIds })

  getLimits = () => this.req<Limits>('GET', '/limits')

  /** Public URL of a file key (avatar, icon, banner, Attachment.key). */
  fileUrl = (key: string) => `${this.base}/files/${key.split('/').map(e).join('/')}`

  /**
   * XHR, because fetch has no upload progress. Rejects with RestError (413 UploadTooLarge, ...),
   * a DOMException 'AbortError' when `signal` aborts, or a TypeError on network failure.
   */
  upload = async (file: Blob, opts: UploadOptions): Promise<Attachment> => {
    const { signal } = opts
    const aborted = () => new DOMException('Upload aborted', 'AbortError')
    if (signal?.aborted) throw aborted()
    const token = await this.opts.getToken()
    if (signal?.aborted) throw aborted()

    const qs = new URLSearchParams({ filename: opts.filename })
    if (opts.width !== undefined) qs.set('width', String(opts.width))
    if (opts.height !== undefined) qs.set('height', String(opts.height))

    return new Promise<Attachment>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      const onAbort = () => {
        xhr.abort()
      }
      const fail = (err: Error) => {
        signal?.removeEventListener('abort', onAbort)
        reject(err)
      }
      xhr.open('POST', `${this.base}/uploads?${qs}`)
      xhr.setRequestHeader('Authorization', `Bearer ${token}`)
      xhr.setRequestHeader('Accept', 'application/json')
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
      const { onProgress } = opts
      if (onProgress)
        xhr.upload.onprogress = ev => {
          onProgress(ev.loaded, ev.lengthComputable ? ev.total : file.size)
        }
      xhr.onload = () => {
        let body: unknown = null
        try {
          body = JSON.parse(xhr.responseText)
        } catch {
          // Non-JSON error body (e.g. a proxy's 413 page): fall back to HTTP_<status>.
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          fail(restError(xhr.status, body))
          return
        }
        signal?.removeEventListener('abort', onAbort)
        resolve(body as Attachment)
      }
      xhr.onerror = () => {
        fail(new TypeError('upload: network error'))
      }
      xhr.onabort = () => {
        fail(aborted())
      }
      signal?.addEventListener('abort', onAbort)
      xhr.send(file)
    })
  }

  private get base(): string {
    return this.opts.baseUrl.replace(/\/$/, '')
  }

  private async req<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (auth) headers['Authorization'] = `Bearer ${await this.opts.getToken()}`
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetch(this.base + path, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
    if (!res.ok) throw restError(res.status, await res.json().catch(() => null))
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }
}
