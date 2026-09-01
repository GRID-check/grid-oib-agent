/**
 * Dateien, shared by its two routes.
 *
 * `/files` is the corpus root and `/files/<folder>/<subfolder>` is a level
 * inside it — the same page, differing only in which folder the URL names, so
 * the gate, the lookup and the flags live here once rather than twice.
 */

import { type Metadata } from 'next'
import { notFound } from 'next/navigation'
import { withPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { FEATURE_FLAGS, isCollaborationEnabled, isFeatureEnabled, isIfcModelsEnabled } from '@/lib/authz/feature-flags'
import { findProjectInOrg } from '@/lib/projects/repository'
import { getTranslations } from '@/i18n/server'
import { ProjectFileWorkspace } from '@/features/documents/components/project-file-workspace'

/**
 * The tab title for a level.
 *
 * The last segment is the folder's own name — the layout's template wraps it
 * as "<Project> · <Folder> — Piloti", which is what a browser history entry
 * and a bookmark need in order to be worth having. Nothing resolves it against
 * the database: a path that names no folder redirects on arrival anyway, and a
 * round trip per title would tax every real one to catch it a moment earlier.
 */
export async function filesMetadata(folderPath?: string[]): Promise<Metadata> {
  const t = await getTranslations('nav')
  const section = t('sections.files')
  const current = folderPath?.at(-1)?.trim()
  return { title: current ? `${section} · ${current}` : section }
}

export async function renderFilesRoute(
  id: string,
  /** The folder segments from the URL; empty at the corpus root. */
  folderPath: string[] = []
): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    await requireProjectAccess(session, id, 'project:view')

    const project = await findProjectInOrg(id, session.organizationId)

    if (!project) {
      notFound()
    }

    // Org-level gate for the ingestion-metadata block (WorkOS `files-metadata-panel`).
    // Fail-open when enforcement is off (isFeatureEnabled → true).
    const showMetadataPanel = isFeatureEnabled(session, FEATURE_FLAGS.filesMetadataPanel)

    // The model viewer lives inside this page now (there is no `/model` route
    // any more — it redirects here). The org flag no longer hides a
    // destination; it decides whether clicking an `.ifc` opens the building or
    // the ordinary file preview, which is the honest behaviour for a tenant
    // whose BIM endpoints would refuse the request anyway.
    const showModels = isIfcModelsEnabled(session)

    return (
      <ProjectFileWorkspace
        projectId={id}
        projectName={project.name}
        collectionName={project.collectionName}
        folderPath={folderPath}
        showMetadataPanel={showMetadataPanel}
        showModels={showModels}
        canCollaborate={isCollaborationEnabled(session)}
        currentUserId={session.userId}
      />
    )
  })
}
