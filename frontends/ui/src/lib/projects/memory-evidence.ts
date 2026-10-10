/**
 * The file names a memory item cites as its evidence, as a reader may be shown
 * them NOW (ADR-0096).
 *
 * A source-grounded decision stores the file names and pages it was read from
 * (`project_memory.evidence`, migration 0127): a snapshot of where the closing
 * extraction read, when every member could open those files. A document moved
 * into a restricted folder since, put in the Papierkorb, archived or held by
 * the upload screen is no longer open, and its NAME is restricted information
 * too (ADR-0087: the audit trail and the download log withhold it). So every
 * read of memory evidence passes here, and a name is shown only while a
 * document of that name in the item's project is served to this reader:
 * filed where their clearance is served from (`liveFolderAccess`, the
 * document's live folder; the Papierkorb is never served), visible to their
 * document reader (`SCREENED_ONLY` for the agent), and active.
 *
 * Only the names go. The decision stays: its content was read while the file
 * was open to every member, and the item's own access (`memoryVisibleTo`) is
 * what decides who reads it.
 */

import 'server-only'
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { documents } from '@/lib/db/schema'
import { documentVisibleTo, type DocumentReader } from '@/lib/documents/visibility'
import { liveFolderAccess } from '@/lib/permits/live-access'
import { servedFrom } from '@/lib/permits/repository'

/** One document a memory item was read from: its file name and page, never its text. */
export interface MemoryEvidence {
  fileName: string
  page: string | null
}

/** Anything carrying memory evidence, with the project its files belong to. */
export interface WithEvidence {
  projectId: string | null
  evidence: MemoryEvidence[] | null
}

/** Who is reading: their document reader, and the restricted folders they are cleared for in a project. */
export interface EvidenceReader {
  reader: DocumentReader
  clearanceIn(projectId: string): readonly string[]
}

/** The names of `fileNames` in `projectId` this reader is served now. */
async function servedNames(
  organizationId: string,
  projectId: string,
  fileNames: readonly string[],
  reader: EvidenceReader
): Promise<Set<string>> {
  const access = await liveFolderAccess(organizationId, projectId, reader.clearanceIn(projectId))
  const rows = await getDb()
    .selectDistinct({ fileName: documents.filename })
    .from(documents)
    .where(
      and(
        eq(documents.organizationId, organizationId),
        eq(documents.projectId, projectId),
        inArray(documents.filename, [...fileNames]),
        documentVisibleTo(reader.reader),
        eq(documents.lifecycle, 'active'),
        servedFrom(access.visibleFolderIds)
      )
    )
  return new Set(rows.map((row) => row.fileName))
}

/**
 * The items with only the evidence this reader may be shown now, in order. An
 * item keeps its place and its content when every name goes; one without
 * evidence passes through untouched and costs no query.
 */
export async function withServedEvidence<Item extends WithEvidence>(
  organizationId: string,
  items: readonly Item[],
  reader: EvidenceReader
): Promise<Item[]> {
  const namesByProject = new Map<string, Set<string>>()
  for (const item of items) {
    if (!item.projectId || !item.evidence || item.evidence.length === 0) continue
    const names = namesByProject.get(item.projectId) ?? new Set<string>()
    for (const entry of item.evidence) names.add(entry.fileName)
    namesByProject.set(item.projectId, names)
  }
  if (namesByProject.size === 0) return [...items]
  const served = new Map(
    await Promise.all(
      [...namesByProject].map(
        async ([projectId, names]) => [projectId, await servedNames(organizationId, projectId, [...names], reader)] as const
      )
    )
  )
  return items.map((item) => {
    if (!item.projectId || !item.evidence || item.evidence.length === 0) return item
    const open = served.get(item.projectId)
    return { ...item, evidence: item.evidence.filter((entry) => open?.has(entry.fileName) ?? false) }
  })
}
