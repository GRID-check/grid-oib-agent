import { type Metadata } from 'next'
import { notFound } from 'next/navigation'
import { requireAuthorizedPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { FEATURE_FLAGS, isFeatureEnabled } from '@/lib/authz/feature-flags'
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
  const session = await requireAuthorizedPageSession()
  const { id } = await params
  await requireProjectAccess(session, id, 'project:view')

  const project = await findProjectInOrg(id, session.organizationId)

  if (!project) {
    notFound()
  }

  // Org-level gate for the ingestion-metadata block (WorkOS `files-metadata-panel`).
  // Fail-open when enforcement is off (isFeatureEnabled → true).
  const showMetadataPanel = isFeatureEnabled(session, FEATURE_FLAGS.filesMetadataPanel)

  return (
    <ProjectFileWorkspace
      projectId={id}
      projectName={project.name}
      collectionName={project.collectionName}
      showMetadataPanel={showMetadataPanel}
    />
  )
}
