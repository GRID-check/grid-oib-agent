/**
 * The E-Mail-Eingang's door to the API, as one object the components take.
 *
 * Every call is the typed client's (`adapters/api/inbound-mail-client.ts`,
 * ADR-0055): this only gathers them, so a component can be handed a fixture
 * client in a spec or a `/dev` preview and render the real thing over it.
 *
 * `follow` and `unfollow` are the calls the typed clients do not have yet: the follow
 * route belongs to the E-Mail-Verlauf (`mail-thread-follow`, D10), whose
 * client is `adapters/api/mail-thread-client.ts` (D16). Until that lands they
 * are the requests written here, against the same route and body schema.
 */

import {
  createInboundMailAddress,
  deleteInboundMailAddress,
  dismissInboundMails,
  fileInboundMails,
  getInboundMail,
  getInboundMailAddress,
  getInboundMailText,
  inboundMailOriginalUrl,
  inboundMailPartContentUrl,
  listInboundMails,
  listMailThreads,
  restoreInboundMail,
  rotateInboundMailAddress,
} from '@/adapters/api/inbound-mail-client'
import { ApiRequestError } from '@/adapters/api/api-error'
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
import type { MailThreadFollowBody, MailThreadSummaryView } from '@/lib/mail-thread/mail-thread-wire'

export interface InboundMailClient {
  list(projectId: string, query?: Partial<InboundMailListQuery>, signal?: AbortSignal): Promise<InboundMailListView>
  get(projectId: string, mailId: string, signal?: AbortSignal): Promise<InboundMailView>
  text(projectId: string, mailId: string, signal?: AbortSignal): Promise<InboundMailTextView>
  file(projectId: string, body: FileInboundMailsBody): Promise<InboundMailDecisionResultView>
  dismiss(projectId: string, body: DismissInboundMailsBody): Promise<{ mails: InboundMailView[] }>
  restore(projectId: string, mailId: string): Promise<InboundMailView>
  /** „Diesem E-Mail-Verlauf folgen“ (D31): the person's standing decision for one thread. */
  follow(projectId: string, threadId: string, body?: MailThreadFollowBody): Promise<void>
  /** Undo a follow just made (the toast's „Rückgängig“). */
  unfollow(projectId: string, threadId: string): Promise<void>
  /** The thread a document is, to follow a thread the text just started. */
  threadOfDocument(projectId: string, documentId: string): Promise<MailThreadSummaryView | null>
  partContentUrl(projectId: string, mailId: string, partId: string): string
  originalUrl(projectId: string, mailId: string): string
}

export interface InboundMailAddressClient {
  get(projectId: string, signal?: AbortSignal): Promise<InboundMailAddressView>
  create(projectId: string): Promise<InboundMailAddressView>
  rotate(projectId: string): Promise<InboundMailAddressView>
  remove(projectId: string): Promise<InboundMailAddressView>
}

const followUrl = (projectId: string, threadId: string): string =>
  `/api/projects/${encodeURIComponent(projectId)}/mail-threads/${encodeURIComponent(threadId)}/follow`

async function followRequest(url: string, init: RequestInit): Promise<void> {
  const response = await fetch(url, init)
  if (response.ok) return
  const envelope = ((await response.json().catch(() => null)) ?? {}) as { error?: unknown; details?: { reason?: unknown } }
  throw new ApiRequestError(
    typeof envelope.error === 'string' ? envelope.error : `The mail thread follow failed: ${response.status}`,
    response.status,
    typeof envelope.details?.reason === 'string' ? envelope.details.reason : null,
  )
}

function followMailThread(projectId: string, threadId: string, body: MailThreadFollowBody = {}): Promise<void> {
  return followRequest(followUrl(projectId, threadId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function unfollowMailThread(projectId: string, threadId: string): Promise<void> {
  return followRequest(followUrl(projectId, threadId), { method: 'DELETE' })
}

export const inboundMailClient: InboundMailClient = {
  list: listInboundMails,
  get: getInboundMail,
  text: getInboundMailText,
  file: fileInboundMails,
  dismiss: dismissInboundMails,
  restore: restoreInboundMail,
  follow: followMailThread,
  unfollow: unfollowMailThread,
  threadOfDocument: async (projectId, documentId) => (await listMailThreads(projectId, { documentId, limit: 1 })).items[0] ?? null,
  partContentUrl: inboundMailPartContentUrl,
  originalUrl: inboundMailOriginalUrl,
}

export const inboundMailAddressClient: InboundMailAddressClient = {
  get: getInboundMailAddress,
  create: createInboundMailAddress,
  rotate: rotateInboundMailAddress,
  remove: deleteInboundMailAddress,
}
