/**
 * Platform → Lessons. The fleet-wide register of anonymized lessons distilled
 * from user down-votes — automatic, auditable, and framed as the symptomatic
 * bandage it is (docs/architecture/platform-failure-learning.md).
 *
 * Owner gate, shell chrome and section nav live in the shared `layout.tsx`;
 * this page only names its section and renders it.
 */

import type { JSX } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { getTranslations } from '@/i18n/server'
import { PlatformLessons } from './platform-lessons'

export default async function PlatformLessonsPage(): Promise<JSX.Element> {
  const t = await getTranslations('platform')

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('sections.lessons.title')} subtitle={t('sections.lessons.subtitle')} />
      <PlatformLessons />
    </div>
  )
}
