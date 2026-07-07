'use client'

import Link from 'next/link'
import { ClipboardCheck, ExternalLink, MessageSquareText } from 'lucide-react'
import type { ApplicableStandard, ApplicableStatus } from '@/lib/oib/applicable-standards'
import { Stagger, StaggerItem } from '@/components/motion'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { useTranslations, type Translator } from '@/i18n'

interface ApplicableStandardsProps {
  projectId: string
  standards: ApplicableStandard[]
  /** Whether the project brief has enough facts to tailor applicability. */
  briefComplete: boolean
}

type BadgeVariant = 'info' | 'secondary' | 'warning'

/** Map an applicability verdict to the design-language badge token. */
function statusVariant(status: ApplicableStatus): BadgeVariant {
  switch (status) {
    case 'required':
      return 'info'
    case 'check':
      return 'warning'
    case 'likely':
    default:
      return 'secondary'
  }
}

function statusLabel(status: ApplicableStatus, t: Translator): string {
  if (status === 'required' || status === 'check' || status === 'likely') {
    return t(`applicableStandards.status.${status}`)
  }
  const fallback = String(status)
  return fallback.charAt(0).toUpperCase() + fallback.slice(1)
}

/** Build the deep link that prefills the chat composer with a question about a Richtlinie. */
function askGridHref(projectId: string, standard: ApplicableStandard, t: Translator): string {
  const question = t('applicableStandards.askQuestion', {
    code: standard.code,
    title: standard.titleEn,
  })
  return `/app/projects/${projectId}/chat?ask=${encodeURIComponent(question)}`
}

/**
 * Compliance-orientation panel: which OIB-Richtlinien are relevant to this
 * project, derived from the brief, each with a project-grounded reason, a link to
 * the source, and an "Ask Grid" action. Server-renderable (no client hooks).
 */
export function ApplicableStandards({ projectId, standards, briefComplete }: ApplicableStandardsProps) {
  const t = useTranslations('projects')
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
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
                <Badge variant="outline" className="mt-0.5 shrink-0 font-mono">
                  {standard.code}
                </Badge>
                <div className="min-w-0">
                  <p className="text-sm font-medium">{standard.titleEn}</p>
                  <p className="text-xs text-muted-foreground">{standard.titleDe}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{standard.reason}</p>
                </div>
              </div>

              {/* Right: status + quiet actions */}
              <div className="flex shrink-0 items-center gap-3 sm:pt-0.5">
                <Badge variant={statusVariant(standard.status)}>{statusLabel(standard.status, t)}</Badge>
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
                  href={askGridHref(projectId, standard, t)}
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
