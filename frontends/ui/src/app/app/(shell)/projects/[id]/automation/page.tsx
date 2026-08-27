import { type Metadata } from 'next'
import { notFound } from 'next/navigation'
import { withPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { canManageSkills } from '@/lib/authz/organizations'
import { isSkillsEnabled } from '@/lib/authz/feature-flags'
import { findProjectInOrg } from '@/lib/projects/repository'
import { getTranslations } from '@/i18n/server'
import { AutomationPanel, parseAutomationTab } from '@/features/automation/components/automation-panel'

interface AutomationPageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string }>
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('nav')
  return { title: t('sections.automation') }
}

/**
 * Automation — the merged home of Jobs and Skills, as tabs (`?tab=jobs|skills`).
 *
 * Jobs is project-scoped (a prompt THIS project runs on a timer, run history
 * joined against the project's Qdrant collection); Skills is the org toolbox
 * reached through the project. The section carries both authorizations
 * separately: `project:skills:manage` gates job mutations, `org:skills:manage`
 * gates skill mutations, and reading either needs only `project:view`.
 *
 * Gated on the `skills` feature flag as one unit — the two surfaces ship
 * together, and a job builder whose skill picker resolves nothing is not a
 * half-feature worth having. 404 rather than a locked section, like every
 * dark-launched surface.
 */
export default async function AutomationPage({
  params,
  searchParams,
}: AutomationPageProps): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    if (!isSkillsEnabled(session)) {
      notFound()
    }
    const { id } = await params
    const { tab } = await searchParams
    await requireProjectAccess(session, id, 'project:view')

    const project = await findProjectInOrg(id, session.organizationId)
    if (!project) {
      notFound()
    }

    // Reading needs `project:view` (proved above); job mutations need
    // `project:skills:manage`. Denial throws, so a caught denial simply means
    // the Jobs tab renders read-only. Mutations are gated again server-side at
    // every route.
    let canManageJobs = false
    try {
      await requireProjectAccess(session, id, 'project:skills:manage')
      canManageJobs = true
    } catch {
      // Read-only.
    }

    return (
      <AutomationPanel
        projectId={id}
        projectCollection={project.collectionName}
        canManageOrgSkills={canManageSkills(session)}
        canManageJobs={canManageJobs}
        initialTab={parseAutomationTab(tab)}
      />
    )
  })
}
