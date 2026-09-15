import { type Metadata } from 'next'
import { notFound } from 'next/navigation'
import { withPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { CHAT_PERMISSIONS } from '@/lib/authz/chat'
import { canManageSkills } from '@/lib/authz/organizations'
import { isSkillsEnabled } from '@/lib/authz/feature-flags'
import { findProjectInOrg } from '@/lib/projects/repository'
import { getTranslations } from '@/i18n/server'
import { AutomationPanel } from '@/features/automation/components/automation-panel'
import { parseAutomationTab } from '@/features/automation/lib/automation-tab'
import { parseTasksView } from '@/features/tasks/lib/tasks-view'

interface AutomationPageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string; view?: string }>
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('nav')
  return { title: t('sections.automation') }
}

/**
 * Automation — Tasks and Skills as tabs (`?tab=tasks|skills`), with the tasks
 * VIEW on `?view=list|timetable`.
 *
 * Tasks is project-scoped (what Piloti did and what it will do: runs plus the
 * standing arrangements behind them, run history joined against the project's
 * Qdrant collection); Skills is the org toolbox reached through the project.
 * The section carries both authorizations separately: `project:skills:manage`
 * gates task mutations, `org:skills:manage` gates skill mutations, and reading
 * either needs only `project:view`.
 *
 * A legacy `?tab=schedule` link lands on the Tasks tab showing the timetable
 * view — the scheduled tasks it always meant. Gated on the `skills` feature
 * flag as one unit — the two surfaces ship together, and a task builder whose
 * skill picker resolves nothing is not a half-feature worth having. 404 rather
 * than a locked section, like every dark-launched surface.
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
    const { tab, view } = await searchParams
    await requireProjectAccess(session, id, 'project:view')

    const project = await findProjectInOrg(id, session.organizationId)
    if (!project) {
      notFound()
    }

    // Reading needs `project:view` (proved above); schedule mutations need
    // `project:skills:manage`. Denial throws, so a caught denial simply means
    // the schedules render read-only. Mutations are gated again server-side at
    // every route.
    let canManageJobs = false
    try {
      await requireProjectAccess(session, id, 'project:skills:manage')
      canManageJobs = true
    } catch {
      // Read-only.
    }

    // Delegieren links into the project chat, whose composer is locked without
    // `project:chat` — resolved here because the authz modules are
    // `server-only`, and forwarded so Aufgaben disables the link with the
    // locked composer's own reason instead of landing a reader in a dead end.
    // Fail-closed like the chat page: a denial (or an FGA outage, which reads
    // as a denial) locks the affordance; the server still enforces on send.
    let canChatInProject = false
    try {
      await requireProjectAccess(session, id, CHAT_PERMISSIONS)
      canChatInProject = true
    } catch {
      // Read-only chat.
    }

    // A legacy `?tab=schedule` link without an explicit view meant the
    // scheduled tasks: open the timetable view for it.
    const initialView = tab === 'schedule' && !view ? 'timetable' : parseTasksView(view)
    return (
      <AutomationPanel
        projectId={id}
        projectCollection={project.collectionName}
        canManageOrgSkills={canManageSkills(session)}
        canManageJobs={canManageJobs}
        canChatInProject={canChatInProject}
        initialTab={parseAutomationTab(tab)}
        initialView={initialView}
      />
    )
  })
}
