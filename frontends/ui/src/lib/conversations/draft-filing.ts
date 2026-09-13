/**
 * File an unfiled working-directory draft into the project — from the browser,
 * as the signed-in user.
 */

import 'server-only'
import { createHash } from 'node:crypto'
import { BadRequestError, ConflictError, NotFoundError, UnprocessableError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireResourceAccess } from '@/lib/sharing/access'
import { fileAgentDocumentDraft } from '@/lib/documents/agent-document'
import { documentDisplayName } from '@/lib/documents/display-name'
import type { DocumentVersionState } from '@/lib/documents/lifecycle-types'
import { findDocumentAuthoredByRef, listProjectDocuments, DOCUMENT_LIST_LIMIT } from '@/lib/documents/repository'
import type { DocumentListRow } from '@/lib/documents/repository'
import { findOpenVersion } from '@/lib/documents/version-repository'
import { findConversationInOrg } from './repository'
import { readConversationDraft } from './draft-preview'

export const MAX_FILING_REF_CHARS = 200
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

export function normalizeDraftPath(path: string): string {
  return path.trim().replace(/^\/+/, '')
}

function filingHash(conversationId: string, path: string): string {
  return createHash('sha256').update(`${conversationId}\0${path}`).digest('hex').slice(0, 8)
}

export function filingReference(conversationId: string, path: string): string {
  const normalized = normalizeDraftPath(path)
  const raw = `${conversationId}-${filingSlug(normalized)}`
  if (raw.length <= MAX_FILING_REF_CHARS) return raw
  // PAIRED CHANGE (deferred agent-side mirror): the agent tier mints the same
  // reference (`tools/documents/register.py::filing_reference`), which today
  // truncates plainly with `[:MAX_REF_CHARS]` — the hash suffix here is
  // unconfirmed there. Change this truncation or the hash, and change that
  // side in the same commit: long keys would otherwise diverge and a browser
  // filing would land beside the agent's document as a duplicate.
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

/**
 * The same-name veto's scan: every project document whose SHOWN name already
 * equals the draft's title — the thing a reader would confuse.
 *
 * Paginated, page by page: the repository bounds every listing
 * (`DOCUMENT_LIST_LIMIT`), so a single page misses the veto past 500 rows and
 * files the duplicate this exists to stop. Stops at the first short page; a
 * concurrent create landing mid-scan is found by the next filing, not this one.
 */
async function findSameTitleDocument(
  projectId: string,
  organizationId: string,
  title: string,
): Promise<DocumentListRow | null> {
  let offset = 0
  for (;;) {
    const rows = await listProjectDocuments(projectId, organizationId, {
      limit: DOCUMENT_LIST_LIMIT,
      offset,
    })
    const clash = rows.find((row) => sameTitle(documentDisplayName(row), title))
    if (clash) return clash
    if (rows.length < DOCUMENT_LIST_LIMIT) return null
    offset += rows.length
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

  // Normalized ONCE, reused for the read, the title fallback and the
  // reference: the raw card path carries fringe (a leading `/`, whitespace)
  // that must reach none of the three. A ref minted from the raw path misses
  // the agent's row, and a title fallen back from it misses the veto below —
  // both as a duplicate document.
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
    // The reference above already returned, so any match here is an unrelated
    // document, never this draft's own row — filing never versions onto one.
    const clash = await findSameTitleDocument(projectId, session.organizationId, title)
    if (clash) {
      throw new ConflictError('A document with this title is already in the project', {
        reason: 'same-name',
        documentId: clash.id,
        displayName: documentDisplayName(clash),
      })
    }
  }

  // No serialized admission here, deliberately (deferred): concurrent presses
  // for the SAME reference converge through the ref probe above — the second
  // gets `alreadyFiled`, never a second document — so the only race left is
  // two different references filing one title in the same instant. Closing
  // that needs a lock or a partial unique index on the shown name, a bigger
  // change than this veto; filing is a low-contention human gesture, so the
  // scan above is the decided scope.
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
