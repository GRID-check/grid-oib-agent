/**
 * One request to confirm, or take back, that a newer document replaces an older
 * one (CONTEXT.md, „Fassung"), and what the server says is true afterwards.
 *
 * `PUT /api/documents/{newer}/fassung`. The answer carries the facts of BOTH
 * documents as this reader now sees them, because the link changes both cards:
 * the newer one's „ersetzt …" and the older one's „ersetzt durch …". Modelled
 * on `reingest-request.ts`, but a refusal throws: the caller owns the toast.
 */

import { EMPTY_FASSUNG, type FassungFacts } from '@/lib/documents/fassung'

export interface FassungLinkAnswer {
  /** The newer document's facts. */
  newer: FassungFacts
  /** The older document's facts. */
  older: FassungFacts
}

/** A refusal or a failed request. `status` is the HTTP status, `0` when nothing answered. */
export class FassungRequestError extends Error {
  constructor(readonly status: number) {
    super(`Fassung request failed (${status})`)
    this.name = 'FassungRequestError'
  }
}

interface WireAnswer {
  fassung?: FassungFacts | null
  older?: { fassung?: FassungFacts | null } | null
}

/** Link (`linked: true`) or unlink the two documents. Answers both documents' facts; throws {@link FassungRequestError}. */
export async function requestFassungLink(newerId: string, olderId: string, linked: boolean): Promise<FassungLinkAnswer> {
  let res: Response
  try {
    res = await fetch(`/api/documents/${encodeURIComponent(newerId)}/fassung`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ older: olderId, linked }),
    })
  } catch {
    throw new FassungRequestError(0)
  }
  if (!res.ok) throw new FassungRequestError(res.status)
  const body = ((await res.json().catch(() => ({}))) ?? {}) as WireAnswer
  return { newer: body.fassung ?? EMPTY_FASSUNG, older: body.older?.fassung ?? EMPTY_FASSUNG }
}

/** The newer document's facts after linking or unlinking (`EMPTY_FASSUNG` when none); throws {@link FassungRequestError}. */
export async function setFassungLink(newerId: string, olderId: string, linked: boolean): Promise<FassungFacts> {
  return (await requestFassungLink(newerId, olderId, linked)).newer
}
