/**
 * File an unfiled working-directory draft into the project — from the browser,
 * as the signed-in user.
 *
 * The agent's own filing (`file_draft` → `POST /api/internal/document-versions`)
 * and this route converge on ONE document through the same idempotency
 * reference (`{conversationId}-{slug}`, {@link filingReference}): whichever of
 * the two files first wins the `(authored_by_ref, producer)` probe inside
 * `fileGeneratedDocument`, and the second gets `alreadyFiled` with the open
 * version rather than a duplicate. Browser filing and agent filing are two
 * doors into the same `fileAgentDocumentDraft`, never two implementations.
 *
 * The session is the reader's own, so `actingHuman` stays at its default: the
 * internal agent route passes `false` because a machine acts there, while here
 * a person presses the button. Every permission check, every `created_by` and
 * every audit actor downstream is that person — the same gate, reached
 * directly rather than through a second turn.
 *
 * Only the `create` op is reachable here (a draft version, never a review
 * decision): the route calls `fileAgentDocumentDraft` and nothing else, so
 * approve, publish, reject and archive keep having no path from this surface,
 * exactly as the transition table's `actor` field requires.
 *
 * A same-name guard runs before anything is created: a project document whose
 * shown name already equals the draft's title is a 409 carrying that row, and
 * the card answers it with an explicit „Trotzdem ablegen" confirmation
 * (`force`). Filing never versions onto an unrelated document — the reference
 * decides identity, the title only vetoes.
 */

import 'server-only'
import { createHash } from 'node:crypto'
import { BadRequestError, ConflictError, NotFoundError, UnprocessableError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireResourceAccess } from '@/lib/sharing/access'
import { fileAgentDocumentDraft } from '@/lib/documents/agent-document'
import { documentDisplayName } from '@/lib/documents/display-name'
import type { DocumentVersionState } from '@/lib/documents/lifecycle-types'
import {
  DOCUMENT_LIST_LIMIT,
  findDocumentAuthoredByRef,
  listProjectDocuments,
  type DocumentListRow,
} from '@/lib/documents/repository'
import { findOpenVersion } from '@/lib/documents/version-repository'
import { findConversationInOrg } from './repository'
import { readConversationDraft } from './draft-preview'

/** Mirrors the agent tier's `MAX_REF_CHARS` (`tools/documents/register.py`). */
export const MAX_FILING_REF_CHARS = 200

/** The longest title a filing accepts — the lifecycle's own `title` ceiling. */
export const MAX_FILING_TITLE_CHARS = 200

function filingSlug(path: string): string {
  const name = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path
  const stem = name.replace(/\.md$/i, '')
  const slug = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'entwurf'
}

/** Leading slashes and surrounding whitespace are not identity. */
export function normalizeDraftPath(path: string): string {
  return path.trim().replace(/^\/+/, '')
}

function filingHash(conversationId: string, path: string): string {
  return createHash('sha256').update(`${conversationId}\0${path}`).digest('hex').slice(0, 8)
}

/**
 * The BFF's idempotency key: `{conversationId}-{slug}`, bounded.
 * When the readable prefix would be truncated, a hash of the full
 * conversation id plus the normalized path is kept as a suffix so two
 * long keys that share a prefix do not collide.
 */
export function filingReference(conversationId: string, path: string): string {
  const normalized = normalizeDraftPath(path)
  const raw = `${conversationId}-${filingSlug(normalized)}`
  if (raw.length <= MAX_FILING_REF_CHARS) return raw
  const suffix = `-${filingHash(conversationId, normalized)}`
  return `${raw.slice(0, MAX_FILING_REF_CHARS - suffix.length)}${suffix}`
}

function sameTitle(a: string, b: string): boolean {
  const key = (value: string): string => value.normalize('NFC').trim().toLowerCase()
  return key(a) === key(b)
}

function fallbackTitle(path: string): string {
  const name = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path
  return name.trim() || 'Entwurf'
}

async function findActiveProjectDocumentByShownName(
  projectId: string,
  organizationId: string,
  title: string,
): Promise<DocumentListRow | null> {
  const pageSize = DOCUMENT_LIST_LIMIT
  let offset = 0
  for (;;) {
    const page = await listProjectDocuments(projectId, organizationId, {
      limit: pageSize,
      offset,
    })
    const clash = page.find((row) => sameTitle(documentDisplayName(row), title))
    if (clash) return clash
    if (page.length < pageSize) return null
    offset += page.length
  }
}

export interface FileConversationDraftInput {
  path: string
  title?: string
  force?: boolean
}

export interface FiledConversationDraft {
  documentId: string
  versionId: string
  state: DocumentVersionState
  alreadyFiled: boolean
}

export async function fileConversationDraft(
  session: AuthorizedSession,
  conversationId: string,
  input: FileConversationDraftInput,
  request?: Request,
): Promise<FiledConversationDraft> {
  await requireResourceAccess(session, 'conversation', conversationId, 'viewer')

  const conversation = await findConversationInOrg(conversationId, session.organizationId)
  if (!conversation) throw new NotFoundError()
  if (!conversation.projectId) {
    throw new UnprocessableError('This conversation has no project to file into')
  }
  const projectId = conversation.projectId

  const path = normalizeDraftPath(input.path)
  const draft = await readConversationDraft(session, conversationId, path)

  const title = (input.title ?? '').trim() || fallbackTitle(path)
  if (title.length > MAX_FILING_TITLE_CHARS) {
    throw new BadRequestError('Title is too long')
  }
  const ref = filingReference(conversationId, path)

  const refHit = await findDocumentAuthoredByRef(ref, session.organizationId, projectId, 'agent_document')
  if (refHit) {
    const open = await findOpenVersion(refHit.id, session.organizationId)
    if (open && (open.state === 'draft' || open.state === 'changes_requested')) {
      return { documentId: refHit.id, versionId: open.id, state: open.state, alreadyFiled: true }
    }
    throw new ConflictError('This draft has already been filed and is no longer a draft', {
      reason: 'already-submitted',
    })
  }

  if (!input.force) {
    const clash = await findActiveProjectDocumentByShownName(projectId, session.organizationId, title)
    if (clash) {
      throw new ConflictError('A document with this title is already in the project', {
        reason: 'same-name',
        documentId: clash.id,
        displayName: documentDisplayName(clash),
      })
    }
  }

  const filed = await fileAgentDocumentDraft({
    session,
    projectId,
    ref,
    title,
    content: draft.content,
    request,
    originConversationId: conversationId,
  })
  return {
    documentId: filed.documentId,
    versionId: filed.version.id,
    state: filed.version.state,
    alreadyFiled: filed.alreadyFiled,
  }
}
