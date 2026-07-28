/**
 * Platform → workflows. Workflow templates published into every organization’s gallery.
 *
 * Owner gate, shell chrome and section nav live in the shared `layout.tsx`;
 * this page only names its section and renders it.
 */

import { PageHeader } from '@/components/ui/page-header'
import { getTranslations } from '@/i18n/server'
import { WorkflowTemplates } from '@/features/platform/components/workflow-templates'

export default async function PlatformWorkflowsPage(): Promise<JSX.Element> {
  const t = await getTranslations('platform')

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('sections.workflows.title')} subtitle={t('sections.workflows.subtitle')} />
      <WorkflowTemplates />
    </div>
  )
}
