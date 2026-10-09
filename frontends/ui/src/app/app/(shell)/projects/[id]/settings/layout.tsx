import type { JSX, ReactNode } from 'react'
import { withPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { resolveProjectSettingsAccess } from '@/lib/projects/settings-access'
import { ProjectSettingsNav } from '@/features/projects/components/settings/project-settings-nav'
import { visibleSettingsSections } from '@/features/projects/lib/settings-sections'

/**
 * The project hub: a tab strip over whichever section is open, the Overview
 * dashboard first.
 *
 * This used to be a Settings page stacking the profile, the roster, uploads,
 * memory, the index and the danger zone, with a placeholder Insights card. It
 * is now a dashboard and one route per section
 * (`features/projects/lib/settings-sections.ts` argues the split). Tabs rather
 * than the organization tier's side rail, because the dashboard wants the
 * whole width for its bento.
 *
 * Not a gate beyond `project:view`, which the project layout already enforces:
 * General, Profile, Memory and Documents are readable by every member of the
 * project. The nav is handed only the sections this reader's permissions reach,
 * and each gated section's page checks again, so a typed URL 404s rather than
 * rendering a section whose API would refuse it.
 */
export default async function ProjectSettingsLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ id: string }>
}): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    const { id } = await params
    await requireProjectAccess(session, id, 'project:view')
    const access = await resolveProjectSettingsAccess(session, id)

    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 md:px-8 md:py-8">
        <ProjectSettingsNav projectId={id} sections={visibleSettingsSections(access)} />
        <div className="animate-in fade-in-0 slide-in-from-bottom-1 duration-base ease-entrance min-w-0 motion-reduce:animate-none">
          {children}
        </div>
      </div>
    )
  })
}
