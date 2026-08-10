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
    readonly details?: unknown,
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
  constructor(message = 'Service unavailable') {
    super(503, 'SERVICE_UNAVAILABLE', message)
  }
}
