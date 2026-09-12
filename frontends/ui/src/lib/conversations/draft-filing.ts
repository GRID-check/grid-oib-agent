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
import { findActiveProjectDocumentByShownName, findDocumentAuthoredByRef } from '@/lib/documents/repository'
import { findOpenVersion } from '@/lib/documents/version-repository'
import { findConversationInOrg } from './repository'
import { readConversationDraft } from './draft-preview'

/** Mirrors the agent tier's `MAX_REF_CHARS` (`tools/documents/register.py`). */
export const MAX_FILING_REF_CHARS = 200

/** The longest title a filing accepts — the lifecycle's own `title` ceiling. */
export const MAX_FILING_TITLE_CHARS = 200

/**
 * The short stable name inside the idempotency reference, from the file name.
 *
 * A MIRROR of the agent tier's `_slug` (`tools/documents/register.py`), kept
 * identical on purpose rather than improved: the whole point is that a browser
 * press and an agent turn compute the same string for one path, so the second
 * of the two finds the first's row. `draft-filing.spec.ts` pins the parity
 * vectors — change either side and it fails here first.
 */
function filingSlug(path: string): string {
  const name = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path
  const stem = name.replace(/\.md$/i, '')
  const slug = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'entwurf'
}

/**
 * The working-directory path the preview door and the filing key both use.
 * Leading slashes and surrounding whitespace are not identity.
 */
export function normalizeDraftPath(path: string): string {
  return path.trim().replace(/^\/+/, '')
}

function filingHash(conversationId: string, path: string): string {
  return createHash('sha256').update(`${conversationId}\0${path}`).digest('hex').slice(0, 8)
}

/**
 * The BFF's idempotency key: `{conversationId}-{slug}`, bounded.
 *
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

/** The file name when the card carried no title — never empty, never a path. */
function fallbackTitle(path: string): string {
  const name = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path
  return name.trim() || 'Entwurf'
}

export interface FileConversationDraftInput {
  /** Working-directory path as the card carries it (`/entwuerfe/….md`). */
  path: string
  /** The card's title (first heading, or the file name); the path when absent. */
  title?: string
  /** Set after the card showed the same-name 409 and the reader confirmed. */
  force?: boolean
}

export interface FiledConversationDraft {
  documentId: string
  versionId: string
  state: DocumentVersionState
  /** True when the reference was already filed and nothing was created. */
  alreadyFiled: boolean
}

/**
 * File one draft of one conversation into that conversation's project.
 *
 * The gates, in order: the conversation's own `viewer` grant (a denial is a
 * 404, so a refused id reads as an absent one), the conversation's project
 * (a project-less chat has no shelf — 422, not a filing), the draft's bytes
 * from the agent tier, the idempotency reference, the same-name veto, and
 * only then the create through `fileAgentDocumentDraft`.
 */
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

  // The bytes, through the same read door the preview uses: the conversation
  // gate above plus the internal service token below, never the browser.
  const path = normalizeDraftPath(input.path)
  const draft = await readConversationDraft(session, conversationId, path)

  const title = (input.title ?? '').trim() || fallbackTitle(path)
  if (title.length > MAX_FILING_TITLE_CHARS) {
    throw new BadRequestError('Title is too long')
  }
  const ref = filingReference(conversationId, path)

  // Idempotency first: the agent may have filed this reference already (or the
  // reader pressed twice). An open draft comes back as-is; a reference whose
  // version has left the writing states is a conflict the Files pane owns —
  // replacing `in_review` bytes from here would take them off a reviewer's desk.
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

  // Same-name veto, before anything is created. Scans the complete active
  // project scope rather than the Files list cap of 500.
  if (!input.force) {
    const clash = await findActiveProjectDocumentByShownName(
      projectId,
      session.organizationId,
      title,
    )
    if (clash) {
      throw new ConflictError('A document with this title is already in the project', {
        reason: 'same-name',
        documentId: clash.id,
        displayName: documentDisplayName(clash),
      })
    }
  }

  // The one create this surface may run. `actingHuman` is left at its default:
  // the internal agent route passes `false` for its machine caller, while this
  // caller's session IS the person who pressed. `originConversationId` ties a
  // later review decision back to this thread.
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
