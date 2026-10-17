/**
 * Errors an authorization lookup raises when it could not reach an answer.
 *
 * Every authz lookup here fails CLOSED by default: a WorkOS call that broke is
 * read as "not a member" or "not allowed". That is right for a person at a
 * screen, who retries by clicking again. It is wrong for an unattended caller
 * that can retry on its own, such as the inbound-mail filing job: turning a
 * thirty-second WorkOS blip into "this sender is not a member" refuses mail
 * permanently that would have filed a minute later (review finding C2).
 *
 * So the lookups take `{ onError: 'throw' }`, and raise this instead of
 * denying. It extends {@link ApiError} with a 503, so a route that lets it
 * escape answers "try again" through the ordinary error envelope.
 */

import { ApiError } from '@/lib/api/errors'

export class TransientAuthzError extends ApiError {
  constructor(
    /** Which lookup failed, for the log line. Never user data. */
    readonly lookup: string,
    options?: { cause?: unknown },
  ) {
    super(503, 'AUTHZ_UNAVAILABLE', `Authorization lookup unavailable: ${lookup}`)
    if (options?.cause !== undefined) {
      Object.defineProperty(this, 'cause', { value: options.cause, enumerable: false })
    }
  }
}

/**
 * What a lookup does when it cannot answer: deny (the default everywhere), or
 * raise {@link TransientAuthzError} so the caller can retry.
 */
export type AuthzErrorMode = 'deny' | 'throw'

export interface AuthzLookupOptions {
  readonly onError?: AuthzErrorMode
}
