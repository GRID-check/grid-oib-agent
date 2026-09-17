/**
 * The typed browser client for the conversation draft-preview API (ADR-0055).
 *
 * One base path, spelled once: the unfiled card reads its CONTENT through the
 * BFF (`GET /api/conversations/[id]/draft?path=…`), which in turn proxies the
 * agent service's read door after checking the reader may see the
 * conversation. No `server-only` and no drizzle: the browser imports this.
 */

import { z } from 'zod'

/** What the BFF answers for one draft: content plus the chrome facts. */
export const conversationDraftPreviewSchema = z.object({
  path: z.string(),
  content: z.string(),
  version: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
})

export type ConversationDraftPreview = z.infer<typeof conversationDraftPreviewSchema>

/**
 * How a request is made. Injected rather than closed over, so a route spec can
 * hand in a function that calls the real handler and a browser gets `fetch`
 * — the same seam `documentLifecycleClient` offers (`LifecycleFetch`).
 */
export type DraftPreviewFetch = (path: string, init?: RequestInit) => Promise<Response>

const defaultFetch: DraftPreviewFetch = (path, init) => fetch(path, init)

/**
 * A request the API refused, carrying the status and the body's own code.
 *
 * A typed error rather than a thrown `Response`: the card needs the same two
 * facts for every refusal — what happened, and whether retrying is worth
 * anything — without reading them off a `Response` at the call site.
 */
export class DocumentDraftPreviewError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'DocumentDraftPreviewError'
  }
}

/**
 * Read one draft's content for the preview surface. Throws
 * {@link DocumentDraftPreviewError} when the API refuses; the card renders
 * every refusal as the same actionable message with a retry control.
 */
export async function fetchConversationDraft(
  conversationId: string,
  path: string,
  run: DraftPreviewFetch = defaultFetch,
): Promise<ConversationDraftPreview> {
  const url = `/api/conversations/${encodeURIComponent(conversationId)}/draft?path=${encodeURIComponent(path)}`
  const response = await run(url, { method: 'GET' })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const error = (body ?? {}) as { error?: string; code?: string }
    throw new DocumentDraftPreviewError(
      response.status,
      error.code ?? 'UNKNOWN',
      error.error ?? `Request failed with ${response.status}`,
    )
  }
  return conversationDraftPreviewSchema.parse(body)
}
