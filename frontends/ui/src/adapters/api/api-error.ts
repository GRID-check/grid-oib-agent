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

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}
