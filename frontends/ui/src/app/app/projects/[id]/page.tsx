import { notFound } from 'next/navigation'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getProjectOverviewData } from '@/lib/projects/overview-query'
import { ProjectOverview } from '@/features/projects/components/project-overview'

interface ProjectPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectPage({ params }: ProjectPageProps): Promise<JSX.Element> {
  const session = await requireAuthorizedSession()
  const { id } = await params

  await requireProjectAccess(session, id, 'project:view')

  const data = await getProjectOverviewData(id, session.organizationId)

  if (!data) {
    notFound()
  }

  return <ProjectOverview data={data} />
}
