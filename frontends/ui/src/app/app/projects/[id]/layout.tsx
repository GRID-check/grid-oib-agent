import { type Metadata } from 'next'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import { requireAuthorizedPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getNavFlags } from '@/lib/authz/nav'
import { isProjectKnowledgePageEnabled } from '@/lib/authz/feature-flags'
import { getDb } from '@/lib/db'
import { projects } from '@/lib/db/schema'
import { AppSidebar } from '@/components/shell'
import { RouteFocus } from '@/shared/components/route-focus'

const isAuthRequired = (): boolean => process.env.REQUIRE_AUTH?.toLowerCase() === 'true'

interface ProjectLayoutProps {
  children: React.ReactNode
  params: Promise<{ id: string }>
}

/**
 * Seed the browser-tab title with the project name and a per-section template,
 * so nested pages resolve to "<Project> · <Section> — Grid" (and the overview,
 * which sets no section title, to "<Project> — Grid"). The project name is user
 * data and is not translated; sections localize their own `title`. Fails soft:
 * any lookup problem falls back to the root template rather than crashing
 * metadata generation.
 */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  try {
    const session = await requireAuthorizedPageSession()
    const { id } = await params
    const db = getDb()
    const [project] = await db
      .select({ name: projects.name })
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.organizationId, session.organizationId)))
      .limit(1)

    if (!project?.name) return {}

    return {
      title: {
        default: `${project.name} — Grid`,
        template: `${project.name} · %s — Grid`,
      },
    }
  } catch {
    return {}
  }
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
        showKnowledge={isProjectKnowledgePageEnabled(session)}
      />
      {/* tabIndex={-1} makes the landmark programmatically focusable so
          RouteFocus can move focus here on client-side section changes. */}
      <main
        id="main-content"
        tabIndex={-1}
        className="min-w-0 flex-1 overflow-y-auto bg-background outline-none"
      >
        <RouteFocus />
        {children}
      </main>
    </div>
  )
}
