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
import { findDocumentAuthoredByRef, listProjectDocuments } from '@/lib/documents/repository'
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
    const rows = await listProjectDocuments(projectId, session.organizationId)
    const clash = rows.find((row) => sameTitle(documentDisplayName(row), title))
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
