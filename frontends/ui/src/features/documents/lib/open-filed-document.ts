'use client'

/**
 * A file Piloti just wrote, opened BESIDE the conversation instead of instead
 * of it.
 *
 * ## The shape this replaces
 *
 * Both filing surfaces — the deep-research banner's „Im Projekt öffnen" and the
 * diagram fence's — were links to `/files?doc=…`. A reader commissions a
 * twenty-minute run, the report lands, and the product's answer is "go
 * somewhere else to look at it": the thread scrolls away, the composer subject
 * goes with it, and coming back is the browser's Back button. The pane that
 * fixes this already exists and is already the pattern here — `FilePreviewHost`
 * renders the file as a second pane in a Resizable split on chat, "the file you
 * are asking about, not an overlay covering the conversation" — and
 * `openFilePeek` is already how citations put a document into it. So this adds
 * no viewer, no second document shape and no second URL: it routes two more
 * callers into the one that exists.
 *
 * ## Offered, never automatic
 *
 * `useCitationPeek` opens the pane by itself, and the temptation is to read
 * that as precedent. It is not the same act. A citation peek opens the document
 * the reader is at that moment READING ABOUT, in the same second the answer
 * arrives. A filed artifact lands when a run finishes, which for deep research
 * is minutes later and quite possibly three questions further down the thread —
 * so an automatic pane would push a conversation aside for something the reader
 * has stopped doing. Two further facts settle it:
 *
 *   - the peek is SUPPRESSED while the research panel is open, on mobile, and
 *     off the chat route (`FilePreviewHost`), which is exactly where a reader
 *     watching a deep-research run is standing. An automatic open would
 *     silently do nothing precisely when it fired, and a no-op that reports
 *     success is worse than no affordance;
 *   - the design language's whole first principle is restraint. A compliance
 *     tool that rearranges the screen without being asked has spent the
 *     reader's attention on its own behalf.
 *
 * So the artifact is OFFERED, and what changed is the price of accepting: the
 * document now appears next to the conversation instead of replacing it.
 *
 * ## No composer subject
 *
 * `openFilePeek` binds `composerSubject` by default — "the next question is
 * about this file" — and that is wrong here in a way that matters. An
 * agent-authored file is `stored`: deliberately never dispatched to
 * `/v1/ingest`, never indexed, and `isNeverIndexedStatus` is what greys out Ask
 * on its own preview. Binding it as the retrieval subject would promise a
 * lookup the retrieval path cannot perform. So `bindComposerSubject: false`,
 * and the composer keeps saying whatever it already said.
 */

import type { DocumentAuthor } from '@/lib/db/schema'
import { useLayoutStore } from '@/features/layout/store'
import { fileItemFromStatus } from './document-question'
import { openFilePeek } from './open-file-peek'

interface DocumentStatusRow {
  id: string
  filename: string
  displayName: string | null
  fileSize: number | null
  contentType: string | null
  status: string | null
  createdAt: string
  errorMessage: string | null
  summary: string | null
  pageCount: number | null
  chunkCount: number | null
  contentTypes: string[] | null
  tags: string[] | null
  authoredBy: DocumentAuthor | null
}

export interface FiledDocumentTarget {
  documentId: string
  projectId: string
  projectName?: string | null
  canCollaborate?: boolean
}

/** Narrow the status payload without a cast — `any` is an error in this repo. */
function statusRow(body: unknown): DocumentStatusRow | null {
  if (typeof body !== 'object' || body === null) return null
  const row: Record<string, unknown> = { ...body }
  const text = (key: string): string | null => (typeof row[key] === 'string' ? row[key] : null)
  const count = (key: string): number | null => (typeof row[key] === 'number' ? row[key] : null)
  const list = (key: string): string[] | null => {
    const value = row[key]
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : null
  }
  const id = text('id')
  const filename = text('filename')
  if (!id || !filename) return null
  return {
    id,
    filename,
    displayName: text('displayName'),
    fileSize: count('fileSize'),
    contentType: text('contentType'),
    status: text('status'),
    createdAt: text('createdAt') ?? new Date().toISOString(),
    errorMessage: text('errorMessage'),
    summary: text('summary'),
    pageCount: count('pageCount'),
    chunkCount: count('chunkCount'),
    contentTypes: list('contentTypes'),
    tags: list('tags'),
    // Provenance, and the reason it is read here: the byline „Von Piloti
    // erstellt" is what tells a reader in the pane that the file beside their
    // conversation is one Piloti wrote. Without it the artifact opens looking
    // like any uploaded document.
    authoredBy: text('authoredBy') === 'agent' ? 'agent' : null,
  }
}

/**
 * Fetch the row and put it in the peek pane. `false` when the document could
 * not be read, so the caller can fall back to the Files route rather than
 * leaving a button that did nothing.
 *
 * The fetch is `/api/documents/{id}/status`, which is the SAME call the chat
 * route already makes to resolve `?doc=` into a peek, mapped by the same
 * `fileItemFromStatus`. There is no second document type here and there must
 * not be one: a parallel shape is a second thing that can disagree about what a
 * file is called or whether it is indexed.
 */
export async function openFiledDocument(target: FiledDocumentTarget): Promise<boolean> {
  let body: unknown = null
  try {
    const response = await fetch(`/api/documents/${encodeURIComponent(target.documentId)}/status`)
    if (!response.ok) return false
    body = await response.json()
  } catch (error) {
    console.debug('[documents] could not read the filed document', error)
    return false
  }
  const row = statusRow(body)
  if (!row) return false

  // The research panel occupies the same side of the split and `FilePreviewHost`
  // refuses to peek while it is open. The reader asked to see the file, so the
  // panel that was narrating the run they already finished watching steps aside.
  const layout = useLayoutStore.getState()
  if (layout.rightPanel === 'research') layout.closeRightPanel()

  const file = fileItemFromStatus(row)
  openFilePeek({
    file: row.authoredBy === 'agent' ? { ...file, authoredBy: 'agent' } : file,
    source: 'projekt',
    projectId: target.projectId,
    projectName: target.projectName,
    canCollaborate: target.canCollaborate,
    bindComposerSubject: false,
  })
  return true
}
