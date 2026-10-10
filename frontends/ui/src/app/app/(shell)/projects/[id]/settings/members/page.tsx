import type { JSX } from 'react'
import { type Metadata } from 'next'
import { notFound } from 'next/navigation'
import { withPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { resolveProjectSettingsAccess } from '@/lib/projects/settings-access'
import { MembersSettings } from '@/features/projects/components/settings/members-settings'
import { getTranslations } from '@/i18n/server'

interface PageProps {
  params: Promise<{ id: string }>
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings')
  return { title: t('project.nav.members') }
}

/**
 * Settings → Members. 404 without roster access, like every section a reader
 * cannot use: the roster endpoint would refuse them anyway.
 */
export default async function ProjectMembersSettingsPage({
  params,
}: PageProps): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    const { id } = await params
    await requireProjectAccess(session, id, 'project:view')

    const access = await resolveProjectSettingsAccess(session, id)
    if (!access.manageMembers) notFound()

    return (
      <MembersSettings
        projectId={id}
        // Same id space as the roster's `organizationMembershipId`: lets the
        // form recognize the reader's own row and guard against self-lockout.
        currentMembershipId={session.organizationMembershipId}
      />
    )
  })
}
