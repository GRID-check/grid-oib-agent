/**
 * The typed browser client for the conversation draft-filing API (ADR-0055).
 *
 * One base path, spelled once: the unfiled card files its draft through the
 * BFF (`POST /api/conversations/[id]/draft/file`), which reads the bytes from
 * the agent tier and creates the project document in the reader's own session.
 * No `server-only` and no drizzle: the browser imports this.
 */

import { z } from 'zod'

/** What the BFF answers once the draft is a project document. */
export const draftFileResponseSchema = z.object({
  documentId: z.string().min(1),
  versionId: z.string().min(1),
  state: z.string().min(1),
  alreadyFiled: z.boolean(),
})

export type DraftFileResponse = z.infer<typeof draftFileResponseSchema>

/**
 * How a request is made. Injected rather than closed over, so a route spec can
 * hand in a function that calls the real handler and a browser gets `fetch`
 * — the same seam `documentLifecycleClient` offers (`LifecycleFetch`).
 */
export type DraftFileFetch = (path: string, init?: RequestInit) => Promise<Response>

const defaultFetch: DraftFileFetch = (path, init) => fetch(path, init)

/**
 * A request the API refused, carrying the status, the body's own code, and —
 * on a same-name 409 — the existing row the card offers beside its explicit
 * confirmation.
 *
 * A typed error rather than a thrown `Response`: the card needs the same facts
 * for every refusal — what happened, and whether retrying or confirming is
 * worth anything — without reading them off a `Response` at the call site.
 */
export class DraftFileError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'DraftFileError'
  }
}

export interface FileDraftInput {
  /** Working-directory path as the card carries it (`/entwuerfe/….md`). */
  path: string
  /** The card's title; the service falls back to the file name when absent. */
  title: string
  /** Set after the card showed the same-name 409 and the reader confirmed. */
  force?: boolean
}

/**
 * File one draft into the project. Throws {@link DraftFileError} when the API
 * refuses; the card renders a 409 as the same-name confirmation and every
 * other refusal as an actionable message with a retry control.
 */
export async function fileConversationDraft(
  conversationId: string,
  input: FileDraftInput,
  run: DraftFileFetch = defaultFetch,
): Promise<DraftFileResponse> {
  const url = `/api/conversations/${encodeURIComponent(conversationId)}/draft/file`
  const response = await run(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: input.path, title: input.title, force: input.force ?? false }),
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const error = (body ?? {}) as { error?: string; code?: string; details?: unknown }
    throw new DraftFileError(
      response.status,
      error.code ?? 'UNKNOWN',
      error.error ?? `Request failed with ${response.status}`,
      error.details,
    )
  }
  return draftFileResponseSchema.parse(body)
}
