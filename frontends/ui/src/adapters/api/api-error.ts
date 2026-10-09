/**
 * API Request Error
 *
 * Error thrown by REST client helpers when the backend (or proxy) returns a
 * non-OK response. Carries the HTTP status code so consumers can classify
 * failures structurally (e.g. 404/410 → resource gone) instead of matching
 * substrings in free-text messages.
 */
export class ApiRequestError extends Error {
  readonly status: number
  /** The server's machine-readable `details.reason`, when it sent one. */
  readonly reason: string | null

  constructor(message: string, status: number, reason: string | null = null) {
    super(message)
    this.status = status
    this.reason = reason
  }
}
