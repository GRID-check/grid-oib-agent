/**
 * Read one working-directory draft for the browser (the unfiled card's preview).
 *
 * The draft lives in the agent service's LangGraph store, namespaced by
 * conversation id — the BFF cannot reach that store, so this service proxies
 * the Python tier's read door (`GET /v1/drafts/{conversation_id}/{path...}`,
 * `frontends/aiq_api/src/aiq_api/routes/drafts.py`) with the internal
 * service token, exactly as `discardConversationDrafts` does for the delete
 * door (`./working-directory`).
 *
 * Authorization is the conversation's own: `viewer` via `requireResourceAccess`
 * (`@/lib/sharing/access`), checked BEFORE the backend is addressed, so only
 * drafts of conversations the reader may access are proxied. Denials are
 * `NotFoundError`, so a refused id is indistinguishable from an absent one
 * (spec SH-6). There is no repository here — nothing in `grid_app` is read or
 * written; the conversation row is only the gate, never the source.
 */

import 'server-only'
import { z } from 'zod'
import { getBackendUrl } from '@/lib/backend-proxy'
import {
  BadRequestError,
  NotFoundError,
  PayloadTooLargeError,
  ServiceUnavailableError,
  UpstreamError,
} from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireResourceAccess } from '@/lib/sharing/access'

/** The same ceiling as the discard: an unreachable backend must not hold the request. */
const DRAFT_READ_TIMEOUT_MS = 10_000

/** What the agent service answers for one draft (filing included when filed). */
const backendDraftSchema = z.object({
  path: z.string(),
  content: z.string(),
  version: z.number().int().nonnegative(),
})

/** What the browser gets: the bytes plus the content, for the surface chrome. */
export interface ConversationDraftPreview {
  path: string
  content: string
  version: number
  bytes: number
}

/**
 * Read one draft of one conversation the caller may see.
 *
 * `path` is the working-directory path as the card carries it
 * (`/entwuerfe/….md`, leading slash optional). It travels as path SUFFIX
 * segments — one `encodeURIComponent` per segment — so a crafted path cannot
 * widen the read beyond its own conversation namespace; the backend applies
 * the same refusal the write verbs enforce and answers 400 past it.
 */
export async function readConversationDraft(
  session: AuthorizedSession,
  conversationId: string,
  path: string,
): Promise<ConversationDraftPreview> {
  await requireResourceAccess(session, 'conversation', conversationId, 'viewer')

  const trimmed = path.trim()
  if (!trimmed || trimmed.length > 500) {
    throw new BadRequestError('Invalid draft path')
  }
  const stripped = trimmed.replace(/^\/+/, '')
  if (!stripped) {
    throw new BadRequestError('Invalid draft path')
  }
  const encodedPath = stripped
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')

  const token = process.env.GRID_INTERNAL_API_TOKEN
  if (!token) {
    throw new ServiceUnavailableError('Draft preview is unavailable')
  }

  let response: Response
  try {
    response = await fetch(
      `${getBackendUrl()}/v1/drafts/${encodeURIComponent(conversationId)}/${encodedPath}`,
      {
        method: 'GET',
        headers: { 'x-grid-internal-token': token },
        signal: AbortSignal.timeout(DRAFT_READ_TIMEOUT_MS),
      },
    )
  } catch {
    throw new UpstreamError('Draft preview is unavailable')
  }

  if (!response.ok) {
    if (response.status === 404) throw new NotFoundError()
    if (response.status === 400) throw new BadRequestError('Invalid draft path')
    if (response.status === 413) throw new PayloadTooLargeError()
    throw new UpstreamError(`Draft preview failed with ${response.status}`)
  }

  const parsed = backendDraftSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) {
    throw new UpstreamError('Draft preview answered unexpectedly')
  }
  return {
    path: parsed.data.path,
    content: parsed.data.content,
    version: parsed.data.version,
    bytes: Buffer.byteLength(parsed.data.content, 'utf8'),
  }
}
