/**
 * Platform → knowledge. The shared OIB corpus every project grounds its answers on.
 *
 * Owner gate, shell chrome and section nav live in the shared `layout.tsx`;
 * this page only names its section and renders it.
 */

import type { JSX } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { getTranslations } from '@/i18n/server'
import { BaseKnowledge } from '../base-knowledge'

export default async function PlatformKnowledgePage(): Promise<JSX.Element> {
  const t = await getTranslations('platform')

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('sections.knowledge.title')} subtitle={t('sections.knowledge.subtitle')} />
      <BaseKnowledge />
    </div>
  )
}
