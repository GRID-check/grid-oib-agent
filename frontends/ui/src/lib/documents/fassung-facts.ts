/**
 * The Fassung facts of documents, resolved for ONE reader.
 *
 * The backend stores a Fassung link by file name. This is the only place a name
 * becomes a document the browser is told about, and it does so through the same
 * rules a listing applies: the documents of the SAME collection, active, past
 * screening for this reader (`documentVisibleTo`, ADR-0086), and not in a
 * folder this session may not open (ADR-0087; the Papierkorb counts as closed).
 * What fails any of them is dropped with its name (`resolveFassungFacts`).
 *
 * Kept apart from `reconcile-status.ts` on purpose. That module's metadata is
 * spread onto rows several callers hand out, with no reader in sight; a file
 * name there would be one forgotten destructure away from the wire.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getHiddenFolderIds } from '@/lib/authz/folder-access'
import { collectionFileRef, type AuthoredDocumentRow } from './collection-file-ref'
import type { DocumentReader } from './document-reader'
import {
  referencedNames,
  resolveFassungFacts,
  type FassungFacts,
  type FassungNames,
  type FassungRef,
} from './fassung'
import { documentNameKey } from './name-match'
import { readFassungNames, refreshCollectionFiles } from './reconcile-status'
import { findFassungCounterparts, type FassungCounterpartRow } from './repository'

/** A document to read the Fassung facts of: the row facts `collectionFileRef` needs, and its id. */
export interface FassungSubject extends AuthoredDocumentRow {
  id: string
}

/** The counterparts the session may open, by name key: the documents one collection's names resolve to. */
async function visibleRefs(
  session: AuthorizedSession,
  collectionName: string,
  filenames: readonly string[],
  reader: DocumentReader,
): Promise<Map<string, FassungRef>> {
  const rows = await findFassungCounterparts(session.organizationId, collectionName, filenames, reader)
  const hidden = await hiddenFoldersByProject(session, rows)
  const refs = new Map<string, FassungRef>()
  for (const row of rows) {
    const closed = row.projectId !== null && row.folderId !== null && hidden.get(row.projectId)?.has(row.folderId)
    if (!closed) refs.set(documentNameKey(row.filename), { id: row.id, filename: row.filename })
  }
  return refs
}

/** The folders this session may not open, per project the rows belong to. */
async function hiddenFoldersByProject(
  session: AuthorizedSession,
  rows: readonly FassungCounterpartRow[],
): Promise<Map<string, ReadonlySet<string>>> {
  const projectIds = [
    ...new Set(rows.filter((row) => row.folderId !== null).map((row) => row.projectId)),
  ].filter((id): id is string => id !== null)
  const hidden = await Promise.all(projectIds.map((projectId) => getHiddenFolderIds(session, projectId)))
  return new Map(projectIds.map((projectId, index) => [projectId, new Set(hidden[index])]))
}

/**
 * The Fassung facts of `subjects` for `session`, by document id. A document with
 * nothing to say (or nothing the reader may see) has no entry.
 *
 * `reader` is the one the rows were read with, so a document held from the
 * reader is held here as well. `fresh` reads the backend listing anew, for the
 * answer to a write that the cached listing predates.
 */
export async function loadFassungFacts(
  session: AuthorizedSession,
  subjects: readonly FassungSubject[],
  reader: DocumentReader,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<Map<string, FassungFacts>> {
  const facts = new Map<string, FassungFacts>()
  if (fresh) {
    const collections = new Set<string>()
    for (const subject of subjects) if (collectionFileRef(subject)) collections.add(subject.collectionName)
    await Promise.all([...collections].map((collection) => refreshCollectionFiles(collection)))
  }

  const named: Array<{ subject: FassungSubject; names: FassungNames }> = []
  await Promise.all(
    subjects.map(async (subject) => {
      const ref = collectionFileRef(subject)
      const names = ref ? await readFassungNames(ref) : null
      if (names) named.push({ subject, names })
    }),
  )
  if (named.length === 0) return facts

  const wanted = new Map<string, Set<string>>()
  for (const { subject, names } of named) {
    const set = wanted.get(subject.collectionName) ?? new Set<string>()
    for (const filename of referencedNames(names, subject.filename)) set.add(filename)
    wanted.set(subject.collectionName, set)
  }
  const refsByCollection = new Map<string, Map<string, FassungRef>>()
  await Promise.all(
    [...wanted].map(async ([collectionName, filenames]) => {
      refsByCollection.set(
        collectionName,
        filenames.size === 0 ? new Map() : await visibleRefs(session, collectionName, [...filenames], reader),
      )
    }),
  )

  for (const { subject, names } of named) {
    const refs = refsByCollection.get(subject.collectionName)
    const resolved = resolveFassungFacts(names, subject.filename, (filename) => refs?.get(documentNameKey(filename)) ?? null)
    if (resolved) facts.set(subject.id, resolved)
  }
  return facts
}
