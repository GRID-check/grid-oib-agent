import { asc, eq } from 'drizzle-orm'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import { projects } from '@/lib/db/schema'
import { AppSidebar } from '@/components/shell'

const isAuthRequired = (): boolean => process.env.REQUIRE_AUTH?.toLowerCase() === 'true'

interface ProjectLayoutProps {
  children: React.ReactNode
  params: Promise<{ id: string }>
}

export default async function ProjectLayout({ children, params }: ProjectLayoutProps): Promise<JSX.Element> {
  const session = await requireAuthorizedSession()
  const { id } = await params
  const { role } = await requireProjectAccess(session, id, 'project:view')
  const db = getDb()

  const orgProjects = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.organizationId, session.organizationId))
    .orderBy(asc(projects.name))

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <AppSidebar
        projectId={id}
        projects={orgProjects}
        user={{ name: session.name, email: session.email }}
        authRequired={isAuthRequired()}
        canManageMembers={role === 'project-admin'}
      />
      <main id="main-content" className="min-w-0 flex-1 overflow-y-auto bg-background">
        {children}
      </main>
    </div>
  )
}
