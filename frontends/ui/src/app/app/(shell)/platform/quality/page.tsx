/**
 * Platform → quality. Answer quality from three angles: how well answers were
 * grounded (citation health), what users thought of them (answer feedback), and
 * the per-turn execution timeline behind any turn that was not.
 *
 * Owner gate, shell chrome and section nav live in the shared `layout.tsx`;
 * this page only names its section and renders it.
 */

import { PageHeader } from '@/components/ui/page-header'
import { getTranslations } from '@/i18n/server'
import { CitationHealth } from '@/features/platform/components/citation-health'
import { AgentProfiler } from '@/features/platform/components/agent-profiler'
import { AnswerFeedbackHealth } from '@/features/platform/components/answer-feedback-health'

export default async function PlatformQualityPage(): Promise<JSX.Element> {
  const t = await getTranslations('platform')

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('sections.quality.title')} subtitle={t('sections.quality.subtitle')} />
      <CitationHealth />
      {/* What the people who read the answers thought — the other half of
          'answer quality', and until now the half nobody could see. */}
      <AnswerFeedbackHealth />
      <AgentProfiler />
    </div>
  )
}
