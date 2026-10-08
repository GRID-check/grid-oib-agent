/**
 * Which of a project's files the closing extraction may read (ADR-0095).
 *
 * What the extraction reads becomes the project's fingerprint and decisions:
 * profile assumptions every member reads and memory rows written without a
 * folder restriction. So it reads only what every member may open and a model
 * may read (ADR-0089: a restricted folder stays restricted on a closed
 * project too):
 *
 *   - filed in the project's main collection (a restricted folder has its own);
 *   - filed where a reader cleared for NO restricted folder is served from now,
 *     judged from the document's live folder as permits are
 *     (`liveFolderAccess`): a document moved into a restricted folder whose
 *     chunks placement has not moved yet, or one in the Papierkorb, is out;
 *   - past the upload screen as a model may read it (`SCREENED_ONLY`, ADR-0086):
 *     nobody's held upload;
 *   - active, not archived.
 *
 * The backend reads chunks by file name, so a name has to stand for one row:
 * `uniq_documents_live_name_per_collection` keeps one live document per name
 * in a collection over every row that owns chunks, and an allowed row's name
 * therefore reads no other row's text.
 */

import 'server-only'
import { and, asc, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { documents } from '@/lib/db/schema'
import { documentVisibleTo, SCREENED_ONLY } from '@/lib/documents/visibility'
import { liveFolderAccess } from '@/lib/permits/live-access'
import { servedFrom } from '@/lib/permits/repository'

/** No restricted folder: the clearance every member of the project has. */
const NO_CLEARANCE: readonly string[] = []

/** The file names of the project's main collection the closing extraction may read, sorted; none for an empty one. */
export async function extractableFileNames(
  organizationId: string,
  projectId: string,
  collectionName: string
): Promise<string[]> {
  const access = await liveFolderAccess(organizationId, projectId, NO_CLEARANCE)
  const rows = await getDb()
    .selectDistinct({ fileName: documents.filename })
    .from(documents)
    .where(
      and(
        eq(documents.organizationId, organizationId),
        eq(documents.projectId, projectId),
        eq(documents.collectionName, collectionName),
        documentVisibleTo(SCREENED_ONLY),
        eq(documents.lifecycle, 'active'),
        servedFrom(access.visibleFolderIds)
      )
    )
    .orderBy(asc(documents.filename))
  return rows.map((row) => row.fileName)
}
