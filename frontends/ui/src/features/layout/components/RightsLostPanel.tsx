'use client'

/**
 * What the thread area shows for a chat the reader may no longer read
 * (ADR-0087): a folder it drew on is no longer one of theirs, since it was
 * shared with them.
 *
 * It replaces the transcript and the composer. Nothing of the chat is rendered
 * and nothing is fetched for it: not its messages, cards or attachments, and
 * not its title, which is model-written from the content and so is replaced by
 * the neutral one. It never names the folder either: the reader may not be
 * cleared for it.
 */

import type { FC } from 'react'
import { Lock } from 'lucide-react'

import { EmptyState } from '@/components/ui/empty-state'
import { SectionLabel } from '@/components/ui/section-label'
import { useTranslations } from '@/i18n'

export const RightsLostPanel: FC = () => {
  const t = useTranslations('collaboration')
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4"
      data-testid="rights-lost"
    >
      <SectionLabel as="h2">{t('rightsLost.neutralTitle')}</SectionLabel>
      <EmptyState
        icon={Lock}
        tone="warning"
        title={t('rightsLost.title')}
        description={t('rightsLost.description')}
        className="max-w-md"
      />
    </div>
  )
}
