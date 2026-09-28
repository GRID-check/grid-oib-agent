/**
 * Platform → norms. The curated norm catalog: which legal sources bind, and where they live in RIS.
 *
 * Owner gate, shell chrome and section nav live in the shared `layout.tsx`;
 * this page only names its section and renders it.
 */

import type { JSX } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { getTranslations } from '@/i18n/server'
import { NormRegistry } from '@/features/platform/components/norm-registry'

export default async function PlatformNormsPage(): Promise<JSX.Element> {
  const t = await getTranslations('platform')

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('sections.norms.title')} subtitle={t('sections.norms.subtitle')} />
      <NormRegistry />
    </div>
  )
}
