/**
 * What an upload summary says, computed: the headline counts, the files by
 * folder, the document types, whether it is still moving, and where each
 * thing links. Pure, so the dialog, the preview route and the specs agree.
 */

import type { UploadHistoryEntry, UploadSummary, UploadSummaryDocument } from '@/adapters/api/upload-batches-client'
import { documentFilesHref } from '@/features/documents/lib/document-question'
import { documentTypeOf } from '@/lib/documents/tag-vocabulary'

/** Every count the summary can headline, in reading order. */
export const TALLY_KEYS = ['ready', 'reading', 'quarantined', 'failed', 'stored', 'unchanged', 'excluded'] as const
export type TallyKey = (typeof TALLY_KEYS)[number]
export type UploadTally = Record<TallyKey, number>

/**
 * The headline counts. `failed` adds the uploads that never arrived (the
 * batch's `failedCount`) to the documents whose reading failed: both are files
 * the person sent that Piloti cannot use.
 */
export function tallySummary(summary: UploadSummary): UploadTally {
  const tally: UploadTally = {
    ready: 0,
    reading: 0,
    quarantined: 0,
    failed: summary.failedCount,
    stored: 0,
    unchanged: summary.unchangedCount,
    excluded: summary.excluded.reduce((sum, entry) => sum + entry.count, 0),
  }
  for (const document of summary.documents) tally[document.outcome] += 1
  return tally
}

/** The same counts for one history row, which carries totals instead of documents. */
export function tallyHistoryEntry(entry: UploadHistoryEntry): UploadTally {
  return {
    ...entry.counts,
    failed: entry.counts.failed + entry.failedCount,
    unchanged: entry.unchangedCount,
    excluded: entry.excludedCount,
  }
}

/** The non-zero counts, in reading order. „Zitierbar" stays even at zero: it is the number people look for. */
export function visibleTally(tally: UploadTally): Array<{ key: TallyKey; count: number }> {
  return TALLY_KEYS.filter((key) => key === 'ready' || tally[key] > 0).map((key) => ({ key, count: tally[key] }))
}

export interface FolderGroup {
  /** `null` is the shelf's root. */
  path: string | null
  documents: UploadSummaryDocument[]
}

/** Files grouped by folder: the root first, then folders by path, files by name inside each. */
export function groupByFolder(documents: readonly UploadSummaryDocument[]): FolderGroup[] {
  const groups = new Map<string | null, UploadSummaryDocument[]>()
  for (const document of documents) {
    const path = document.folderPath?.trim() || null
    const group = groups.get(path) ?? []
    group.push(document)
    groups.set(path, group)
  }
  const byName = (a: UploadSummaryDocument, b: UploadSummaryDocument) =>
    displayNameOf(a).localeCompare(displayNameOf(b), 'de')
  return [...groups.entries()]
    .map(([path, docs]) => ({ path, documents: [...docs].sort(byName) }))
    .sort((a, b) => (a.path === null ? -1 : b.path === null ? 1 : a.path.localeCompare(b.path, 'de')))
}

/** A folder path as the reader sees it: segments separated by a spaced slash. */
export function formatFolderPath(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .join(' / ')
}

export function displayNameOf(document: Pick<UploadSummaryDocument, 'displayName' | 'filename'>): string {
  return document.displayName?.trim() || document.filename
}

/** How many files of each detected document type, most first. Files with no detected type are left out. */
export function documentTypeCounts(documents: readonly UploadSummaryDocument[]): Array<{ type: string; count: number }> {
  const counts = new Map<string, number>()
  for (const document of documents) {
    const type = documentTypeOf(document.tags)
    if (type) counts.set(type, (counts.get(type) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type, 'de'))
}

/** The tags after the document type, in their stored order. */
export function otherTags(tags: readonly string[]): string[] {
  const type = documentTypeOf(tags)
  return tags.filter((tag) => tag !== type)
}

/**
 * Whether the summary will still change on its own, and is worth asking again.
 * A completed batch is final; an open one is only worth polling while a file
 * of it is being read.
 */
export function isSettling(summary: UploadSummary): boolean {
  return summary.completedAt === null && summary.documents.some((document) => document.outcome === 'reading')
}

/** Where the person reads one file: the project's Files view or the Archiv, opened on it. A chat has no per-file view. */
export function documentHref(summary: Pick<UploadSummary, 'scope' | 'projectId'>, documentId: string): string | null {
  if (summary.scope === 'archiv') return `/app/archiv?doc=${encodeURIComponent(documentId)}`
  return summary.scope === 'project' && summary.projectId ? documentFilesHref(summary.projectId, documentId) : null
}

/** Where the upload went, as a link. */
export function placeHref(summary: Pick<UploadSummary, 'scope' | 'projectId' | 'conversationId'>): string | null {
  if (summary.scope === 'archiv') return '/app/archiv'
  if (summary.scope === 'session') {
    return summary.conversationId ? `/app/chat?session=${encodeURIComponent(summary.conversationId)}` : null
  }
  return summary.projectId ? `/app/projects/${encodeURIComponent(summary.projectId)}/files` : null
}
