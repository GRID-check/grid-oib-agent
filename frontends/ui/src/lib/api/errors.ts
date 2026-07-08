/**
 * Typed API errors for the BFF service layer.
 *
 * Services and repositories throw these instead of returning HTTP responses;
 * the route-handler wrapper in `@/lib/api/handler` maps them to the JSON
 * error envelope. This keeps HTTP concerns out of the service layer while
 * guaranteeing every route returns consistent, non-leaky error responses.
 */

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
  constructor(message = 'Forbidden') {
    super(403, 'FORBIDDEN', message)
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

/** 502 — an upstream dependency (backend, WorkOS, MinIO) failed. */
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
