import type { JSX } from 'react'
import { type Metadata } from 'next'
import { notFound } from 'next/navigation'
import { withPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { can } from '@/lib/authz/decide'
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
 * derived role, matching the old pages exactly. The E-Mail-Eingang section is
 * gated on document write, the permission its API enforces.
 */
export default async function ProjectSettingsPage({ params }: ProjectSettingsPageProps): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    const { id } = await params

    const { role } = await requireProjectAccess(session, id, 'project:view')

    // Document write is asked as the permission (any-of the ADR-0038 umbrella),
    // not read off the derived role: `project-editor` also means "holds only
    // `project:memory:write`", and that caller may not see the mail address.
    const project = { type: 'project', id } as const
    const [data, writesDocuments, editsProject] = await Promise.all([
      getProjectOverviewData(id, session.organizationId),
      can(session, 'project:documents:write', project),
      can(session, 'project:edit', project),
    ])
    if (!data) {
      notFound()
    }

    return (
      <ProjectSettings
        data={data}
        canManageProject={role === 'project-admin'}
        canWriteDocuments={writesDocuments || editsProject}
        // Knowledge left the top-level nav (spec §5) but stays reachable from
        // Settings while its feature flag is on.
        showKnowledgeLink={isProjectKnowledgePageEnabled(session)}
        // Same id space as the roster's `organizationMembershipId` (see
        // GridSession/AuthorizedSession) — lets the members form recognize the
        // signed-in user's own row and guard against self-lockout.
        currentMembershipId={session.organizationMembershipId}
      />
    )
  })
}
