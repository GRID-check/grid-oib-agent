import { type Metadata } from 'next'
import { notFound } from 'next/navigation'
import { withPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { canManageSkills } from '@/lib/authz/organizations'
import { isSkillsEnabled } from '@/lib/authz/feature-flags'
import { findProjectInOrg } from '@/lib/projects/repository'
import { getTranslations } from '@/i18n/server'
import { SkillsPanel } from '@/features/skills/components/skills-panel'

interface SkillsPageProps {
  params: Promise<{ id: string }>
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('nav')
  return { title: t('sections.skills') }
}

export default async function SkillsPage({ params }: SkillsPageProps): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    // Feature-flagged rollout (default off): the page 404s like it doesn't
    // exist rather than teasing a locked section — mirrors the workflows page.
    if (!isSkillsEnabled(session)) {
      notFound()
    }
    const { id } = await params
    await requireProjectAccess(session, id, 'project:view')

    // The run history scopes its live job-status lookup to this project's
    // collection — the same lookup the History page performs.
    const project = await findProjectInOrg(id, session.organizationId)

    if (!project) {
      notFound()
    }

    // Schedule management (project:skills:manage) and org skill authoring
    // (org:skills:manage) are independent permissions; derive each capability
    // for the panel. requireProjectAccess answers whether the caller holds a
    // permission — denial throws, so a denial means "read-only" here.
    let canManageProjectSkills = false
    try {
      await requireProjectAccess(session, id, 'project:skills:manage')
      canManageProjectSkills = true
    } catch {
      // schedule mutations are gated in the UI; reads stay open.
    }

    return (
      <SkillsPanel
        projectId={id}
        projectCollection={project.collectionName}
        canManageOrgSkills={canManageSkills(session)}
        canManageProjectSkills={canManageProjectSkills}
      />
    )
  })
}