/**
 * The SQL that finds and changes what was DERIVED from a folder's documents:
 * the chat answers that drew on them, the memory notes drawn from the folder,
 * the reports filed from those conversations (ADR-0081, deletion pipeline).
 *
 * An answer "drew on" a document when its stored sources name it: a cited
 * source (`metadata.citations.sources`) or one read but not cited
 * (`metadata.readSources.sources`), by the document's id, or by its collection
 * and file name (`lib/conversations/agent-answer-metadata.ts`, the one stored
 * shape). A source that carries a file name but no collection is matched by
 * the name alone: over-matching marks an answer that did not need it, which
 * for a removal is the safe side.
 *
 * Every read is paged to the end: a removal that stops at a page boundary is
 * not a removal.
 */

import 'server-only'
import { and, eq, inArray, ne, or, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { executeRows } from '@/lib/db/execute-rows'
import { withTenant } from '@/lib/db/tenant-context'
import { documents, documentVersions, messages, projectMemory } from '@/lib/db/schema'

/**
 * What an answer keeps as its text when the purge of its source folder removes
 * what was derived from it („Mit dem Ordner entfernen"). The UI renders it in
 * the reader's language from `metadata.sourceRemoved`; this stored form is what
 * an export, a search or an older client sees.
 */
export const REMOVED_ANSWER_TEXT = 'Inhalt entfernt: Quelle gelöscht'

/** One document as an answer's sources may name it. */
export interface DocumentSourceRef {
  id: string
  collectionName: string
  filename: string
}

/** One answer that drew on a folder. */
export interface DerivedAnswer {
  messageId: string
  conversationId: string
}

const PAGE = 1_000

/** Between a collection and a file name in a match key: the unit separator, which neither holds. */
const REF_SEPARATOR = '\u001f'

/**
 * The assistant messages of the project's conversations that drew on any of
 * `docs`, or that an earlier pass already marked as drawn from `rootFolderId`
 * (so a retry after the documents are gone still finds them).
 */
export async function findAnswersDrawingOn(
  organizationId: string,
  projectId: string,
  docs: readonly DocumentSourceRef[],
  rootFolderId: string
): Promise<DerivedAnswer[]> {
  const db = getDb()
  const ids = docs.map((doc) => doc.id)
  const refs = docs.map((doc) => `${doc.collectionName}${REF_SEPARATOR}${doc.filename}`)
  const names = [...new Set(docs.map((doc) => doc.filename))]
  const found: DerivedAnswer[] = []
  let afterId = '00000000-0000-0000-0000-000000000000'
  for (;;) {
    const rows = executeRows<{ id: string; conversation_id: string }>(
      await withTenant({ organizationId }, () =>
        db.execute(sql`
          SELECT m.id, m.conversation_id
          FROM messages m
          JOIN conversations c ON c.id = m.conversation_id AND c.organization_id = m.organization_id
          WHERE m.organization_id = ${organizationId}
            AND c.project_id = ${projectId}::uuid
            AND m.role = 'assistant'
            AND m.metadata IS NOT NULL
            AND m.id > ${afterId}::uuid
            AND (
              m.metadata #>> '{sourceDeleted,folderId}' = ${rootFolderId}
              OR m.metadata #>> '{sourceRemoved,folderId}' = ${rootFolderId}
              OR EXISTS (
                SELECT 1
                FROM jsonb_array_elements(
                  CASE WHEN jsonb_typeof(m.metadata #> '{citations,sources}') = 'array'
                       THEN m.metadata #> '{citations,sources}' ELSE '[]'::jsonb END
                  || CASE WHEN jsonb_typeof(m.metadata #> '{readSources,sources}') = 'array'
                       THEN m.metadata #> '{readSources,sources}' ELSE '[]'::jsonb END
                ) AS src
                WHERE (src ->> 'document_id') = ANY(${`{${ids.join(',')}}`}::text[])
                   OR ((src ->> 'collection') || chr(31) || (src ->> 'file_name')) = ANY(${pgTextArray(refs)}::text[])
                   OR ((src ->> 'collection') IS NULL AND (src ->> 'file_name') = ANY(${pgTextArray(names)}::text[]))
              )
            )
          ORDER BY m.id
          LIMIT ${PAGE}
        `)
      )
    )
    for (const row of rows) found.push({ messageId: String(row.id), conversationId: String(row.conversation_id) })
    if (rows.length < PAGE) return found
    afterId = String(rows[rows.length - 1].id)
  }
}

/** A text array literal for a parameter, every element quoted. */
function pgTextArray(values: readonly string[]): string {
  const quoted = values.map((value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
  return `{${quoted.join(',')}}`
}

/**
 * Mark answers as drawn from a purged folder: what the chat shows as „Quelle
 * gelöscht am …". A merge into the metadata; the answer itself is untouched.
 * Idempotent: an answer already marked keeps its first date.
 */
export async function markAnswersSourceDeleted(
  organizationId: string,
  messageIds: readonly string[],
  rootFolderId: string,
  at: Date
): Promise<void> {
  if (messageIds.length === 0) return
  const db = getDb()
  const stamp = JSON.stringify({ sourceDeleted: { folderId: rootFolderId, at: at.toISOString() } })
  for (let start = 0; start < messageIds.length; start += PAGE) {
    const chunk = messageIds.slice(start, start + PAGE)
    await withTenant({ organizationId }, () =>
      db
        .update(messages)
        .set({ metadata: sql`coalesce(${messages.metadata}, '{}'::jsonb) || ${stamp}::jsonb` })
        .where(
          and(
            eq(messages.organizationId, organizationId),
            inArray(messages.id, chunk),
            sql`${messages.metadata} -> 'sourceDeleted' IS NULL`
          )
        )
    )
  }
}

/**
 * Replace answers whose source folder was purged with its derived content: the
 * text becomes {@link REMOVED_ANSWER_TEXT} and the metadata only the removal's
 * own mark, so the citations, cards, findings, the Herleitung and every quote
 * built from the folder go with the text. The row stays, so the chat reads on.
 */
export async function replaceRemovedAnswers(
  organizationId: string,
  messageIds: readonly string[],
  rootFolderId: string,
  at: Date
): Promise<number> {
  if (messageIds.length === 0) return 0
  const db = getDb()
  const mark = JSON.stringify({ sourceRemoved: { folderId: rootFolderId, at: at.toISOString() } })
  let replaced = 0
  for (let start = 0; start < messageIds.length; start += PAGE) {
    const chunk = messageIds.slice(start, start + PAGE)
    const rows = await withTenant({ organizationId }, () =>
      db
        .update(messages)
        .set({ content: REMOVED_ANSWER_TEXT, metadata: sql`${mark}::jsonb` })
        .where(and(eq(messages.organizationId, organizationId), inArray(messages.id, chunk)))
        .returning({ id: messages.id })
    )
    replaced += rows.length
  }
  return replaced
}

/**
 * Delete the memory notes drawn from these folders: a restricted note names
 * its source folders (`restricted_folder_ids`), and a note from an open folder
 * names none, so a note learned in a conversation whose answers drew on the
 * folder goes too. Returns the ids deleted.
 */
export async function deleteMemoryDrawnFrom(
  organizationId: string,
  projectId: string,
  folderIds: readonly string[],
  conversationIds: readonly string[]
): Promise<string[]> {
  const db = getDb()
  const fromFolders = sql`${projectMemory.restrictedFolderIds} && ${`{${folderIds.join(',')}}`}::uuid[]`
  const fromConversations =
    conversationIds.length > 0 ? [inArray(projectMemory.sourceConversationId, [...conversationIds])] : []
  const rows = await withTenant({ organizationId }, () =>
    db
      .delete(projectMemory)
      .where(
        and(
          eq(projectMemory.organizationId, organizationId),
          or(eq(projectMemory.projectId, projectId), sql`${projectMemory.projectId} IS NULL`),
          or(fromFolders, ...fromConversations)
        )
      )
      .returning({ id: projectMemory.id })
  )
  return rows.map((row) => row.id)
}

/** A filed report or document Piloti wrote from a conversation that drew on the folder. */
export interface DerivedReport {
  id: string
  name: string
  projectId: string | null
}

/** Most reports one purge marks. */
export const REPORT_REVIEW_LIMIT = 500

/**
 * The documents Piloti filed from these conversations or answers: machine-
 * authored rows whose answer ref is one of the answers, or that have a version
 * written in one of the conversations. Marked, never deleted here:
 * a filed report is the office's record, and whether it must go is a judgement.
 */
export async function listReportsDerivedFrom(
  organizationId: string,
  conversationIds: readonly string[],
  messageIds: readonly string[]
): Promise<DerivedReport[]> {
  if (conversationIds.length === 0 && messageIds.length === 0) return []
  const db = getDb()
  const byVersion =
    conversationIds.length > 0
      ? [
          inArray(
            documents.id,
            db
              .select({ id: documentVersions.documentId })
              .from(documentVersions)
              .where(
                and(
                  eq(documentVersions.organizationId, organizationId),
                  inArray(documentVersions.originConversationId, [...conversationIds])
                )
              )
          ),
        ]
      : []
  const byAnswer = messageIds.length > 0 ? [inArray(documents.authoredByRef, [...messageIds])] : []
  const rows = await withTenant({ organizationId }, () =>
    db
      .select({ id: documents.id, filename: documents.filename, displayName: documents.displayName, projectId: documents.projectId })
      .from(documents)
      .where(and(eq(documents.organizationId, organizationId), ne(documents.authoredBy, 'user'), or(...byVersion, ...byAnswer)))
      .limit(REPORT_REVIEW_LIMIT)
  )
  return rows.map((row) => ({ id: row.id, name: row.displayName ?? row.filename, projectId: row.projectId }))
}

/** Mark filed reports as drawn from a purged folder, for their „Quelle gelöscht am …" notice. */
export async function markReportsSourceDeleted(
  organizationId: string,
  documentIds: readonly string[],
  rootFolderId: string,
  at: Date
): Promise<void> {
  if (documentIds.length === 0) return
  const db = getDb()
  const stamp = JSON.stringify({ sourceDeleted: { folderId: rootFolderId, at: at.toISOString() } })
  await withTenant({ organizationId }, () =>
    db
      .update(documents)
      .set({ metadata: sql`coalesce(${documents.metadata}, '{}'::jsonb) || ${stamp}::jsonb` })
      .where(
        and(
          eq(documents.organizationId, organizationId),
          inArray(documents.id, [...documentIds]),
          sql`coalesce(${documents.metadata}, '{}'::jsonb) -> 'sourceDeleted' IS NULL`
        )
      )
  )
}
