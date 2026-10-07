import 'server-only'
import { archivCollectionName } from '@/lib/archiv/collection'
import { findProjectInOrg } from '@/lib/projects/repository'
import type { DocumentShelf } from './shelf'

/**
 * The RAG collection a shelf's documents are ingested into, or `null` when the
 * shelf does not exist in this tenant (a project that is gone or is another
 * organization's).
 *
 * Per shelf: a project's own `proj_<uuid>`, the organization's
 * `archiv_<orgId>`. The one place the two are told apart for every caller that
 * has a shelf and needs its collection — the upload pipeline and the
 * folder-path mirror.
 */
export async function shelfCollectionName(
  shelf: DocumentShelf,
  organizationId: string,
): Promise<string | null> {
  if (shelf.kind === 'archiv') return archivCollectionName(organizationId)
  const project = await findProjectInOrg(shelf.projectId, organizationId)
  return project?.collectionName ?? null
}
