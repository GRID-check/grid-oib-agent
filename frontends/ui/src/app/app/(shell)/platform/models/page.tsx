/**
 * Platform → models. The fleet-wide default model AND thinking level per agent
 * group — one card, because they are two settings of the same decision.
 *
 * Owner gate, shell chrome and section nav live in the shared `layout.tsx`;
 * this page only names its section and renders it.
 */

import { PageHeader } from '@/components/ui/page-header'
import { getTranslations } from '@/i18n/server'
import { PlatformModelDefaults } from './platform-model-defaults'

export default async function PlatformModelsPage(): Promise<JSX.Element> {
  const t = await getTranslations('platform')

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('sections.models.title')} />
      <PlatformModelDefaults />
    </div>
  )
}
