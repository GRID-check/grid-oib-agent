import { type Metadata } from 'next'
import { notFound } from 'next/navigation'
import { withPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getNavFlags } from '@/lib/authz/nav'
import { isIfcModelsEnabled, isSkillsEnabled } from '@/lib/authz/feature-flags'
import { findProjectInOrg } from '@/lib/projects/repository'
import { listProjects } from '@/lib/projects/service'
import { AppSidebar } from '@/components/shell'
import { PRODUCT_NAME } from '@/lib/brand'
import { RouteFocus } from '@/shared/components/route-focus'
import { isAuthRequired } from '@/lib/auth/auth-required'


interface ProjectLayoutProps {
  children: React.ReactNode
  params: Promise<{ id: string }>
}

/**
 * Seed the browser-tab title with the project name and a per-section template,
 * so nested pages resolve to "<Project> · <Section> — Piloti" (the project root
 * redirects to Chat and never renders a title of its own). The project name is
 * user data and is not translated; sections localize their own `title`. Fails
 * soft: any lookup problem falls back to the root template rather than
 * crashing metadata generation.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  try {
    // `generateMetadata` is its own render entry point — React runs it
    // independently of the layout body below, so it opens its own tenant slot
    // rather than inheriting one.
    return await withPageSession(async (session) => {
      const { id } = await params
      // Org tenancy is not enough to put a project's NAME in the browser tab.
      // A member who lacks `project:view` would otherwise learn the name of a
      // project the page below is about to refuse them — the same read ADR-0038
      // draws the line at. A denial throws and is caught below, degrading to
      // the root title.
      await requireProjectAccess(session, id, 'project:view')
      const project = await findProjectInOrg(id, session.organizationId)

      if (!project?.name) return {}

      return {
        title: {
          default: `${project.name} — ${PRODUCT_NAME}`,
          template: `${project.name} · %s — ${PRODUCT_NAME}`,
        },
      }
    })
  } catch {
    return {}
  }
}

export default async function ProjectLayout({
  children,
  params,
}: ProjectLayoutProps): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    const navFlags = await getNavFlags(session)
    // Skills supersedes Workflows (ADR-0046): the two sections are mutually
    // exclusive in the rail — a deployment sees either the workflows entry or
    // its skills successor, never both.
    const showSkills = isSkillsEnabled(session)
    const { id } = await params
    // View access is enough to enter the project shell; per-section controls
    // (danger zone, member management) are gated inside their own pages.
    await requireProjectAccess(session, id, 'project:view')

    // Soft-deleted projects are gone for everyone — including org admins, who
    // bypass the per-project check inside requireProjectAccess. `findProjectInOrg`
    // excludes them by default, so a missing row IS the soft-deleted case.
    const current = await findProjectInOrg(id, session.organizationId)
    if (!current) notFound()

    // The sidebar switcher goes through the service, not a raw org-wide select:
    // it is a list of project names and ids, which is exactly what ADR-0038 says
    // a member without `project:view` on a project must not be handed. Ordering
    // by name stays a presentation concern, applied to the reachable set.
    const orgProjects = (await listProjects(session))
      .map((project) => ({ id: project.id, name: project.name }))
      .sort((a, b) => a.name.localeCompare(b.name))

    return (
      <div className="bg-background text-foreground flex h-dvh flex-col overflow-hidden md:flex-row">
        <AppSidebar
          projectId={id}
          projects={orgProjects}
          user={{ name: session.name, email: session.email }}
          authRequired={isAuthRequired()}
          canManageOrganization={navFlags.canManageOrganization}
          canViewOrganization={navFlags.canViewOrganization}
          canManagePlatform={navFlags.canManagePlatform}
          canAccessArchiv={navFlags.canAccessArchiv}
          canAccessInbox={navFlags.canAccessInbox}
          showSkills={showSkills}
          showModels={isIfcModelsEnabled(session)}
        />
        {/* tabIndex={-1} makes the landmark programmatically focusable so
            RouteFocus can move focus here on client-side section changes. */}
        <main
          id="main-content"
          tabIndex={-1}
          className="bg-background min-w-0 flex-1 overflow-y-auto outline-none"
        >
          <RouteFocus />
          {children}
        </main>
      </div>
    )
  })
}
