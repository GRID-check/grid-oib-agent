/**
 * Platform → retrieval. The fleet-wide retrieval counts (chunks/results per
 * search) the backend tools fetch and merge.
 *
 * Owner gate, shell chrome and section nav live in the shared `layout.tsx`;
 * this page only names its section and renders it.
 */

import { PageHeader } from '@/components/ui/page-header'
import { getTranslations } from '@/i18n/server'
import { PlatformRetrievalSettings } from './platform-retrieval-settings'

export default async function PlatformRetrievalPage(): Promise<JSX.Element> {
  const t = await getTranslations('platform')

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('sections.retrieval.title')} subtitle={t('sections.retrieval.subtitle')} />
      <PlatformRetrievalSettings />
    </div>
  )
}
