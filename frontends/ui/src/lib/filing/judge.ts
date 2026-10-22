/**
 * The filing judgement: one bounded model call per upload batch, through the
 * backend's `POST /v1/filing-fit`, where the platform's model routing and the
 * Langfuse generation live (ADR-0089). This tier has no LLM client of its own.
 *
 * The request carries metadata the caller already decided the uploader and
 * every reader of the folder may see; the answer is checked here again,
 * whatever the route already checked: a document or a folder the request did
 * not name is dropped, and so is a move into the folder a document is in. A
 * failure of any kind is no judgement, and nothing is proposed.
 *
 * A held mail (`basis: mail`, {@link judgeMailFiling}) is the same call with a
 * different input: its attachments' names, its masked subject, its sender's
 * domain, the folders every member reads and the office's conventions; never
 * its text, never its bytes (ADR-0134, D21). Its answer is a placement per
 * part with a Dokumentart, which the suggest job stores for the person.
 */

import 'server-only'
import { getBackendUrl } from '@/lib/backend-proxy'
import { DOCUMENT_TYPE_TAGS, type DocumentTypeTag } from '@/lib/documents/tag-vocabulary'
import { folderPathKey } from '@/lib/projects/folders'
import {
  filingFitResponseSchema,
  type FilingConventionInput,
  type FilingFolderInput,
  type FilingJudgement,
  type FilingJudgementInput,
  type FilingMove,
  type MailFilingInput,
  type MailFilingJudgement,
  type MailPlacement,
} from './types'

/** The name basis runs while a person looks at the upload; the content basis and a held mail are background. */
const TIMEOUT_MS = { name: 30_000, content: 60_000, mail: 60_000 } as const
/** A sort is a person waiting on a chunk that also asks the decision model per document. */
const SORT_TIMEOUT_MS = 90_000

type RawMove = {
  id: string
  folder: string
  reason: string
  new?: boolean
  description?: string | null
  confidence?: number | null
  type?: string | null
}

const MAX_REASON = 300

/** A reason as a person reads it: one line, at most {@link MAX_REASON} characters; empty is none. */
const cleanReason = (reason: string): string => reason.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON)

/**
 * The moves of a parsed answer that the input grounds, one per document, in
 * the input's own spelling of the folder. Pure, so the rule is specced without
 * a backend.
 */
export function keepKnownMoves(moves: readonly RawMove[], input: FilingJudgementInput): FilingMove[] {
  const documents = new Map(input.documents.map((document) => [document.id, document]))
  const existing = new Map(input.folders.map((folder) => [folderPathKey(folder.path), folder]))
  const conventions = new Map(input.conventions.map((convention) => [folderPathKey(convention.path), convention]))
  const kept: FilingMove[] = []
  const seen = new Set<string>()
  for (const move of moves) {
    const document = documents.get(move.id)
    const key = folderPathKey(move.folder)
    const reason = cleanReason(move.reason)
    if (!document || seen.has(document.id) || !key || !reason) continue
    if (key === folderPathKey(document.folder)) continue
    const folder = existing.get(key)
    const convention = folder ? undefined : conventions.get(key)
    if (!folder && !convention) continue
    seen.add(document.id)
    kept.push({
      documentId: document.id,
      folder: folder?.path ?? convention?.path ?? move.folder,
      reason,
      newFolder: convention ? { description: convention.description } : null,
      confidence: move.confidence ?? null,
    })
  }
  return kept
}

const folderBody = (folder: FilingFolderInput) => ({
  path: folder.path,
  description: folder.description,
  doc_types: folder.docTypes,
})

const conventionBody = (convention: FilingConventionInput) => ({
  path: convention.path,
  description: convention.description,
  projects: convention.projects,
  doc_types: convention.docTypes,
})

/** The request body the route reads (snake_case, its pydantic model). */
export function filingFitBody(input: FilingJudgementInput): object {
  return {
    basis: input.basis,
    purpose: input.purpose ?? 'upload',
    locale: input.locale,
    folders: input.folders.map(folderBody),
    conventions: input.conventions.map(conventionBody),
    documents: input.documents.map((document) => ({
      id: document.id,
      file: document.file,
      folder: document.folder,
      type: document.type,
      tags: document.tags,
      summary: document.summary,
    })),
    trace: { batch_id: input.trace.batchId, project_id: input.trace.projectId, shelf: input.trace.shelf },
  }
}

/** What one call of the route answered, before the caller's own check. */
interface Answered {
  moves: RawMove[]
  traceId: string | null
  error: string | null
}

/** One call of `POST /v1/filing-fit`. Never throws: a failure is `error` and no moves. */
async function askFilingFit(organizationId: string, body: object, timeoutMs: number): Promise<Answered> {
  try {
    const response = await fetch(`${getBackendUrl()}/v1/filing-fit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-grid-organization-id': organizationId },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return { moves: [], traceId: null, error: `backend_${response.status}` }
    const parsed = filingFitResponseSchema.safeParse(await response.json())
    if (!parsed.success) return { moves: [], traceId: null, error: 'response_malformed' }
    const { moves, error, trace_id: traceId } = parsed.data
    if (error) return { moves: [], traceId: traceId ?? null, error }
    return { moves, traceId: traceId ?? null, error: null }
  } catch {
    return { moves: [], traceId: null, error: 'backend_unreachable' }
  }
}

/** Ask the model once for the batch. Never throws: a failure is `error` and no moves. */
export async function judgeFiling(organizationId: string, input: FilingJudgementInput): Promise<FilingJudgement> {
  if (input.documents.length === 0 || (input.folders.length === 0 && input.conventions.length === 0)) {
    return { moves: [], traceId: null, error: null }
  }
  const timeoutMs = input.purpose === 'sort' ? SORT_TIMEOUT_MS : TIMEOUT_MS[input.basis]
  const answered = await askFilingFit(organizationId, filingFitBody(input), timeoutMs)
  if (answered.error) return { moves: [], traceId: answered.traceId, error: answered.error }
  return { moves: keepKnownMoves(answered.moves, input), traceId: answered.traceId, error: null }
}

// ── A held mail ─────────────────────────────────────────────────────────────

/**
 * The request body of a mail (`basis: mail`). Each attachment is a document
 * with its id and name and nothing else: in no folder, with no type, tags or
 * summary, which the route refuses on this basis. The mail's id is the trace's
 * batch.
 */
export function mailFilingBody(input: MailFilingInput): object {
  return {
    basis: 'mail',
    purpose: 'upload',
    locale: input.locale,
    folders: input.folders.map(folderBody),
    conventions: input.conventions.map(conventionBody),
    documents: input.attachments.map((attachment) => ({ id: attachment.id, file: attachment.file })),
    mail: { subject: input.mail.subject, sender_domain: input.mail.senderDomain, text_id: input.mail.textId },
    trace: { batch_id: input.trace.mailId, project_id: input.trace.projectId, shelf: 'project' },
  }
}

const isDocumentType = (value: unknown): value is DocumentTypeTag =>
  typeof value === 'string' && (DOCUMENT_TYPE_TAGS as readonly string[]).includes(value)

/**
 * The placements of a parsed answer that the input grounds, one per part, in
 * the input's own spelling of the folder: a part the input named, a folder of
 * FOLDERS or CONVENTIONS, a reason. A Dokumentart outside the vocabulary is
 * dropped and the placement kept; the text never carries one (it is filed as
 * correspondence). Pure, like {@link keepKnownMoves}.
 */
export function keepMailPlacements(moves: readonly RawMove[], input: MailFilingInput): MailPlacement[] {
  const parts = new Set(input.attachments.map((attachment) => attachment.id))
  if (input.mail.textId) parts.add(input.mail.textId)
  const existing = new Map(input.folders.map((folder) => [folderPathKey(folder.path), folder]))
  const conventions = new Map(input.conventions.map((convention) => [folderPathKey(convention.path), convention]))
  const kept: MailPlacement[] = []
  const seen = new Set<string>()
  for (const move of moves) {
    const key = folderPathKey(move.folder)
    const reason = cleanReason(move.reason)
    if (!parts.has(move.id) || seen.has(move.id) || !key || !reason) continue
    const folder = existing.get(key)
    const convention = folder ? undefined : conventions.get(key)
    if (!folder && !convention) continue
    seen.add(move.id)
    kept.push({
      partId: move.id,
      folder: folder?.path ?? convention?.path ?? move.folder,
      newFolder: convention ? { description: convention.description } : null,
      documentType: move.id !== input.mail.textId && isDocumentType(move.type) ? move.type : null,
      reason,
    })
  }
  return kept
}

/**
 * Ask the model once where a held mail's parts belong. Never throws: a failure
 * is `error` and no placements. No call when there is nothing to place or
 * nowhere to place it.
 */
export async function judgeMailFiling(organizationId: string, input: MailFilingInput): Promise<MailFilingJudgement> {
  const nothingToPlace = input.attachments.length === 0 && !input.mail.textId
  if (nothingToPlace || (input.folders.length === 0 && input.conventions.length === 0)) {
    return { placements: [], traceId: null, error: null }
  }
  const answered = await askFilingFit(organizationId, mailFilingBody(input), TIMEOUT_MS.mail)
  if (answered.error) return { placements: [], traceId: answered.traceId, error: answered.error }
  return { placements: keepMailPlacements(answered.moves, input), traceId: answered.traceId, error: null }
}
