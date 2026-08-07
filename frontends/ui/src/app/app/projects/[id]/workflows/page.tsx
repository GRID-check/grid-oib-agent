import { type Metadata } from 'next'
import { notFound } from 'next/navigation'
import { requireAuthorizedPageSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { isWorkflowsEnabled } from '@/lib/authz/feature-flags'
import { findProjectInOrg } from '@/lib/projects/repository'
import { getTranslations } from '@/i18n/server'
import { WorkflowsPanel } from '@/features/workflows/components/workflows-panel'

interface WorkflowsPageProps {
  params: Promise<{ id: string }>
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('nav')
  return { title: t('sections.workflows') }
}

export default async function WorkflowsPage({ params }: WorkflowsPageProps): Promise<JSX.Element> {
  const session = await requireAuthorizedPageSession()
  // Feature-flagged rollout (default off): the page 404s like it doesn't
  // exist rather than teasing a locked section — mirrors the knowledge page.
  if (!isWorkflowsEnabled(session)) {
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

  return <WorkflowsPanel projectId={id} projectCollection={project.collectionName} />
}
