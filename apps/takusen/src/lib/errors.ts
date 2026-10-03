/**
 * Domain errors for the /api/v1 surface. `errorResponse` in api-helpers maps
 * each one to the status + `{ error, message? }` body the contract names
 * (docs/gateway-protocol.md §4).
 */
import { PROFILE_IMAGE_TYPES } from '@hachiman/client/files'

export class NotFoundError extends Error {
  constructor(message = 'Not found') {
    super(message)
    this.name = 'NotFoundError'
  }
}

export class MissingPermissionsError extends Error {
  constructor(message = 'Missing permissions') {
    super(message)
    this.name = 'MissingPermissionsError'
  }
}

/** A semantic 400 that zod can't express (unknown region, bad cursor, …). */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

/** 409: the request conflicts with current state (duplicate key, last admin, …). */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConflictError'
  }
}

export class InviteExpiredError extends Error {
  constructor() {
    super('Invite expired')
    this.name = 'InviteExpiredError'
  }
}

export class InviteRevokedError extends Error {
  constructor() {
    super('Invite has been revoked')
    this.name = 'InviteRevokedError'
  }
}

export class InviteExhaustedError extends Error {
  constructor() {
    super('Invite has reached its maximum uses')
    this.name = 'InviteExhaustedError'
  }
}

/** 413: missing Content-Length, or a body above TAKUSEN_MAX_UPLOAD_BYTES. */
export class UploadTooLargeError extends Error {
  constructor(message = 'Upload is too large') {
    super(message)
    this.name = 'UploadTooLargeError'
  }
}

/** 400: an upload id that is unknown, not the caller's, or already claimed. */
export class UnknownUploadError extends Error {
  constructor(message = 'Unknown upload') {
    super(message)
    this.name = 'UnknownUploadError'
  }
}

/** 400: an avatar, icon or banner upload whose type is not in PROFILE_IMAGE_TYPES. */
export class InvalidImageError extends Error {
  constructor(message = `Upload must be one of ${PROFILE_IMAGE_TYPES.join(', ')}`) {
    super(message)
    this.name = 'InvalidImageError'
  }
}

/**
 * A coded API error (docs/gateway-protocol.md §12.18, §12.19). `errorResponse`
 * maps it to `{ error: code, message?, ...extra }` with `status`, and sets
 * `Retry-After` when `retryAfterSec` is given.
 */
export class ApiError extends Error {
  /** False when the caller gave no message: the body then has no `message`. */
  readonly hasMessage: boolean

  constructor(
    readonly code: string,
    readonly status: number,
    message?: string,
    readonly extra?: Record<string, unknown>,
    readonly retryAfterSec?: number,
  ) {
    super(message ?? code)
    this.name = 'ApiError'
    this.hasMessage = message !== undefined
  }
}
