import { type Metadata } from 'next'
import { notFound } from 'next/navigation'
import { withPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import {
  FEATURE_FLAGS,
  isCollaborationEnabled,
  isFeatureEnabled,
  isIfcModelsEnabled,
  isIfcPreviewFirstEnabled,
} from '@/lib/authz/feature-flags'
import { findProjectInOrg } from '@/lib/projects/repository'
import { getTranslations } from '@/i18n/server'
import { ProjectFileWorkspace } from '@/features/documents/components/project-file-workspace'

interface FilesPageProps {
  params: Promise<{ id: string }>
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('nav')
  return { title: t('sections.files') }
}

export default async function FilesPage({ params }: FilesPageProps): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    const { id } = await params
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
    // destination; it decides whether the model surfaces exist at all for this
    // tenant, which is the honest behaviour for one whose BIM endpoints would
    // refuse the request anyway.
    const showModels = isIfcModelsEnabled(session)

    // What a click on an `.ifc` DOES — preview first, or straight to the stage.
    // Read here AND in the Archiv sheet from the same helper, because the whole
    // point of the flag is that it moves both file surfaces together.
    const previewFirst = isIfcPreviewFirstEnabled(session)

    return (
      <ProjectFileWorkspace
        projectId={id}
        projectName={project.name}
        collectionName={project.collectionName}
        showMetadataPanel={showMetadataPanel}
        showModels={showModels}
        previewFirst={previewFirst}
        canCollaborate={isCollaborationEnabled(session)}
        currentUserId={session.userId}
      />
    )
  })
}
