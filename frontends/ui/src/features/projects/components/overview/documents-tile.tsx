'use client'

import type { JSX } from 'react'
import { FileText } from 'lucide-react'
import { BentoFigure, BentoTile, type BentoSpan } from '@/components/ui/bento'
import { TimeAgo } from '@/components/ui/time-ago'
import { useLocale, useTranslations } from '@/i18n'
import { formatBytes } from '@/lib/format'
import type { OverviewDocument } from '../../types'

/** How many documents, how much they weigh, and the newest three. */
export function DocumentsTile({
  documentCount,
  totalFileSize,
  recent,
  href,
  span = 'small',
}: {
  documentCount: number
  totalFileSize: number
  recent: readonly OverviewDocument[]
  href: string
  span?: BentoSpan
}): JSX.Element {
  const t = useTranslations('settings')
  const { locale } = useLocale()

  return (
    <BentoTile
      label={t('project.overview.documents.label')}
      icon={FileText}
      tone="project"
      span={span}
      href={href}
      linkLabel={t('project.overview.documents.open')}
      data-testid="overview-documents"
    >
      <BentoFigure
        value={documentCount.toLocaleString(locale)}
        caption={t('project.overview.documents.storage', {
          size: formatBytes(totalFileSize, locale),
        })}
      />
      {recent.length > 0 ? (
        <ul className="flex flex-col gap-1.5 text-sm">
          {recent.slice(0, 3).map((doc) => (
            <li key={doc.id} className="flex min-w-0 items-baseline justify-between gap-3">
              <span className="min-w-0 truncate">{doc.filename}</span>
              <TimeAgo
                date={new Date(doc.createdAt).toISOString()}
                locale={locale}
                className="text-muted-foreground shrink-0 text-xs"
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">{t('project.overview.documents.empty')}</p>
      )}
    </BentoTile>
  )
}
