import { and, asc, eq, isNull } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import { requireAuthorizedPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getNavFlags } from '@/lib/authz/nav'
import { getDb } from '@/lib/db'
import { projects } from '@/lib/db/schema'
import { AppSidebar } from '@/components/shell'

const isAuthRequired = (): boolean => process.env.REQUIRE_AUTH?.toLowerCase() === 'true'

interface ProjectLayoutProps {
  children: React.ReactNode
  params: Promise<{ id: string }>
}

export default async function ProjectLayout({ children, params }: ProjectLayoutProps): Promise<JSX.Element> {
  const session = await requireAuthorizedPageSession()
  const navFlags = await getNavFlags(session)
  const { id } = await params
  // View access is enough to enter the project shell; per-section controls
  // (danger zone, member management) are gated inside their own pages.
  await requireProjectAccess(session, id, 'project:view')
  const db = getDb()

  // Soft-deleted projects are gone for everyone — including org admins, who
  // bypass the per-project check inside requireProjectAccess.
  const [current] = await db
    .select({ deletedAt: projects.deletedAt })
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1)
  if (!current || current.deletedAt) notFound()

  const orgProjects = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(
      and(
        eq(projects.organizationId, session.organizationId),
        isNull(projects.deletedAt),
      ),
    )
    .orderBy(asc(projects.name))

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground md:flex-row">
      <AppSidebar
        projectId={id}
        projects={orgProjects}
        user={{ name: session.name, email: session.email }}
        authRequired={isAuthRequired()}
        canManageOrganization={navFlags.canManageOrganization}
        canViewOrganization={navFlags.canViewOrganization}
        canManagePlatform={navFlags.canManagePlatform}
      />
      <main id="main-content" className="min-w-0 flex-1 overflow-y-auto bg-background">
        {children}
      </main>
    </div>
  )
}
