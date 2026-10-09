import type { JSX } from 'react'
import { type Metadata } from 'next'
import { notFound } from 'next/navigation'
import { withPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getProjectUsage } from '@/lib/budgets/service'
import { getProjectOverviewData } from '@/lib/projects/overview-query'
import { resolveProjectSettingsAccess } from '@/lib/projects/settings-access'
import { ProjectOverview } from '@/features/projects/components/overview/project-overview'
import { getTranslations } from '@/i18n/server'

interface PageProps {
  params: Promise<{ id: string }>
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('nav')
  return { title: t('sections.settings') }
}

/**
 * The project Overview: the bento dashboard the hub opens on. The usage tile is
 * loaded only for a reader who may see the project's spend, which is the same
 * set the Usage section is open to.
 */
export default async function ProjectOverviewPage({ params }: PageProps): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    const { id } = await params
    await requireProjectAccess(session, id, 'project:view')

    const [data, access] = await Promise.all([
      getProjectOverviewData(id, session.organizationId),
      resolveProjectSettingsAccess(session, id),
    ])
    if (!data) notFound()

    const usage = access.manageBudget ? await getProjectUsage(session, id) : null

    return (
      <ProjectOverview
        data={data}
        usage={usage}
        access={{
          manage: access.manage,
          editProfile: access.editProfile,
          manageMembers: access.manageMembers,
        }}
      />
    )
  })
}
