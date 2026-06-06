/**
 * Validation schemas and types for the server registry, split out from
 * `lib/servers.ts` so they can be imported by client components without
 * dragging the postgres driver into the browser bundle.
 */
import { z } from 'zod'

/**
 * Slug rules: lowercase, kebab-case, 3-32 chars, must start and end with an
 * alphanumeric character. Numbers and hyphens allowed in between.
 */
export const slugSchema = z
  .string()
  .min(3, 'Slug must be at least 3 characters')
  .max(32, 'Slug must be at most 32 characters')
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    'Slug must be lowercase kebab-case (a-z, 0-9, hyphens; no leading/trailing hyphen)',
  )

/**
 * Region codes are short machine identifiers (e.g. "us-east"). We keep the
 * format loose here — the authoritative set lives in the `regions` table and
 * the FK enforces existence — but cap length and shape so obviously-bogus
 * values are rejected before they hit the database.
 */
export const regionCodeSchema = z
  .string()
  .trim()
  .min(2, 'Region code is too short')
  .max(32, 'Region code is too long')
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    'Region code must be lowercase kebab-case (a-z, 0-9, hyphens)',
  )

/**
 * Host accepts a DNS name (e.g. `mumble.example.com`), an IPv4 / IPv6 literal,
 * or the literal string `localhost`.
 *
 * The strict DNS-only rule was too strict for dev (`localhost`, `127.0.0.1`)
 * and for managed deployments that initially address an island by its bare IP
 * before DNS is registered. Public-directory inclusion is gated independently
 * by `serverDomainVerifications` (DNS challenge — IP / localhost rows can't
 * become verified), so loosening the input rule here doesn't put non-DNS
 * hosts in the public list.
 *
 * Only the `self-hosted` branch of `createServerSchema` consults this validator
 * — the `managed` branch ignores any client-supplied host and stamps from the
 * `TAKUSEN_MANAGED_GATEWAY_HOST` env in `lib/servers.ts`.
 */
const HOST_DNS_REGEX = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/
const HOST_IPV4_REGEX = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|\d{1,2})\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|\d{1,2})$/
// Permissive IPv6: any non-empty run of hex digits, colons, and optional []
// brackets, requiring at least one colon. Accepts compressed forms like ::1.
const HOST_IPV6_REGEX = /^\[?[0-9a-fA-F:]*:[0-9a-fA-F:]*\]?$/

export const hostSchema = z
  .string()
  .trim()
  .min(1, 'Host is required')
  .max(253, 'Host is too long')
  .refine(
    (s) =>
      s === 'localhost' ||
      HOST_DNS_REGEX.test(s) ||
      HOST_IPV4_REGEX.test(s) ||
      HOST_IPV6_REGEX.test(s),
    'Host must be a DNS name (e.g. mumble.example.com), an IP address, or "localhost"',
  )

const portSchema = z
  .number()
  .int('Port must be an integer')
  .min(1, 'Port must be between 1 and 65535')
  .max(65535, 'Port must be between 1 and 65535')

/**
 * Shared fields present on both `self-hosted` and `managed` create requests.
 * Pulled out so the discriminated union below only has to list what differs.
 */
const baseCreateServerFields = {
  name: z.string().trim().min(1, 'Name is required').max(80, 'Name is too long'),
  slug: slugSchema,
  description: z.string().max(1000, 'Description is too long').optional().nullable(),
  // Initial voice region. Optional + nullable: a server may be created without
  // a region and have one selected later.
  region: regionCodeSchema.optional().nullable(),
} as const

/**
 * Server-create input. Split by `mode`:
 *
 *  - `self-hosted` — owner-supplied host:port. The host is validated
 *    (`hostSchema` accepts DNS, IP, or `localhost`); the OIDC client gets
 *    registered just like before.
 *  - `managed` — Oracle stamps `host` from `TAKUSEN_MANAGED_GATEWAY_HOST` and
 *    `port` from the hardcoded Mumble port (64738). The form doesn't show
 *    host/port at all, and even if the client tries to send them they're
 *    dropped here (defense-in-depth — a stale or malicious client must not be
 *    able to inject the public-facing host).
 *
 * `discriminatedUnion` keeps the error messages crisp on the client (you get
 * the right per-branch field errors rather than a unioned mess from `or`).
 */
export const createServerSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('self-hosted'),
    ...baseCreateServerFields,
    host: hostSchema,
    port: portSchema.optional(),
  }),
  z.object({
    mode: z.literal('managed'),
    ...baseCreateServerFields,
  }),
])

export const updateServerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80, 'Name is too long').optional(),
  description: z.string().max(1000, 'Description is too long').optional().nullable(),
  oracleOnly: z.boolean().optional(),
  // Re-selectable voice region. `null` explicitly clears the region.
  region: regionCodeSchema.optional().nullable(),
})

export type CreateServerInput = z.infer<typeof createServerSchema> & {
  ownerUserId: string
}
export type UpdateServerInput = z.infer<typeof updateServerSchema>
