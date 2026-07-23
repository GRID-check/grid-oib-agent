'use client'

import Link from 'next/link'
import { ClipboardCheck, ExternalLink, MessageSquareText } from 'lucide-react'
import type { ApplicableStandard, ApplicableStatus } from '@/lib/oib/applicable-standards'
import { Stagger, StaggerItem } from '@/components/motion'
import { EmptyState } from '@/components/ui/empty-state'
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
function askGridHref(projectId: string, standard: ApplicableStandard, locale: Locale, t: Translator): string {
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
export function ApplicableStandards({ projectId, standards, briefComplete }: ApplicableStandardsProps) {
  const t = useTranslations('projects')
  const { locale } = useLocale()
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-foreground">
          {t('applicableStandards.heading')}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('applicableStandards.description')}
        </p>
        {!briefComplete && (
          <p className="mt-1 text-xs text-muted-foreground">
            {t('applicableStandards.briefIncomplete')}
          </p>
        )}
      </div>

      {standards.length > 0 ? (
        <Stagger className="divide-y divide-border overflow-hidden rounded-2xl border bg-card shadow-xs">
          {standards.map((standard) => (
            <StaggerItem
              key={standard.code}
              className="flex flex-col gap-3 px-6 py-4 transition-colors duration-200 ease-out hover:bg-accent/40 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
            >
              {/* Left: code + title + reason */}
              <div className="flex min-w-0 gap-3">
                <OibCodeChip code={standard.code} className="mt-0.5" />
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {locale === 'de' ? standard.titleDe : standard.titleEn}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {locale === 'de' ? standard.titleEn : standard.titleDe}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">{standard.reason}</p>
                </div>
              </div>

              {/* Right: status + quiet actions */}
              <div className="flex shrink-0 items-center gap-3 sm:pt-0.5">
                <ApplicabilityChip
                  status={standard.status}
                  label={statusLabel(standard.status, t)}
                />
                <a
                  href={standard.oibUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                  aria-label={t('applicableStandards.sourceAria', { code: standard.code })}
                  title={t('applicableStandards.sourceTitle')}
                >
                  <ExternalLink className="size-3.5" aria-hidden />
                  {t('applicableStandards.source')}
                </a>
                <Link
                  href={askGridHref(projectId, standard, locale, t)}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                  aria-label={t('applicableStandards.askGridAria', { code: standard.code })}
                  title={t('applicableStandards.askGridTitle')}
                >
                  <MessageSquareText className="size-3.5" aria-hidden />
                  {t('applicableStandards.askGrid')}
                </Link>
              </div>
            </StaggerItem>
          ))}
        </Stagger>
      ) : (
        <EmptyState
          icon={ClipboardCheck}
          title={t('applicableStandards.emptyTitle')}
          description={t('applicableStandards.emptyDescription')}
        />
      )}

      <p className="text-xs text-muted-foreground">{t('applicableStandards.disclaimer')}</p>
    </section>
  )
}
