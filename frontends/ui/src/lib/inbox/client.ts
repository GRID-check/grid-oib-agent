/**
 * The typed client for the inbox API (ADR-0035, ADR-0055): the paths, the verbs
 * and the response shapes, written once. The inbox list and badge, the review
 * (opening a mark reads its news) and the notification offer all call this,
 * and the route spec drives the real handlers through it, so no consumer can
 * disagree with another about what `POST /api/inbox/read` expects.
 *
 * The service worker is the one consumer that cannot import it (a classic
 * script with no build step, `public/sw.js`); it names the read path itself and
 * its spec holds it to {@link INBOX_READ_PATH}.
 *
 * No `server-only`: the browser imports this.
 */

import { z } from 'zod'
import type {
  InboxItemView,
  InboxListFilter,
  InboxListResponse,
  InboxMutationResult,
  InboxSummaryResponse,
} from './types'

export type InboxFetch = (path: string, init?: RequestInit) => Promise<Response>

const defaultFetch: InboxFetch = (path, init) => fetch(path, init)

const BASE = '/api/inbox'

/** `POST` here marks read: item ids, everything, or the news about one mark. */
export const INBOX_READ_PATH = `${BASE}/read`

/** A request the API refused, with its status. */
export class InboxRequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'InboxRequestError'
  }
}

const mutationResultSchema = z.object({ affected: z.number(), pending: z.number() })
const summarySchema = z.object({ pending: z.number() })
/**
 * The page's envelope is checked; its rows are the server's `InboxItemView`s,
 * which the row renderer already reads defensively (an unknown type falls back,
 * IB-6), so they are not re-validated field by field here.
 */
const itemSchema = z.custom<InboxItemView>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { type?: unknown }).type === 'string'
)
const listSchema: z.ZodType<InboxListResponse> = z.object({
  items: z.array(itemSchema),
  pending: z.number(),
  counts: z.object({ requests: z.number(), unread: z.number() }),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
})

export interface ListInboxQuery {
  filter?: InboxListFilter
  /** The previous page's `nextCursor`. */
  cursor?: string | null
}

/** The mark whose news the reader just opened. */
export interface MarkRef {
  documentId: string
  annotationId: string
}

export interface InboxClient {
  list(query?: ListInboxQuery): Promise<InboxListResponse>
  summary(): Promise<InboxSummaryResponse>
  markRead(itemIds: readonly string[]): Promise<InboxMutationResult>
  markAllRead(): Promise<InboxMutationResult>
  /** The informational items anchored on one mark: what opening it in the review reads. */
  markMarkRead(mark: MarkRef): Promise<InboxMutationResult>
  markUnread(itemIds: readonly string[]): Promise<InboxMutationResult>
  archive(itemId: string): Promise<InboxMutationResult>
  unarchive(itemId: string): Promise<InboxMutationResult>
}

export function createInboxClient(request: InboxFetch = defaultFetch): InboxClient {
  async function call<T>(path: string, init: RequestInit | undefined, schema: z.ZodType<T>): Promise<T> {
    const response = await request(path, {
      cache: 'no-store',
      ...init,
      headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
    })
    if (!response.ok) {
      throw new InboxRequestError(response.status, `${init?.method ?? 'GET'} ${path} answered ${response.status}`)
    }
    const parsed = schema.safeParse(await response.json())
    if (!parsed.success) throw new InboxRequestError(502, `${path} answered a shape this client does not know`)
    return parsed.data
  }

  const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) })
  const itemPath = (itemId: string) => `${BASE}/${encodeURIComponent(itemId)}/archive`

  return {
    list: async ({ filter = 'all', cursor } = {}) => {
      const params = new URLSearchParams({ filter })
      if (cursor) params.set('cursor', cursor)
      return call(`${BASE}?${params.toString()}`, undefined, listSchema)
    },
    summary: () => call(`${BASE}/summary`, undefined, summarySchema),
    markRead: (itemIds) => call(INBOX_READ_PATH, post({ itemIds }), mutationResultSchema),
    markAllRead: () => call(INBOX_READ_PATH, post({ all: true }), mutationResultSchema),
    markMarkRead: ({ documentId, annotationId }) =>
      call(
        INBOX_READ_PATH,
        post({ resourceType: 'document', resourceId: documentId, anchorId: annotationId }),
        mutationResultSchema
      ),
    markUnread: (itemIds) => call(`${BASE}/unread`, post({ itemIds }), mutationResultSchema),
    archive: (itemId) => call(itemPath(itemId), { method: 'POST' }, mutationResultSchema),
    unarchive: (itemId) => call(itemPath(itemId), { method: 'DELETE' }, mutationResultSchema),
  }
}

export const inboxClient: InboxClient = createInboxClient()
