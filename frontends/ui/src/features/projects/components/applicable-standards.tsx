'use client'

import Link from 'next/link'
import { ClipboardCheck, ExternalLink, MessageSquareText } from 'lucide-react'
import type { ApplicableStandard, ApplicableStatus } from '@/lib/oib/applicable-standards'
import { Stagger, StaggerItem } from '@/components/motion'
import { Chip } from '@/components/ui/chip'
import { EmptyState } from '@/components/ui/empty-state'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemList,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item'
import { useLocale, useTranslations, type Locale, type Translator } from '@/i18n'
import { ApplicabilityChip, OibCodeChip } from './standard-chips'

interface ApplicableStandardsProps {
  projectId: string
  standards: ApplicableStandard[]
  /** Whether the project brief has enough facts to tailor applicability. */
  briefComplete: boolean
}

/** The localized verdict label ("required" -> "Required" / "Erforderlich"). */
function statusLabel(status: ApplicableStatus, t: Translator): string {
  if (status === 'required' || status === 'check' || status === 'likely') {
    return t(`applicableStandards.status.${status}`)
  }
  const fallback = String(status)
  return fallback.charAt(0).toUpperCase() + fallback.slice(1)
}

/**
 * The title Austrian users reason in: German OIB terminology under the DE
 * locale, English otherwise.
 */
function primaryTitle(standard: ApplicableStandard, locale: Locale): string {
  return locale === 'de' ? standard.titleDe : standard.titleEn
}

/** Build the deep link that prefills the chat composer with a question about a Richtlinie. */
function askGridHref(
  projectId: string,
  standard: ApplicableStandard,
  locale: Locale,
  t: Translator
): string {
  const question = t('applicableStandards.askQuestion', {
    code: standard.code,
    title: primaryTitle(standard, locale),
  })
  return `/app/projects/${projectId}/chat?ask=${encodeURIComponent(question)}`
}

/**
 * Compliance-orientation panel: which OIB-Richtlinien are relevant to this
 * project, derived from the brief, each with a project-grounded reason, a link to
 * the source, and an "Ask Piloti" action.
 */
export function ApplicableStandards({
  projectId,
  standards,
  briefComplete,
}: ApplicableStandardsProps) {
  const t = useTranslations('projects')
  const { locale } = useLocale()
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-foreground text-sm font-semibold">
          {t('applicableStandards.heading')}
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">{t('applicableStandards.description')}</p>
        {!briefComplete && (
          <p className="text-muted-foreground mt-1 text-xs">
            {t('applicableStandards.briefIncomplete')}
          </p>
        )}
      </div>

      {standards.length > 0 ? (
        <Stagger>
          <ItemList>
            {standards.map((standard) => (
              <StaggerItem key={standard.code}>
                <Item className="items-start max-sm:flex-col max-sm:items-stretch">
                  <ItemMedia className="size-auto">
                    <OibCodeChip code={standard.code} className="mt-0.5" />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle className="whitespace-normal">
                      {locale === 'de' ? standard.titleDe : standard.titleEn}
                    </ItemTitle>
                    <ItemDescription className="whitespace-normal">
                      {locale === 'de' ? standard.titleEn : standard.titleDe}
                    </ItemDescription>
                    <p className="text-muted-foreground mt-1 text-xs">{standard.reason}</p>
                  </ItemContent>
                  <ItemActions className="gap-3 max-sm:ml-0">
                    <ApplicabilityChip
                      status={standard.status}
                      label={statusLabel(standard.status, t)}
                    />
                    <Chip asChild interactive variant="outline" size="sm">
                      <a
                        href={standard.oibUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={t('applicableStandards.sourceAria', { code: standard.code })}
                        title={t('applicableStandards.sourceTitle')}
                      >
                        <ExternalLink aria-hidden />
                        {t('applicableStandards.source')}
                      </a>
                    </Chip>
                    <Chip asChild interactive variant="outline" size="sm">
                      <Link
                        href={askGridHref(projectId, standard, locale, t)}
                        aria-label={t('applicableStandards.askGridAria', { code: standard.code })}
                        title={t('applicableStandards.askGridTitle')}
                      >
                        <MessageSquareText aria-hidden />
                        {t('applicableStandards.askGrid')}
                      </Link>
                    </Chip>
                  </ItemActions>
                </Item>
              </StaggerItem>
            ))}
          </ItemList>
        </Stagger>
      ) : (
        <EmptyState
          icon={ClipboardCheck}
          title={t('applicableStandards.emptyTitle')}
          description={t('applicableStandards.emptyDescription')}
        />
      )}

      <p className="text-muted-foreground text-xs">{t('applicableStandards.disclaimer')}</p>
    </section>
  )
}
