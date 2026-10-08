import type { JSX } from 'react'
import { type Metadata } from 'next'
import { notFound } from 'next/navigation'
import { withPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { isProjectKnowledgePageEnabled } from '@/lib/authz/feature-flags'
import { getProjectOverviewData } from '@/lib/projects/overview-query'
import { getHiddenFolderIds } from '@/lib/authz/folder-access'
import { listFoldersWithoutValidRole } from '@/lib/projects/folder-access-settings'
import { ProjectSettings } from '@/features/projects/components/project-settings'
import { getSteckbrief } from '@/lib/projects/steckbrief-service'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
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
  return withPageSession(async (session) => {
    const { id } = await params

    const { role, closed } = await requireProjectAccess(session, id, 'project:view')

    const data = await getProjectOverviewData(id, session.organizationId, {
      hiddenFolderIds: await getHiddenFolderIds(session, id),
    })
    if (!data) {
      notFound()
    }

    // A closed project's role is unchanged, but nothing it lets one change is
    // open (ADR-0089): only closing and reopening, and the members.
    const managesProject = role === 'project-admin'
    const canManageProject = managesProject && !closed
    // Folders whose roles were deleted since (ADR-0088). Asked only of a
    // project manager, who is the one who can set a role again.
    const foldersWithoutRole = canManageProject ? await listFoldersWithoutValidRole(session, id) : []
    const steckbrief = await getSteckbrief(session, id)
    // The organization's people, to link a Steckbrief person to their account;
    // asked only of someone who may edit it. Names only, never e-mail.
    const accounts = steckbrief.canEdit
      ? [...(await loadOrganizationDirectory(session.organizationId)).values()].map((person) => ({
          userId: person.userId,
          name: person.name,
        }))
      : []

    return (
      <ProjectSettings
        data={data}
        steckbrief={steckbrief}
        steckbriefAccounts={accounts}
        foldersWithoutRole={foldersWithoutRole}
        canManageProject={canManageProject}
        canManageMembers={managesProject}
        canChangeStatus={managesProject}
        // Knowledge left the top-level nav (spec §5) but stays reachable from
        // Settings while its feature flag is on.
        showKnowledgeLink={isProjectKnowledgePageEnabled(session)}
        // Same id space as the roster's `organizationMembershipId` (see
        // GridSession/AuthorizedSession) — lets the members form recognize the
        // signed-in user's own row and guard against self-lockout.
        currentMembershipId={session.organizationMembershipId}
        // The upload history links the reader's own uploads to their summaries.
        currentUserId={session.userId}
      />
    )
  })
}
