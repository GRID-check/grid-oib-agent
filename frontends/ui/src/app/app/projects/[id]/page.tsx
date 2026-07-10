import { notFound } from 'next/navigation'
import { requireAuthorizedPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getProjectOverviewData } from '@/lib/projects/overview-query'
import { ProjectOverview } from '@/features/projects/components/project-overview'

interface ProjectPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectPage({ params }: ProjectPageProps): Promise<JSX.Element> {
  const session = await requireAuthorizedPageSession()
  const { id } = await params

  // View access gates the page; the derived role tells us whether the user can
  // also delete (project-admin ⇒ project:manage), which gates the danger zone.
  const { role } = await requireProjectAccess(session, id, 'project:view')

  const data = await getProjectOverviewData(id, session.organizationId)

  if (!data) {
    notFound()
  }

  return <ProjectOverview data={data} canManageProject={role === 'project-admin'} />
}
