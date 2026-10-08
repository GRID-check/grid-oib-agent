/**
 * „Ausmisten" at a project's close (ADR-0088): Piloti proposes which documents
 * the finished project no longer needs, the person closing it decides about
 * every one, and what they confirm goes to the Papierkorb (14 days,
 * restorable). Nothing is removed without that confirmation.
 *
 * ## The proposal
 *
 * Only among the documents the person may read AND write: a folder they may
 * not read does not exist for them, and one they may only read is not theirs to
 * clear out. Built from what the index already holds (name, folder path, type,
 * tags and the summary ingestion wrote, read from the index as every file
 * listing reads them, the editorial state), so nothing reaches a
 * model that ingestion did not already send. A document the content gate holds
 * in quarantine (ADR-0083) is left out altogether: it waits for a reviewer, not
 * for a clean-out. Only a document whose screening passed (`clean`, or
 * `released` by a reviewer) reaches the model; one screened partly, not at all
 * or not yet is proposed by the rules alone. Two sources, merged per document:
 * the rules in `./cleanup-rules.ts`, always; and the model behind
 * `POST /v1/cleanup-proposal`, when it answers. When it does not, the rules
 * alone are the proposal and the response says so (`aiError`).
 *
 * ## Into the Papierkorb, without widening anyone's access
 *
 * The Papierkorb holds folders (ADR-0085). For each folder the confirmed
 * documents are in (the project root counts as one), a subfolder „Ausgemistet
 * <date>" is made INSIDE it, the documents are moved there and the subfolder is
 * put in the Papierkorb. A subfolder that inherits its parent's access has
 * exactly the parent's readers and the parent's retrieval collection, so the
 * move widens nobody's access and re-ingests nothing; the bin then purges the
 * chunks, and a restore puts the subfolder back in its original folder.
 *
 * ## All or nothing
 *
 * The folder, move and bin services each own their transaction (the bin's
 * includes the backend's chunk purge), so one database transaction cannot hold
 * them. Everything is checked before anything changes; then every subfolder is
 * made and filled, then every one is binned. When a step fails, what was done
 * is undone in reverse: binned subfolders restored, documents moved back to
 * the folder they came from, the subfolders removed. The person is told it
 * failed, and the project is as it was.
 */

import 'server-only'
import { ApiError, BadRequestError, ConflictError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { recordAuditEvent } from '@/lib/audit/service'
import { DOCUMENT_WRITE_PERMISSIONS, getProjectFolderAccess, requireFolderWrite } from '@/lib/authz/folder-access'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getBackendUrl } from '@/lib/backend-proxy'
import { listProjectDocumentPage, type DocumentListRow } from '@/lib/documents/repository'
import { summarizeDocumentVersions } from '@/lib/documents/lifecycle'
import { reconcileDocumentStatuses } from '@/lib/documents/reconcile-status'
import { moveDocumentToFolder } from '@/lib/documents/move-to-folder'
import { FOLDER_NAME_TAKEN } from '@/lib/documents/shelf-folders'
import { moveFolderToBin, restoreFolderFromBin } from './folder-bin'
import { createProjectFolder, listProjectFolders } from './folder-service'
import { findProjectInOrg } from './repository'
import { deleteEmptyCreatedFolder } from './cleanup-repository'
import { hasPassedScreening, keepReadable, type ShelfReader } from '@/lib/documents/document-reader'
import { shelfReaderFor } from '@/lib/upload-screening/quarantine-reviewers'
import { CLEANUP_CATEGORIES, ruleCandidates, type CleanupCategory, type CleanupDocumentFacts } from './cleanup-rules'
import { CLEANUP_PARTIALLY_UNDONE_REASON, type CleanupProposal, type CleanupProposalItem } from './cleanup-types'

export type { CleanupProposal, CleanupProposalItem } from './cleanup-types'

/** Most documents one proposal considers. A project larger than this is proposed over its newest. */
export const CLEANUP_MAX_DOCUMENTS = 2000
const PROPOSAL_TIMEOUT_MS = 60_000
/** Longest summary sent to the model; the index already holds it, the model needs the gist. */
const SUMMARY_CHARS = 300

interface ModelCandidate {
  id: string
  category: string
  reason: string
}

async function listAllDocuments(
  projectId: string,
  organizationId: string,
  hiddenFolderIds: string[],
  reader: ShelfReader
): Promise<DocumentListRow[]> {
  const rows: DocumentListRow[] = []
  let page = await listProjectDocumentPage(projectId, organizationId, { hiddenFolderIds, reader })
  rows.push(...page.rows)
  while (page.nextCursor && rows.length < CLEANUP_MAX_DOCUMENTS) {
    page = await listProjectDocumentPage(projectId, organizationId, { hiddenFolderIds, reader, cursor: page.nextCursor })
    rows.push(...page.rows)
  }
  return rows.slice(0, CLEANUP_MAX_DOCUMENTS)
}

/** The documents the session may read and write, as facts: metadata the index already holds. */
async function writableFacts(session: AuthorizedSession, projectId: string): Promise<CleanupDocumentFacts[]> {
  const project = await findProjectInOrg(projectId, session.organizationId)
  if (!project) return []
  const [access, folders] = await Promise.all([
    getProjectFolderAccess(session, projectId, project.collectionName),
    listProjectFolders(projectId, session),
  ])
  const pathOf = new Map(folders.map((folder) => [folder.id, folder.path]))
  // The closer's own reader (ADR-0083): screened files, and the held ones they
  // uploaded or review. Only `screeningPassed` facts reach the model below.
  const reader = await shelfReaderFor(session, { scope: 'project', projectId })
  const rows = await listAllDocuments(projectId, session.organizationId, [...access.hiddenFolderIds], reader)
  const reconciled = await reconcileDocumentStatuses(
    rows.filter((row) => access.isVisible(row.folderId) && access.levelOf(row.folderId) === 'write'),
    session.organizationId
  )
  // Narrowed again after the reconcile, which can turn a row `quarantined`
  // (the verdict travels with the status). A quarantined file is not proposed
  // at all, to anyone: the reviewers decide about it, not a clean-out.
  const writable = keepReadable(reconciled, reader).filter(
    (row) => row.status !== 'quarantined' && row.screeningOutcome !== 'quarantined'
  )
  const versions = await summarizeDocumentVersions(
    session.organizationId,
    writable.map((row) => row.id)
  )
  return writable.map((row) => ({
    id: row.id,
    filename: row.displayName ?? row.filename,
    folderId: row.folderId,
    folderPath: row.folderId ? (pathOf.get(row.folderId) ?? null) : null,
    contentType: row.contentType ?? null,
    tags: row.tags ?? [],
    summary: row.summary ? row.summary.slice(0, SUMMARY_CHARS) : null,
    versionState: versions.get(row.id)?.state ?? null,
    authoredBy: row.authoredBy,
    contentHash: row.contentHash ?? null,
    createdAt: new Date(row.createdAt).toISOString(),
    // The one definition of "screened" (ADR-0083), the same that lets a file
    // reach every member and the retrieval index: what a reader may already ask
    // Piloti about may be named to the clean-out's model too.
    screeningPassed: hasPassedScreening(row),
  }))
}

/** The model's proposal, or the reason there is none. Never throws: the rules stand in. */
async function modelCandidates(
  session: AuthorizedSession,
  facts: readonly CleanupDocumentFacts[],
  locale: string
): Promise<{ candidates: ModelCandidate[]; error: string | null }> {
  if (facts.length === 0) return { candidates: [], error: null }
  try {
    const res = await fetch(`${getBackendUrl()}/v1/cleanup-proposal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-grid-organization-id': session.organizationId },
      body: JSON.stringify({
        locale,
        documents: facts.map((fact) => ({
          id: fact.id,
          filename: fact.filename,
          folder_path: fact.folderPath,
          content_type: fact.contentType,
          tags: fact.tags.slice(0, 50),
          summary: fact.summary,
          version_state: fact.versionState,
          authored_by: fact.authoredBy,
          uploaded_at: fact.createdAt.slice(0, 10),
        })),
      }),
      signal: AbortSignal.timeout(PROPOSAL_TIMEOUT_MS),
    })
    if (!res.ok) return { candidates: [], error: `backend_${res.status}` }
    const body = (await res.json()) as { candidates?: ModelCandidate[]; error?: string | null }
    if (body.error) return { candidates: [], error: body.error }
    return { candidates: Array.isArray(body.candidates) ? body.candidates : [], error: null }
  } catch {
    return { candidates: [], error: 'backend_unreachable' }
  }
}

const asCategory = (value: string): CleanupCategory =>
  (CLEANUP_CATEGORIES as readonly string[]).includes(value) ? (value as CleanupCategory) : 'other'

/**
 * Piloti's proposal of what to clear out of a project before it closes. Needs
 * document write on the project, so a closed project gets none: the proposal
 * belongs to closing it.
 */
export async function proposeCleanup(
  session: AuthorizedSession,
  projectId: string,
  locale: string
): Promise<CleanupProposal> {
  await requireProjectAccess(session, projectId, DOCUMENT_WRITE_PERMISSIONS)
  const facts = await writableFacts(session, projectId)
  const byId = new Map(facts.map((fact) => [fact.id, fact]))
  const rules = new Map(ruleCandidates(facts).map((candidate) => [candidate.id, candidate]))
  const model = await modelCandidates(
    session,
    facts.filter((fact) => fact.screeningPassed),
    locale
  )
  // Only ids the reader may write: the backend already drops invented ones, and
  // this is the side that decided who may write what.
  const fromModel = new Map(model.candidates.filter((candidate) => byId.has(candidate.id)).map((candidate) => [candidate.id, candidate]))

  const ids = [...new Set([...rules.keys(), ...fromModel.keys()])]
  const items = ids.map((id): CleanupProposalItem => {
    const fact = byId.get(id) as CleanupDocumentFacts
    const rule = rules.get(id) ?? null
    const ai = fromModel.get(id) ?? null
    return {
      documentId: id,
      filename: fact.filename,
      folderPath: fact.folderPath,
      category: rule?.category ?? asCategory(ai?.category ?? 'other'),
      aiReason: ai ? ai.reason.slice(0, 300) : null,
      rule: rule?.rule ?? null,
    }
  })
  items.sort((a, b) => (a.folderPath ?? '').localeCompare(b.folderPath ?? '') || a.filename.localeCompare(b.filename))
  return { items, considered: facts.length, aiUsed: model.error === null, aiError: model.error }
}

export interface ConfirmCleanupInput {
  /** What the person decided to remove. */
  documentIds: readonly string[]
  /** What the proposal offered: the audit trail records where the person went against it. */
  proposedIds: readonly string[]
  /** Whether the model's proposal was shown. */
  aiUsed: boolean
}

export interface ConfirmCleanupResult {
  /** Documents now in the Papierkorb. */
  removed: number
  /** Papierkorb entries made: one per folder the documents were in. */
  binEntries: number
}

/** „Ausgemistet 2026-10-07", or with a counter when the folder already has one of that name. */
async function makeCleanupFolder(session: AuthorizedSession, projectId: string, parentId: string | null, day: string) {
  for (let attempt = 1; attempt <= 20; attempt++) {
    const name = attempt === 1 ? `Ausgemistet ${day}` : `Ausgemistet ${day} (${attempt})`
    const created = await createProjectFolder({ projectId, parentId, name }, session)
    if (created.ok) return { folder: created.folder, name }
    if (created.error !== FOLDER_NAME_TAKEN) throw new BadRequestError(created.error)
  }
  throw new ConflictError('Could not name the Ausmisten folder.')
}


/** What a clean-out has done so far, so a failure can undo exactly that. */
interface CleanOutDone {
  holders: Array<{ id: string; name: string; sourceFolderId: string | null; documentIds: string[] }>
  moved: Array<{ documentId: string; sourceFolderId: string | null }>
  binned: string[]
}

/**
 * Make a subfolder in every source folder, file the chosen documents into it,
 * then bin every subfolder. When any step fails, undo what was done and
 * rethrow: the project is as it was.
 */
async function clearOutAllOrNothing(
  session: AuthorizedSession,
  projectId: string,
  byFolder: ReadonlyMap<string | null, readonly string[]>,
  request?: Request
): Promise<void> {
  const day = new Date().toISOString().slice(0, 10)
  const done: CleanOutDone = { holders: [], moved: [], binned: [] }
  try {
    for (const [sourceFolderId, documentIds] of byFolder) {
      const { folder, name } = await makeCleanupFolder(session, projectId, sourceFolderId, day)
      const holder = { id: folder.id, name, sourceFolderId, documentIds: [] as string[] }
      done.holders.push(holder)
      for (const documentId of documentIds) {
        const moved = await moveDocumentToFolder({ documentId, folderId: holder.id }, session)
        if (!moved.ok) throw new BadRequestError(moved.error)
        done.moved.push({ documentId, sourceFolderId })
        holder.documentIds.push(documentId)
      }
    }
    // Each subfolder goes to the bin only holding exactly what was moved into
    // it: a file someone else filed there meanwhile is never binned with it.
    for (const holder of done.holders) {
      await moveFolderToBin(session, { projectId, folderId: holder.id }, request, { onlyDocuments: holder.documentIds })
      done.binned.push(holder.id)
    }
  } catch (error) {
    const failed = await undoCleanOut(session, projectId, done, request)
    if (failed.length === 0) throw error
    throw partiallyUndoneError(error, done)
  }
}

/**
 * The error a person sees when the undo itself stopped short: the clean-out
 * failed, and some files may still sit in a subfolder „Ausgemistet <date>" of
 * their folder or in the Papierkorb. Keeps the original status.
 */
function partiallyUndoneError(cause: unknown, done: CleanOutDone): ApiError {
  const status = cause instanceof ApiError ? cause.status : 500
  const names = [...new Set(done.holders.map((holder) => holder.name))]
  return new ApiError(
    status,
    'CLEANUP_PARTIALLY_UNDONE',
    `Clearing out failed and could not be fully undone. Some files may still be in a folder ${names.map((name) => `"${name}"`).join(', ')} inside their folder, or in the Papierkorb. Check there, then try again.`,
    { reason: CLEANUP_PARTIALLY_UNDONE_REASON, folders: names }
  )
}

/**
 * Undo a clean-out that failed halfway, in reverse. Best effort per step: one
 * that fails is logged and the rest still run, so as much as possible is back.
 * Returns the steps that failed, each already logged.
 */
async function undoCleanOut(session: AuthorizedSession, projectId: string, done: CleanOutDone, request?: Request): Promise<string[]> {
  const failed: string[] = []
  const attempt = async (what: string, step: () => Promise<unknown>): Promise<void> => {
    try {
      await step()
    } catch (error) {
      failed.push(what)
      console.error(`[cleanup] undoing a failed clean-out in project ${projectId}: ${what} failed`, error)
    }
  }
  for (const folderId of [...done.binned].reverse()) {
    await attempt(`restore ${folderId}`, () => restoreFolderFromBin(session, { projectId, folderId }, request))
  }
  for (const { documentId, sourceFolderId } of [...done.moved].reverse()) {
    await attempt(`move ${documentId} back`, async () => {
      const back = await moveDocumentToFolder({ documentId, folderId: sourceFolderId }, session)
      if (!back.ok) throw new Error(back.error)
    })
  }
  for (const holder of [...done.holders].reverse()) {
    await attempt(`remove ${holder.id}`, async () => {
      // Not removed: something still lies in it (a move back failed, or a file someone else filed there).
      if (!(await deleteEmptyCreatedFolder(session.organizationId, projectId, holder.id))) throw new Error('not empty')
    })
  }
  return failed
}

/**
 * Put what the person confirmed into the Papierkorb (see the module header for
 * why through a subfolder of each document's own folder). Every document is
 * checked again: in this project, readable and writable by the session. All or
 * nothing (module header). Audited as `project.cleanup.confirmed`, with how
 * far the decision followed the proposal; a clean-out that was undone is not.
 */
export async function confirmCleanup(
  session: AuthorizedSession,
  projectId: string,
  input: ConfirmCleanupInput,
  request?: Request
): Promise<ConfirmCleanupResult> {
  await requireProjectAccess(session, projectId, DOCUMENT_WRITE_PERMISSIONS)
  const chosen = [...new Set(input.documentIds)]
  if (chosen.length === 0) return { removed: 0, binEntries: 0 }
  if (chosen.length > CLEANUP_MAX_DOCUMENTS) throw new BadRequestError('Too many documents.')

  const facts = await writableFacts(session, projectId)
  const writable = new Map(facts.map((fact) => [fact.id, fact]))
  const unknown = chosen.filter((id) => !writable.has(id))
  if (unknown.length > 0) {
    throw new BadRequestError('Some documents cannot be removed by you.', { reason: 'not-writable', documentIds: unknown })
  }

  const byFolder = new Map<string | null, string[]>()
  for (const id of chosen) {
    const folderId = (writable.get(id) as CleanupDocumentFacts).folderId
    byFolder.set(folderId, [...(byFolder.get(folderId) ?? []), id])
  }
  // Write on every source folder, asked once more right before anything moves.
  await requireFolderWrite(session, projectId, [...byFolder.keys()])

  await clearOutAllOrNothing(session, projectId, byFolder, request)

  const proposed = new Set(input.proposedIds)
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'project.cleanup.confirmed',
    targetType: 'project',
    targetId: projectId,
    metadata: {
      removed: chosen.length,
      proposed: proposed.size,
      // Where the person went against the proposal, both ways.
      removedUnproposed: chosen.filter((id) => !proposed.has(id)).length,
      keptProposed: [...proposed].filter((id) => !chosen.includes(id)).length,
      aiUsed: input.aiUsed,
      documentIds: chosen.join(','),
    },
    request,
  })
  return { removed: chosen.length, binEntries: byFolder.size }
}
