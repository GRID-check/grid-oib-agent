import { type Metadata } from 'next'
import { notFound } from 'next/navigation'
import { requireAuthorizedPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { findProjectInOrg } from '@/lib/projects/repository'
import { ProjectHistory } from '@/features/projects/components/project-history'
import { getTranslations } from '@/i18n/server'

interface ProjectHistoryPageProps {
  params: Promise<{ id: string }>
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('nav')
  return { title: t('sections.history') }
}

/**
 * Project History (spec §5, FB-10) — one page over the two existing stores:
 * the project's conversations (the same BFF list the sessions panel hydrates
 * from) and the server-truth deep-research runs list. Rows deep-link back
 * into chat (`?session=` / `?job=`), reusing the chat page's existing URL
 * loaders — no new data model, no new API.
 */
export default async function ProjectHistoryPage({ params }: ProjectHistoryPageProps): Promise<JSX.Element> {
  const session = await requireAuthorizedPageSession()
  const { id } = await params

  await requireProjectAccess(session, id, 'project:view')

  // The research-runs list scopes its fetch to this project's Qdrant
  // collection — same lookup the legacy research page performed.
  const project = await findProjectInOrg(id, session.organizationId)

  if (!project) {
    notFound()
  }

  return (
    <div className="mx-auto w-full max-w-[1080px] px-6 pb-10 pt-8 md:px-10 md:pt-[34px]">
      <ProjectHistory projectId={id} projectCollection={project.collectionName} />
    </div>
  )
}
