import type { JSX } from 'react'
import { type Metadata } from 'next'
import { notFound } from 'next/navigation'
import { withPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getProjectOverviewData } from '@/lib/projects/overview-query'
import { resolveProjectSettingsAccess } from '@/lib/projects/settings-access'
import { ProfileSettings } from '@/features/projects/components/settings/profile-settings'
import { getTranslations } from '@/i18n/server'

interface PageProps {
  params: Promise<{ id: string }>
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings')
  return { title: t('project.nav.profile') }
}

/** Settings → Project profile: the brief and the standards it makes relevant. */
export default async function ProjectProfileSettingsPage({
  params,
}: PageProps): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    const { id } = await params
    await requireProjectAccess(session, id, 'project:view')

    const [data, access] = await Promise.all([
      getProjectOverviewData(id, session.organizationId),
      resolveProjectSettingsAccess(session, id),
    ])
    if (!data) notFound()

    return <ProfileSettings data={data} canEdit={access.editProfile} />
  })
}
