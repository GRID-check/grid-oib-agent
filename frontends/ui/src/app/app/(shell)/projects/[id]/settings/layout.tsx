import type { JSX, ReactNode } from 'react'
import { withPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { resolveProjectSettingsAccess } from '@/lib/projects/settings-access'
import { ProjectSettingsNav } from '@/features/projects/components/settings/project-settings-nav'
import { visibleSettingsSections } from '@/features/projects/lib/settings-sections'

/**
 * Project Settings tier: the section nav beside whichever section is open.
 *
 * Settings used to be one scrolling page that stacked the profile, the roster,
 * uploads, memory, the index and the danger zone, with a placeholder Insights
 * card. It is now one route per section (`features/projects/lib/settings-sections.ts`
 * argues the split), laid out exactly like the organization tier so both
 * settings surfaces work the same way.
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
      <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8 md:py-8">
        <div className="flex flex-col gap-6 lg:flex-row lg:gap-8">
          <div className="lg:w-52 lg:shrink-0">
            <ProjectSettingsNav projectId={id} sections={visibleSettingsSections(access)} />
          </div>
          <div className="animate-in fade-in-0 slide-in-from-bottom-1 duration-base ease-entrance min-w-0 flex-1 motion-reduce:animate-none">
            {children}
          </div>
        </div>
      </div>
    )
  })
}
