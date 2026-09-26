/**
 * Platform → cards. The agent's presentation vocabulary: every card type it can
 * render, shown rendered, with the values each one carries.
 *
 * Owner gate, shell chrome and section nav live in the shared `layout.tsx`;
 * this page only names its section and renders it.
 */

import type { JSX } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { getTranslations } from '@/i18n/server'
import { PlatformCards } from './platform-cards'

export default async function PlatformCardsPage(): Promise<JSX.Element> {
  const t = await getTranslations('platform')

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('sections.cards.title')} subtitle={t('sections.cards.subtitle')} />
      <PlatformCards />
    </div>
  )
}
