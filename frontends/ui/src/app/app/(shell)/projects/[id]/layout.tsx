import { type Metadata } from 'next'
import { notFound } from 'next/navigation'
import { withPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { findProjectInOrg } from '@/lib/projects/repository'
import { NavigationTrailLabel, ProjectSectionFrame } from '@/components/shell'
import { PRODUCT_NAME } from '@/lib/brand'
import { FilePreviewBridge } from '@/features/documents/components/file-preview-host'

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

/**
 * The project segment: an ACCESS GATE and the project's own section chrome.
 *
 * It no longer renders a rail or a `<main>`. Both moved up to the `(shell)`
 * layout, because mounting them here is what made them disappear the moment the
 * reader stepped out of a project — the rail, the content column and the scroll
 * container all belonged to a segment that unmounts. What is genuinely
 * per-project stays: the access check, the soft-delete 404, the trail label, and
 * the section header/actions frame.
 */
export default async function ProjectLayout({
  children,
  params,
}: ProjectLayoutProps): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    const { id } = await params
    // View access is enough to enter the project shell; per-section controls
    // (danger zone, member management) are gated inside their own pages.
    await requireProjectAccess(session, id, 'project:view')

    // Soft-deleted projects are gone for everyone — including org admins, who
    // bypass the per-project check inside requireProjectAccess. `findProjectInOrg`
    // excludes them by default, so a missing row IS the soft-deleted case.
    const current = await findProjectInOrg(id, session.organizationId)
    if (!current) notFound()

    return (
      <>
        {/* Names this project in the tab's return trail, so a surface above
            projects (the Archiv, the Organisation, the Postfach) can offer
            "Zurück zu <project>" rather than a path it can only read an id out
            of — including the org-scope rail's own back control. */}
        <NavigationTrailLabel label={current.name} />
        <FilePreviewBridge>
          <ProjectSectionFrame projectId={id} projectName={current.name}>
            {children}
          </ProjectSectionFrame>
        </FilePreviewBridge>
      </>
    )
  })
}
