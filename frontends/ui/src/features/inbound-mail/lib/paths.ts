/**
 * Where the E-Mail-Eingang lives: the list with its filter, one mail, and
 * Dateien. The URL carries the open mail and the filter, so a link to a mail
 * opens it and Back closes it (DECISION §9, D23).
 *
 * Pure.
 */

import type { InboundMailListStatus, InboundMailOutcome } from '@/lib/inbound-mail/inbound-mail-wire'

export interface InboundMailPaths {
  /** The list, with its filter. */
  list: (filter: { status: InboundMailListStatus; outcome: InboundMailOutcome | null }) => string
  /** One mail, keeping the filter. */
  mail: (mailId: string, filter: { status: InboundMailListStatus; outcome: InboundMailOutcome | null }) => string
  /** Dateien. */
  files: string
}

function filterQuery({ status, outcome }: { status: InboundMailListStatus; outcome: InboundMailOutcome | null }): string {
  const params = new URLSearchParams()
  if (status !== 'waiting') params.set('status', status)
  if (status === 'handled' && outcome) params.set('outcome', outcome)
  const text = params.toString()
  return text ? `?${text}` : ''
}

export function inboundMailPaths(projectId: string): InboundMailPaths {
  const base = `/app/projects/${encodeURIComponent(projectId)}/files/mail`
  return {
    list: (filter) => `${base}${filterQuery(filter)}`,
    mail: (mailId, filter) => `${base}/${encodeURIComponent(mailId)}${filterQuery(filter)}`,
    files: `/app/projects/${encodeURIComponent(projectId)}/files`,
  }
}
