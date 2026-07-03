import { eq } from 'drizzle-orm'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import { projects } from '@/lib/db/schema'
import { ProjectShell } from '@/components/projects/project-shell'

interface ProjectLayoutProps {
  children: React.ReactNode
  params: Promise<{ id: string }>
}

export default async function ProjectLayout({ children, params }: ProjectLayoutProps): Promise<JSX.Element> {
  const session = await requireAuthorizedSession()
  const { id } = await params
  await requireProjectAccess(session, id, 'project:view')
  const db = getDb()

  const [project] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1)

  const projectName = project?.name ?? 'Project'

  return (
    <ProjectShell projectId={id} projectName={projectName}>
      {children}
    </ProjectShell>
  )
}
