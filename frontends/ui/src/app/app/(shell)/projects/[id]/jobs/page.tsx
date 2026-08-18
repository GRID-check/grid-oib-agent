import { type Metadata } from 'next'
import { notFound } from 'next/navigation'
import { withPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { isSkillsEnabled } from '@/lib/authz/feature-flags'
import { findProjectInOrg } from '@/lib/projects/repository'
import { getTranslations } from '@/i18n/server'
import { JobsPanel } from '@/features/jobs/components/jobs-panel'

interface JobsPageProps {
  params: Promise<{ id: string }>
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('nav')
  return { title: t('sections.jobs') }
}

/**
 * Jobs — scheduled prompts for this project.
 *
 * Project-scoped where the skills toolbox is org-scoped, which is the whole
 * difference between the two tabs: a skill is a reusable instruction the
 * organization owns, a job is a prompt THIS project runs on a timer and may
 * attach a skill to.
 *
 * Gated on the same `skills` feature flag. The two surfaces ship together and
 * a job whose skill picker cannot resolve anything is not a half-feature worth
 * having, so they rise and fall as one.
 */
export default async function JobsPage({ params }: JobsPageProps): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    // 404 rather than a locked section, exactly like the skills page.
    if (!isSkillsEnabled(session)) {
      notFound()
    }
    const { id } = await params
    await requireProjectAccess(session, id, 'project:view')

    // The run history joins each run against the backend's research runs, and
    // that lookup is scoped by the project's Qdrant collection.
    const project = await findProjectInOrg(id, session.organizationId)
    if (!project) {
      notFound()
    }

    // Reading a job needs `project:view` (proved above); creating, editing,
    // running and deleting need `project:skills:manage`. Denial throws, so a
    // caught denial simply means the panel renders read-only.
    let canManage = false
    try {
      await requireProjectAccess(session, id, 'project:skills:manage')
      canManage = true
    } catch {
      // Read-only. Mutations are gated again server-side at every route.
    }

    return (
      <JobsPanel
        projectId={id}
        projectCollection={project.collectionName}
        canManage={canManage}
      />
    )
  })
}
