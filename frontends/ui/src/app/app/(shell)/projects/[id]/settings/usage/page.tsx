import type { JSX } from 'react'
import { type Metadata } from 'next'
import { notFound } from 'next/navigation'
import { withPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getProjectUsage } from '@/lib/budgets/service'
import { resolveProjectSettingsAccess } from '@/lib/projects/settings-access'
import { UsageSettings } from '@/features/projects/components/settings/usage-settings'
import { getTranslations } from '@/i18n/server'

interface PageProps {
  params: Promise<{ id: string }>
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings')
  return { title: t('project.nav.usage') }
}

/**
 * Settings → Usage & budget. Open to whoever may set the project's limit: its
 * admins and the organization's budget admins (`saveBudgetPolicy`). Everyone
 * else gets a 404, as for any section the nav does not offer them.
 */
export default async function ProjectUsageSettingsPage({
  params,
}: PageProps): Promise<JSX.Element> {
  return withPageSession(async (session) => {
    const { id } = await params
    await requireProjectAccess(session, id, 'project:view')

    const access = await resolveProjectSettingsAccess(session, id)
    if (!access.manageBudget) notFound()

    const usage = await getProjectUsage(session, id)

    return <UsageSettings projectId={id} usage={usage} canEditLimit={access.manageBudget} />
  })
}
