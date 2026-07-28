/**
 * Platform → quality. Answer quality: citation health, then the per-turn execution timeline behind it.
 *
 * Owner gate, shell chrome and section nav live in the shared `layout.tsx`;
 * this page only names its section and renders it.
 */

import { PageHeader } from '@/components/ui/page-header'
import { getTranslations } from '@/i18n/server'
import { CitationHealth } from '@/features/platform/components/citation-health'
import { AgentProfiler } from '@/features/platform/components/agent-profiler'

export default async function PlatformQualityPage(): Promise<JSX.Element> {
  const t = await getTranslations('platform')

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('sections.quality.title')} subtitle={t('sections.quality.subtitle')} />
      <CitationHealth />
      <AgentProfiler />
    </div>
  )
}
