/**
 * The E-Mail-Eingang's client (ADR-0134, ADR-0055): the typed browser door to
 * the routes the agent operations name (`lib/agent-api/catalog/mail.ts`), so
 * the UI and an agent are two clients of one API.
 *
 *   - address  → `/api/projects/[id]/inbound-mail-address` (GET, POST, DELETE) and `…/rotate`
 *   - mail     → `/api/projects/[id]/inbound-mails` (list), `…/[mailId]`, `…/[mailId]/text`,
 *                `…/file`, `…/dismiss`, `…/[mailId]/restore`
 *   - bytes    → `…/[mailId]/parts/[partId]/content`, `…/[mailId]/original` (links, never fetched here)
 *   - threads  → `/api/projects/[id]/mail-threads`, `…/[threadId]`
 *
 * The shapes are the wire module's (`lib/inbound-mail/inbound-mail-wire.ts`,
 * `lib/mail-thread/mail-thread-wire.ts`), imported, never restated. A refusal
 * arrives as {@link ApiRequestError} with the server's code in `reason`
 * (`stale`, `name_stop`, `sender_not_acknowledged`, …), which the UI words.
 */

import type {
  DismissInboundMailsBody,
  FileInboundMailsBody,
  InboundMailAddressView,
  InboundMailDecisionResultView,
  InboundMailListQuery,
  InboundMailListView,
  InboundMailTextView,
  InboundMailView,
} from '@/lib/inbound-mail/inbound-mail-wire'
import type { MailThreadListQuery, MailThreadListView, MailThreadView } from '@/lib/mail-thread/mail-thread-wire'
import { ApiRequestError } from './api-error'

const enc = encodeURIComponent
const projectBase = (projectId: string) => `/api/projects/${enc(projectId)}`

/** The server's refusal as an error: its message, status and `details.reason`. */
async function requestError(response: Response, fallback: string): Promise<ApiRequestError> {
  const body: unknown = await response.json().catch(() => null)
  const envelope = (body ?? {}) as { error?: unknown; details?: { reason?: unknown } }
  const message = typeof envelope.error === 'string' && envelope.error ? envelope.error : `${fallback}: ${response.status}`
  const reason = typeof envelope.details?.reason === 'string' ? envelope.details.reason : null
  return new ApiRequestError(message, response.status, reason)
}

async function request<T>(url: string, fallback: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) throw await requestError(response, fallback)
  return (await response.json()) as T
}

const postJson = (body: unknown, signal?: AbortSignal): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  signal,
})

function searchOf(query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value))
  const text = params.toString()
  return text ? `?${text}` : ''
}

// ------------------------------------------------------------ the address

export function getInboundMailAddress(projectId: string, signal?: AbortSignal): Promise<InboundMailAddressView> {
  return request(`${projectBase(projectId)}/inbound-mail-address`, 'Failed to load the project mail address', { signal })
}

export function createInboundMailAddress(projectId: string): Promise<InboundMailAddressView> {
  return request(`${projectBase(projectId)}/inbound-mail-address`, 'Failed to create the project mail address', { method: 'POST' })
}

export function rotateInboundMailAddress(projectId: string): Promise<InboundMailAddressView> {
  return request(`${projectBase(projectId)}/inbound-mail-address/rotate`, 'Failed to replace the project mail address', { method: 'POST' })
}

export function deleteInboundMailAddress(projectId: string): Promise<InboundMailAddressView> {
  return request(`${projectBase(projectId)}/inbound-mail-address`, 'Failed to switch off the project mail address', { method: 'DELETE' })
}

// ------------------------------------------------------------ held mail

export function listInboundMails(
  projectId: string,
  query: Partial<InboundMailListQuery> = {},
  signal?: AbortSignal,
): Promise<InboundMailListView> {
  const search = searchOf({ status: query.status, outcome: query.outcome, limit: query.limit, cursor: query.cursor })
  return request(`${projectBase(projectId)}/inbound-mails${search}`, 'Failed to load the project mail', { signal })
}

export function getInboundMail(projectId: string, mailId: string, signal?: AbortSignal): Promise<InboundMailView> {
  return request(`${projectBase(projectId)}/inbound-mails/${enc(mailId)}`, 'Failed to load the mail', { signal })
}

export function getInboundMailText(projectId: string, mailId: string, signal?: AbortSignal): Promise<InboundMailTextView> {
  return request(`${projectBase(projectId)}/inbound-mails/${enc(mailId)}/text`, 'Failed to load the mail text', { signal })
}

/** Decide 1 to 20 mails (202): the decisions are written and the filing runs as the person. */
export function fileInboundMails(projectId: string, body: FileInboundMailsBody): Promise<InboundMailDecisionResultView> {
  return request(`${projectBase(projectId)}/inbound-mails/file`, 'Failed to file the mail', postJson(body))
}

export function dismissInboundMails(projectId: string, body: DismissInboundMailsBody): Promise<{ mails: InboundMailView[] }> {
  return request(`${projectBase(projectId)}/inbound-mails/dismiss`, 'Failed to dismiss the mail', postJson(body))
}

export function restoreInboundMail(projectId: string, mailId: string): Promise<InboundMailView> {
  return request(`${projectBase(projectId)}/inbound-mails/${enc(mailId)}/restore`, 'Failed to restore the mail', { method: 'POST' })
}

/** Where an attachment's bytes are served once its scan was clean (a preview fetches it, a link downloads it). */
export function inboundMailPartContentUrl(projectId: string, mailId: string, partId: string): string {
  return `${projectBase(projectId)}/inbound-mails/${enc(mailId)}/parts/${enc(partId)}/content`
}

/** Where a held mail's original `.eml` is downloaded, scanned whole on each request. */
export function inboundMailOriginalUrl(projectId: string, mailId: string): string {
  return `${projectBase(projectId)}/inbound-mails/${enc(mailId)}/original`
}

// ------------------------------------------------------------ threads

export function listMailThreads(
  projectId: string,
  query: Partial<MailThreadListQuery> = {},
  signal?: AbortSignal,
): Promise<MailThreadListView> {
  const search = searchOf({ documentId: query.documentId, limit: query.limit, cursor: query.cursor })
  return request(`${projectBase(projectId)}/mail-threads${search}`, 'Failed to load the mail threads', { signal })
}

export function getMailThread(projectId: string, threadId: string, signal?: AbortSignal): Promise<MailThreadView> {
  return request(`${projectBase(projectId)}/mail-threads/${enc(threadId)}`, 'Failed to load the mail thread', { signal })
}
