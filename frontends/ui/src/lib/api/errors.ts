/**
 * Typed API errors for the BFF service layer.
 *
 * Services and repositories throw these instead of returning HTTP responses;
 * the route-handler wrapper in `@/lib/api/handler` maps them to the JSON
 * error envelope. This keeps HTTP concerns out of the service layer while
 * guaranteeing every route returns consistent, non-leaky error responses.
 */

import type { RateLimitDecision } from '@/lib/limits/types'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Optional machine-readable details, serialized at the envelope top level. */
    readonly details?: unknown
  ) {
    super(message)
    this.name = new.target.name
  }
}

/** 400 — malformed input (bad JSON, schema violations, invalid params). */
export class BadRequestError extends ApiError {
  constructor(message = 'Bad request', details?: unknown) {
    super(400, 'BAD_REQUEST', message, details)
  }
}

/** 401 — no valid session. */
export class UnauthorizedError extends ApiError {
  constructor(message = 'Unauthorized') {
    super(401, 'UNAUTHORIZED', message)
  }
}

/** 403 — authenticated but not allowed. */
export class ForbiddenError extends ApiError {
  constructor(message = 'Forbidden', details?: unknown) {
    super(403, 'FORBIDDEN', message, details)
  }
}

/**
 * 403 — agent org-scoped memory writes are disabled by deployment policy.
 * A DISTINCT code from the generic ForbiddenError('FORBIDDEN') the internal
 * token guard emits, so the Python backend can tell an intentional org-memory
 * default-deny apart from a service-token mismatch (audit finding S1).
 */
export class OrgMemoryDisabledError extends ApiError {
  constructor(message = 'Agent organization-scoped memory is disabled') {
    super(403, 'ORG_MEMORY_DISABLED', message)
  }
}

/**
 * 403 — a conversation that drew on a folder with restricted access may not
 * carry its content to where others read it (ADR-0080): a deep-research run, a
 * task, the project profile, or a folder not restricted at least as narrowly.
 * Its own code, so a caller (the agent's tools, a card) can tell this refusal
 * from a missing permission; `details.action` says which door refused. The
 * message is already the reader's sentence (`lib/conversations/restricted-egress.ts`).
 */
export class ConversationConfinedError extends ApiError {
  constructor(
    readonly action: 'deepResearch' | 'task' | 'profilePatch' | 'filing',
    message: string
  ) {
    super(403, 'CONVERSATION_CONFINED', message, { action })
  }
}

/** The machine-readable reason a person no longer has the rights to read a resource's content. */
export const RIGHTS_LOST_REASON = 'rights-lost'

/**
 * 403 — the caller is still a party to the resource (a grant, its creator) but
 * can no longer read what it was drawn from: a conversation that recorded a
 * folder they may not read now (ADR-0081). Its own code, so the client shows
 * "you no longer have the rights" instead of "not found", and its message and
 * details carry nothing of the content: not its title, not the folder.
 */
export class ResourceRightsLostError extends ApiError {
  constructor(readonly resourceType: string) {
    super(403, 'RESOURCE_RIGHTS_LOST', 'You no longer have the rights to view this content.', {
      reason: RIGHTS_LOST_REASON,
      resourceType,
    })
  }
}

/**
 * 404 — resource missing OR the caller may not know it exists.
 * Cross-tenant and no-access lookups throw this (never Forbidden) so
 * responses do not leak resource existence to unauthorized callers.
 */
export class NotFoundError extends ApiError {
  constructor(message = 'Not found') {
    super(404, 'NOT_FOUND', message)
  }
}

/** 409 — state conflict (duplicate id, concurrent update). */
export class ConflictError extends ApiError {
  constructor(message = 'Conflict', details?: unknown) {
    super(409, 'CONFLICT', message, details)
  }
}

/** 422 — well-formed input that fails domain validation. */
export class UnprocessableError extends ApiError {
  constructor(message = 'Unprocessable', details?: unknown) {
    super(422, 'UNPROCESSABLE', message, details)
  }
}

/**
 * 413 — the request body was larger than the server will accept.
 *
 * Distinct from the 400 that judges a declared file size: this one is reached
 * when the body has ALREADY been cut off in transit, so nothing downstream can
 * name the file — the multipart stream carrying its name is the thing that
 * failed to parse. The limit is worth stating for exactly that reason: it is
 * the only actionable fact left.
 */
export class PayloadTooLargeError extends ApiError {
  constructor(limitBytes?: number) {
    super(
      413,
      'PAYLOAD_TOO_LARGE',
      limitBytes
        ? `Request body exceeds the maximum accepted size of ${Math.round(limitBytes / (1024 * 1024))} MB`
        : 'Request body exceeds the maximum accepted size',
      limitBytes ? { limitBytes } : undefined
    )
  }
}

/**
 * 507 — the organization's storage quota would be exceeded by this write.
 *
 * Distinct from 400 "file exceeds the maximum size", which judges the ONE file:
 * this one says the file is acceptable but the tenant has no room left, so the
 * remedy is different (delete something, or raise the quota) and the UI has to
 * say so. RFC 4918's Insufficient Storage is exactly this case.
 *
 * NOT a rate limit: 429 means come back later, this means nothing changes until
 * someone acts.
 */
export class InsufficientStorageError extends ApiError {
  constructor(
    message = 'Storage quota exceeded',
    details?: { quotaBytes: number; usedBytes: number; requestedBytes: number }
  ) {
    super(507, 'STORAGE_QUOTA_EXCEEDED', message, details)
  }
}

/**
 * 429 — an abuse bound was reached (ADR-0040 L2).
 *
 * Carries the decision itself rather than a bare message, because the three
 * things a client needs — which policy bit, how much is left, when to come back
 * — are all in it, and `@/lib/api/handler` turns them into the `Retry-After` and
 * `X-RateLimit-*` headers. `retryAfterSeconds` comes from the limiter's own
 * arithmetic (GCRA knows exactly when the request would be admitted), so it is
 * a fact rather than the usual "try again in a window".
 *
 * NOT the error for a budget refusal: running out of euros is ADR-0015's
 * business and has its own, fail-closed path.
 */
export class TooManyRequestsError extends ApiError {
  readonly retryAfterSeconds: number

  constructor(decision: RateLimitDecision, message = 'Too many requests') {
    super(429, 'RATE_LIMITED', message, {
      policy: decision.rule,
      retryAfterSeconds: decision.retryAfterSeconds,
    })
    this.retryAfterSeconds = decision.retryAfterSeconds
    this.decision = decision
  }

  /** The full decision, for `rateLimitHeaders`. */
  readonly decision: RateLimitDecision
}

/** 502 — an upstream dependency (backend, WorkOS, SeaweedFS) failed. */
export class UpstreamError extends ApiError {
  constructor(message = 'Upstream service error', details?: unknown) {
    super(502, 'UPSTREAM_ERROR', message, details)
  }
}

/** 503 — endpoint deliberately disabled (e.g. internal token unconfigured). */
export class ServiceUnavailableError extends ApiError {
  constructor(message = 'Service unavailable', details?: unknown) {
    super(503, 'SERVICE_UNAVAILABLE', message, details)
  }
}
