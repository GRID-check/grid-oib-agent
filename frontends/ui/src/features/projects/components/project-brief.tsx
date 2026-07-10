'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { CircleHelp, ClipboardList, PencilLine, Sparkles } from 'lucide-react'
import { buildProjectBriefView } from '@/lib/project-profile/brief-view'
import type { BriefAssumption } from '@/lib/project-profile/brief-view'
import type { ProjectProfile } from '@/lib/project-profile/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { useTranslations } from '@/i18n'

interface ProjectBriefProps {
  projectId: string
  /** Raw structured profile; the fact sheet is derived from it at render time. */
  profile: ProjectProfile | null
  /** AI-generated prose from profile_display (generated separately, async). */
  summary?: string
  /** Whether the brief was ever set up (profile_display exists). */
  briefStarted: boolean
}

/** Fact sources with a localized provenance tooltip (under overview.brief.provenance). */
const PROVENANCE_SOURCES = new Set(['onboarding', 'user_confirmed', 'admin_edit'])

/**
 * Project Brief — the architect-owned context Grid works from. Renders the
 * intake profile as a grouped, human-readable fact sheet: prose summary, focus
 * areas, facts by intake stage, Grid-suggested assumptions awaiting
 * confirmation, and what Grid still doesn't know.
 */
export function ProjectBrief({ projectId, profile, summary, briefStarted }: ProjectBriefProps) {
  const t = useTranslations('projects')
  const intakeHref = `/app/projects/${projectId}/intake`

  if (!briefStarted) {
    return (
      <EmptyState
        icon={ClipboardList}
        title={t('overview.brief.emptyTitle')}
        description={t('overview.brief.emptyDescription')}
        action={
          <Button asChild>
            <Link href={intakeHref}>{t('overview.brief.emptyAction')}</Link>
          </Button>
        }
      />
    )
  }

  const brief = buildProjectBriefView(profile)
  const prose = summary?.trim()
  const hasFacts = brief.answeredCount > 0

  return (
    <section className="rounded-2xl border bg-card p-6 shadow-sm">
      {/* Header: eyebrow + completeness + edit */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h2 className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          {t('overview.brief.heading')}
        </h2>
        <div className="flex items-center gap-4">
          {brief.totalCount > 0 && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {t('overview.brief.captured', {
                answered: String(brief.answeredCount),
                total: String(brief.totalCount),
              })}
            </span>
          )}
          <Link
            href={intakeHref}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <PencilLine className="size-3.5" aria-hidden />
            {t('overview.brief.edit')}
          </Link>
        </div>
      </div>

      {/* AI summary prose */}
      {prose && <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{prose}</p>}

      {/* Focus areas the architect selected for Grid */}
      {brief.focusAreas.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-muted-foreground">{t('overview.brief.focus')}</span>
          {brief.focusAreas.map((area) => (
            <Badge key={area} variant="secondary">
              {area}
            </Badge>
          ))}
          {brief.goalDetails && (
            <span className="basis-full text-xs text-muted-foreground">{brief.goalDetails}</span>
          )}
        </div>
      )}

      {/* Fact sheet, grouped by intake stage */}
      {hasFacts ? (
        <div className="mt-5 space-y-5">
          {brief.groups.map((group) => (
            <div key={group.id}>
              <h3 className="text-xs font-medium text-muted-foreground/80">{group.title}</h3>
              <dl className="mt-2 grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3">
                {group.facts.map((fact) => (
                  <div key={fact.key}>
                    <dt className="text-xs text-muted-foreground">{fact.label}</dt>
                    <dd
                      className="mt-0.5 text-sm font-medium"
                      title={
                        PROVENANCE_SOURCES.has(fact.source)
                          ? t(`overview.brief.provenance.${fact.source}`)
                          : fact.source
                      }
                    >
                      {fact.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          {t('overview.brief.startedNoDetailsBefore')}
          <Link href={intakeHref} className="font-medium text-foreground underline-offset-4 hover:underline">
            {t('overview.brief.completeBrief')}
          </Link>
          {t('overview.brief.startedNoDetailsAfter')}
        </p>
      )}

      {/* Grid-suggested assumptions awaiting the architect's confirmation */}
      {brief.assumptions.length > 0 && (
        <AssumptionsBlock projectId={projectId} assumptions={brief.assumptions} />
      )}

      {/* What Grid still doesn't know — each gap links back into the wizard */}
      {brief.missing.length > 0 && (
        <div className="mt-5 border-t pt-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
              <CircleHelp className="size-3.5" aria-hidden />
              {t('overview.brief.missingHeading')}
            </span>
            {brief.missing.map((item) => (
              <Link
                key={item.key}
                href={intakeHref}
                className="rounded-md border border-dashed px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-solid hover:text-foreground"
              >
                {item.label}
              </Link>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

/**
 * Unconfirmed values Grid proposed for this project. Confirming graduates the
 * assumption into a hard fact (source `user_confirmed`); dismissing removes it.
 * Both go through the same profile-patch endpoint the agent's patch cards use.
 */
function AssumptionsBlock({ projectId, assumptions }: { projectId: string; assumptions: BriefAssumption[] }) {
  const t = useTranslations('projects')
  const router = useRouter()
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const resolve = async (assumption: BriefAssumption, confirmed: boolean) => {
    setBusyKey(assumption.key)
    setError(null)
    try {
      // Write the machine value ("wohnen"), not the display label; the patches
      // endpoint wraps it with `user_confirmed` provenance server-side.
      const patch = confirmed
        ? [
            { op: 'add', path: `/facts/${assumption.key}`, value: assumption.rawValue },
            { op: 'remove', path: `/assumptions/${assumption.key}` },
          ]
        : [{ op: 'remove', path: `/assumptions/${assumption.key}` }]
      const res = await fetch(`/api/projects/${projectId}/profile/patches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patch }),
      })
      if (!res.ok) throw new Error()
      router.refresh()
    } catch {
      setError(t('overview.brief.assumptionError'))
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <div className="mt-5 border-t pt-4">
      <h3 className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
        <Sparkles className="size-3.5" aria-hidden />
        {t('overview.brief.assumptionsHeading')}
      </h3>
      <ul className="mt-2 space-y-2">
        {assumptions.map((assumption) => (
          <li key={assumption.key} className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm">
                <span className="text-muted-foreground">{assumption.label}: </span>
                <span className="font-medium">{assumption.value}</span>
              </p>
              {assumption.reason && (
                <p className="text-xs text-muted-foreground">{assumption.reason}</p>
              )}
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busyKey === assumption.key}
                onClick={() => resolve(assumption, true)}
              >
                {t('overview.brief.assumptionConfirm')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busyKey === assumption.key}
                onClick={() => resolve(assumption, false)}
              >
                {t('overview.brief.assumptionDismiss')}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  )
}

