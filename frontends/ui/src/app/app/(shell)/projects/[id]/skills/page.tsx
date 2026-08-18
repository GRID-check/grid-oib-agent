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

    // The project still has to EXIST and be reachable — you get to a project's
    // skills through the project — but nothing on this page is project-scoped
    // any more. Scheduling moved to the Jobs tab and took the project
    // permission and the collection lookup with it; the toolbox is an ORG
    // surface, gated by org:skills:manage alone.
    if (!(await findProjectInOrg(id, session.organizationId))) {
      notFound()
    }

    return <SkillsPanel canManageOrgSkills={canManageSkills(session)} />
  })
}
