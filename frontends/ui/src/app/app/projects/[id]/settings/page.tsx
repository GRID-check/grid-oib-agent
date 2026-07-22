import { type Metadata } from 'next'
import { notFound } from 'next/navigation'
import { requireAuthorizedPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { isProjectKnowledgePageEnabled } from '@/lib/authz/feature-flags'
import { getProjectOverviewData } from '@/lib/projects/overview-query'
import { ProjectSettings } from '@/features/projects/components/project-settings'
import { getTranslations } from '@/i18n/server'

interface ProjectSettingsPageProps {
  params: Promise<{ id: string }>
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('nav')
  return { title: t('sections.settings') }
}

/**
 * Project Settings (spec §5, FB-9) — consolidates what used to live on the
 * Overview and Members pages: project parameters (intake brief + applicable
 * standards), the member roster, project memory, an insights placeholder, and
 * the danger zone.
 *
 * View access gates the page (same guard the layout applies); manager-only
 * affordances (member management, rename, danger zone) are gated by the
 * derived role, matching the old pages exactly.
 */
export default async function ProjectSettingsPage({ params }: ProjectSettingsPageProps): Promise<JSX.Element> {
  const session = await requireAuthorizedPageSession()
  const { id } = await params

  const { role } = await requireProjectAccess(session, id, 'project:view')

  const data = await getProjectOverviewData(id, session.organizationId)
  if (!data) {
    notFound()
  }

  return (
    <ProjectSettings
      data={data}
      canManageProject={role === 'project-admin'}
      // Knowledge left the top-level nav (spec §5) but stays reachable from
      // Settings while its feature flag is on.
      showKnowledgeLink={isProjectKnowledgePageEnabled(session)}
      // Same id space as the roster's `organizationMembershipId` (see
      // GridSession/AuthorizedSession) — lets the members form recognize the
      // signed-in user's own row and guard against self-lockout.
      currentMembershipId={session.organizationMembershipId}
    />
  )
}
