import { type Metadata } from 'next'
import { eq, and } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import { requireAuthorizedPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import { projects } from '@/lib/db/schema'
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
  // Capture the effective role so the UI only shows write affordances the caller
  // can actually use — a viewer must not see Upload / New folder / Retry buttons
  // that always 404 (they require project:edit). Mirrors the sibling pages.
  const { role } = await requireProjectAccess(session, id, 'project:view')
  const canEdit = role === 'project-editor' || role === 'project-admin'

  const db = getDb()
  const [project] = await db
    .select({ name: projects.name, collectionName: projects.collectionName })
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.organizationId, session.organizationId)))
    .limit(1)

  if (!project) {
    notFound()
  }

  return (
    <ProjectFileWorkspace
      projectId={id}
      projectName={project.name}
      collectionName={project.collectionName}
      canEdit={canEdit}
    />
  )
}
