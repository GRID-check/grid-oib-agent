/**
 * The agent's `documents_unreadable:` block — files of the project that exist
 * and that Piloti could not read.
 *
 * ## Why the agent needs it
 *
 * Everything the agent knows about a project's files is built from the rows a
 * SUCCESSFUL read writes (the per-turn inventory, `list_files`, retrieval). A
 * file whose read failed has no such row, so to the agent it did not exist: an
 * answer called it missing, and the planner who had uploaded it was told to
 * upload it (feld72, Jour fixe 2026-10-09). The folder brief shows people the
 * failure; this tells the agent the same fact, so it can say "the file is
 * there, I could not read it, it can be read again in Dateien".
 *
 * Only files a model may name are listed: screened (ADR-0086) and outside every
 * restricted folder (ADR-0087). A failed read that never reached the content
 * screen is held like any unscreened upload, and is NOT listed — the prompt
 * tells the agent that absence from its lists is not proof a file is absent.
 *
 * Not cached with the rest of the project view: a re-read changes this list
 * without anything that invalidates the view, and the next turn should know.
 */

import 'server-only'
import { getRestrictedFolderIds } from '@/lib/authz/folder-access'
import { findFolderPathsInProject, listUnreadableProjectDocuments } from '@/lib/documents/repository'

/** Lines the block names before it says how many more there are. */
export const MAX_UNREADABLE_LINES = 20

export interface UnreadableDocument {
  filename: string
  displayName: string | null
  folderPath: string | null
}

/**
 * Render the block, or an empty string when nothing is unreadable. Bounded,
 * and says so when it is: a shortened list must not read as the whole.
 */
export function buildUnreadableDocumentsSection(rows: readonly UnreadableDocument[], more = false): string {
  if (rows.length === 0) return ''
  const lines = rows.slice(0, MAX_UNREADABLE_LINES).map((row) => {
    const name = row.displayName?.trim() ? `${row.displayName.trim()} (${row.filename})` : row.filename
    return `- ${name}${row.folderPath ? ` (Ordner: ${row.folderPath})` : ''}`
  })
  if (more || rows.length > MAX_UNREADABLE_LINES) lines.push('- (weitere nicht lesbare Dateien nicht aufgeführt)')
  return ['documents_unreadable:', ...lines].join('\n')
}

/** Fail-open: project context is an enrichment, and this must never break the turn. */
export async function loadUnreadableDocumentsSection(
  projectId: string,
  organizationId: string | null | undefined
): Promise<string> {
  if (!organizationId) return ''
  try {
    const hidden = await getRestrictedFolderIds(organizationId, projectId)
    const rows = await listUnreadableProjectDocuments(projectId, organizationId, hidden, MAX_UNREADABLE_LINES + 1)
    const folderIds = [...new Set(rows.map((row) => row.folderId).filter((id): id is string => id !== null))]
    const paths = await findFolderPathsInProject(folderIds, projectId, organizationId)
    return buildUnreadableDocumentsSection(
      rows.slice(0, MAX_UNREADABLE_LINES).map((row) => ({
        filename: row.filename,
        displayName: row.displayName,
        folderPath: row.folderId ? (paths.get(row.folderId) ?? null) : null,
      })),
      rows.length > MAX_UNREADABLE_LINES
    )
  } catch {
    return ''
  }
}
