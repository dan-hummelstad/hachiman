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

export const createServerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80, 'Name is too long'),
  slug: slugSchema,
  host: z
    .string()
    .trim()
    .min(1, 'Host is required')
    .max(253, 'Host is too long')
    .regex(
      /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/,
      'Host must be a valid DNS name (e.g. mumble.example.com)',
    ),
  port: z
    .number()
    .int('Port must be an integer')
    .min(1, 'Port must be between 1 and 65535')
    .max(65535, 'Port must be between 1 and 65535')
    .optional(),
  description: z.string().max(1000, 'Description is too long').optional().nullable(),
})

export const updateServerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80, 'Name is too long').optional(),
  description: z.string().max(1000, 'Description is too long').optional().nullable(),
})

export type CreateServerInput = z.infer<typeof createServerSchema> & {
  ownerUserId: string
}
export type UpdateServerInput = z.infer<typeof updateServerSchema>
