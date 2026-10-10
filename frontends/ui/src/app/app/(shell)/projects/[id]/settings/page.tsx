import type { JSX } from 'react'
import { Suspense } from 'react'
import { type Metadata } from 'next'
import { notFound } from 'next/navigation'
import type { AuthorizedSession } from '@/lib/auth/types'
import { withPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getProjectUsage } from '@/lib/budgets/service'
import { getProjectActivity } from '@/lib/projects/activity'
import { getProjectOverviewData } from '@/lib/projects/overview-query'
import { projectOverviewReader } from '@/lib/projects/service'
import { resolveProjectSettingsAccess } from '@/lib/projects/settings-access'
import { getSteckbrief } from '@/lib/projects/steckbrief-service'
import { getSimilarProjects } from '@/lib/references/service'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { BentoCell } from '@/components/ui/bento'
import { Skeleton } from '@/components/ui/skeleton'
import { ProjectOverview } from '@/features/projects/components/overview/project-overview'
import { SimilarProjectsTile } from '@/features/projects/components/overview/similar-projects-tile'
import { settingsSectionHref } from '@/features/projects/lib/settings-sections'
import { getTranslations } from '@/i18n/server'

interface PageProps {
  params: Promise<{ id: string }>
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('nav')
  return { title: t('sections.settings') }
}

/**
 * The project Overview: the bento dashboard the hub opens on.
 *
 * Activity (how many questions, by how many people) and the Steckbrief are for
 * everyone; spend is loaded only for a reader who may see it, the same set the
 * Usage section is open to. Document counts use the overview reader, so they
 * leave out folders this reader may not open and quarantined uploads
 * (ADR-0087, ADR-0086). Similar projects stream in after the rest.
 */
export default async function ProjectOverviewPage({ params }: PageProps): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    const { id } = await params
    await requireProjectAccess(session, id, 'project:view')

    const [data, access, activity, steckbrief] = await Promise.all([
      projectOverviewReader(session, id).then((reader) =>
        getProjectOverviewData(id, session.organizationId, reader)
      ),
      resolveProjectSettingsAccess(session, id),
      getProjectActivity(session, id),
      getSteckbrief(session, id),
    ])
    if (!data) notFound()

    const [usage, accounts] = await Promise.all([
      access.manageBudget ? getProjectUsage(session, id) : null,
      // The organization's people, to link a Steckbrief person to their
      // account; asked only of someone who may edit it. Names only, never e-mail.
      steckbrief.canEdit
        ? loadOrganizationDirectory(session.organizationId).then((directory) =>
            [...directory.values()].map((person) => ({ userId: person.userId, name: person.name }))
          )
        : [],
    ])

    return (
      <ProjectOverview
        data={data}
        activity={activity}
        usage={usage}
        steckbrief={steckbrief}
        steckbriefAccounts={accounts}
        similar={
          <Suspense
            fallback={
              <BentoCell span="wide">
                <Skeleton className="h-40 rounded-lg" />
              </BentoCell>
            }
          >
            <SimilarProjectsSlot session={session} projectId={id} />
          </Suspense>
        }
        access={{
          manage: access.manage,
          changeStatus: access.changeStatus,
          writeMemory: access.writeMemory,
          editProfile: access.editProfile,
          manageMembers: access.manageMembers,
        }}
      />
    )
  })
}

/** The similar-projects tile, read on its own so the dashboard does not wait for it. */
async function SimilarProjectsSlot({
  session,
  projectId,
}: {
  session: AuthorizedSession
  projectId: string
}): Promise<JSX.Element> {
  const page = await getSimilarProjects(session, projectId)
  return (
    <SimilarProjectsTile
      page={page}
      href={settingsSectionHref(projectId, 'references')}
    />
  )
}
