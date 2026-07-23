'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { CircleHelp, ClipboardList, Loader2, PencilLine, Sparkles } from 'lucide-react'
import { buildProjectBriefView } from '@/lib/project-profile/brief-view'
import type { BriefAssumption } from '@/lib/project-profile/brief-view'
import type { ProjectProfile } from '@/lib/project-profile/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { useLocale, useTranslations } from '@/i18n'
import { sourceTint } from '@/lib/ui/source-tint'

interface ProjectBriefProps {
  projectId: string
  /** Raw structured profile; the fact sheet is derived from it at render time. */
  profile: ProjectProfile | null
  /** AI-generated prose from profile_display (generated separately, async). */
  summary?: string
  /**
   * The UI locale the stored `summary` was generated in. Drives the
   * stale-language repair: when a summary exists but was written in a different
   * locale than the one now active, the brief regenerates it once. Absent on
   * legacy rows — treated as "matches" (no forced regeneration).
   */
  summaryLocale?: string
  /** Whether the brief was ever set up (profile_display exists). */
  briefStarted: boolean
  /**
   * Whether the current user may edit the profile (project:manage). Gates the
   * "edit" link and the empty-state set-up action so viewers get a read-only
   * brief. Defaults to true to preserve existing call sites.
   */
  canEdit?: boolean
}

/** Fact sources with a localized provenance tooltip (under overview.brief.provenance). */
const PROVENANCE_SOURCES = new Set(['onboarding', 'user_confirmed', 'admin_edit'])

/**
 * Project Brief — the architect-owned context Piloti works from. Renders the
 * intake profile as a grouped, human-readable fact sheet: prose summary, focus
 * areas, facts by intake stage, Piloti-suggested assumptions awaiting
 * confirmation, and what Piloti still doesn't know.
 */
export function ProjectBrief({
  projectId,
  profile,
  summary,
  summaryLocale,
  briefStarted,
  canEdit = true,
}: ProjectBriefProps) {
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
      {/* Header: icon tile + title + completeness + edit */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex items-center gap-2.5">
          <span
            className="flex size-8 shrink-0 items-center justify-center rounded-lg"
            style={sourceTint('project')}
            aria-hidden
          >
            <ClipboardList className="size-[17px]" />
          </span>
          <h2 className="text-sm font-semibold text-foreground">{t('overview.brief.heading')}</h2>
          {brief.totalCount > 0 && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
              {t('overview.brief.captured', {
                answered: String(brief.answeredCount),
                total: String(brief.totalCount),
              })}
            </span>
          )}
        </div>
        {canEdit && (
          <Link
            href={intakeHref}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <PencilLine className="size-3.5" aria-hidden />
            {t('overview.brief.edit')}
          </Link>
        )}
      </div>

      {/* AI summary prose. When the brief has facts but no prose yet (a wizard
          save just reset it), generation starts automatically WITH a visible
          "writing…" state — the old fire-and-forget from the wizard finished
          after this page rendered, so the summary never appeared without a
          manual reload. The manual control remains for retry/regenerate. */}
      {prose ? (
        <div className="mt-3">
          <p className="text-sm leading-relaxed text-muted-foreground">{prose}</p>
          <SummaryControl projectId={projectId} hasSummary summaryLocale={summaryLocale} />
        </div>
      ) : (
        <div className="mt-3">
          <SummaryControl projectId={projectId} hasSummary={false} autoStart={hasFacts} />
        </div>
      )}

      {/* Focus areas the architect selected for Piloti */}
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

      {/* Piloti-suggested assumptions awaiting the architect's confirmation */}
      {brief.assumptions.length > 0 && (
        <AssumptionsBlock projectId={projectId} assumptions={brief.assumptions} />
      )}

      {/* What Piloti still doesn't know — each gap links back into the wizard */}
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
 * Generate / regenerate the AI prose summary. Manual clicks surface the
 * route's machine-readable failure codes (notably `llm_not_configured`) as
 * localized toasts and refresh the server component so the new prose shows.
 *
 * With `autoStart`, generation kicks off once on mount (the post-wizard-save
 * case: the brief has facts but its prose was just reset) with a visible
 * "writing the summary…" state. An auto-run failure must NOT vanish silently:
 * it settles into a calm inline notice on the card (with a specific hint when
 * the backend reports `llm_not_configured`) alongside the manual retry button,
 * so the user is never left staring at a summary that never arrives. Manual
 * clicks keep surfacing failures as toasts.
 */
type SummaryFailure = 'llm_not_configured' | 'generic'

function SummaryControl({
  projectId,
  hasSummary,
  summaryLocale,
  autoStart = false,
}: {
  projectId: string
  hasSummary: boolean
  /** Locale the existing summary was generated in (only meaningful with hasSummary). */
  summaryLocale?: string
  autoStart?: boolean
}) {
  const t = useTranslations('projects')
  const { locale } = useLocale()
  const router = useRouter()
  const [pending, setPending] = useState(false)
  /** Set only on the auto-start path, so the failure renders inline (not a toast). */
  const [autoFailure, setAutoFailure] = useState<SummaryFailure | null>(null)
  const autoAttemptedRef = useRef(false)

  const generate = async (silent = false) => {
    setPending(true)
    // A fresh attempt clears any prior inline failure (also on manual retry).
    setAutoFailure(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/generate-summary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale }),
      })
      if (!res.ok) {
        throw { kind: res.status === 403 ? 'forbidden' : 'generic' } as const
      }
      // The route answers 200 even on generation failure, carrying a diagnostic
      // `error` code (e.g. no LLM configured) and an empty summary.
      const data = (await res.json().catch(() => null)) as
        | { summary?: string; error?: string | null }
        | null
      if (data?.error === 'llm_not_configured') {
        throw { kind: 'llm_not_configured' } as const
      }
      if (data?.error || !data?.summary) {
        throw { kind: 'generic' } as const
      }
      if (!silent) toast.success(t('overview.brief.summarySuccess'))
      router.refresh()
    } catch (error) {
      // Distinguish the no-LLM case from a generic failure; forbidden is a
      // manual-only outcome (auto-start already gates on edit permission).
      const kind = (error as { kind?: string } | null)?.kind ?? 'generic'
      if (silent) {
        setAutoFailure(kind === 'llm_not_configured' ? 'llm_not_configured' : 'generic')
      } else {
        toast.error(
          kind === 'forbidden'
            ? t('overview.brief.summaryForbidden')
            : kind === 'llm_not_configured'
              ? t('overview.brief.summaryLlmNotConfigured')
              : t('overview.brief.summaryError'),
        )
      }
    } finally {
      setPending(false)
    }
  }

  // A summary that exists BUT was generated in a different UI locale than the
  // one now active is stale-language: the user switched the UI after it was
  // written, so the prose is stuck in the old language. Legacy rows carry no
  // `summaryLocale` — treated as a match (fail open: never a regeneration
  // storm over rows that predate this field).
  const localeMismatch = hasSummary && summaryLocale != null && summaryLocale !== locale

  useEffect(() => {
    // One attempt per mount, guarded by the ref: whether it succeeds (the
    // refreshed server data then reports the new locale, clearing the
    // mismatch) or fails (the ref alone stops the loop), it never re-fires.
    if (autoAttemptedRef.current) return
    // Two triggers share the single silent-generate path:
    //   - post-wizard-save: facts exist but no prose yet (autoStart, !hasSummary)
    //   - stale-language repair: prose exists in the wrong locale (localeMismatch)
    const shouldAutoStart = autoStart && !hasSummary
    if (!shouldAutoStart && !localeMismatch) return
    autoAttemptedRef.current = true
    void generate(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, hasSummary, localeMismatch])

  if (hasSummary) {
    return (
      <button
        type="button"
        onClick={() => void generate()}
        disabled={pending}
        className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
      >
        {pending ? (
          <Loader2 className="size-3 animate-spin" aria-hidden />
        ) : (
          <Sparkles className="size-3" aria-hidden />
        )}
        {pending ? t('overview.brief.summaryGenerating') : t('overview.brief.summaryRegenerate')}
      </button>
    )
  }

  if (pending) {
    // Covers the auto-run right after a wizard save: the user must see that
    // the prose is on its way, not an inviting "Generate" button that would
    // start a duplicate LLM call.
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {t('overview.brief.summaryWriting')}
      </p>
    )
  }

  if (autoFailure) {
    // The auto-start failed. Instead of vanishing silently, show a calm inline
    // notice (a specific cause hint for the no-LLM case) plus a manual retry.
    return (
      <div className="space-y-2" aria-live="polite">
        <p className="text-sm text-muted-foreground">
          {t('overview.brief.summaryUnavailable')}
          {autoFailure === 'llm_not_configured' && (
            <span className="mt-0.5 block text-xs">{t('overview.brief.summaryUnavailableLlm')}</span>
          )}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={() => void generate()}>
          <Sparkles className="size-4" aria-hidden />
          {t('overview.brief.summaryGenerate')}
        </Button>
      </div>
    )
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={() => void generate()}>
      <Sparkles className="size-4" aria-hidden />
      {t('overview.brief.summaryGenerate')}
    </Button>
  )
}

/**
 * Unconfirmed values Piloti proposed for this project. Confirming graduates the
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
      if (!res.ok) {
        // Read the JSON envelope (`{ error, code }` — see `@/lib/api/errors` /
        // `apiRoute`'s error mapping) so 403/409 don't collapse into one
        // generic message; a malformed or empty body still falls through to
        // the status-code check rather than throwing here.
        const data = (await res.json().catch(() => null)) as { code?: string } | null
        const kind =
          data?.code === 'FORBIDDEN' || res.status === 403
            ? 'forbidden'
            : data?.code === 'CONFLICT' || res.status === 409
              ? 'conflict'
              : 'generic'
        throw { kind } as const
      }
      router.refresh()
    } catch (error) {
      const kind = (error as { kind?: string } | null)?.kind ?? 'generic'
      setError(
        kind === 'forbidden'
          ? t('overview.brief.assumptionForbidden')
          : kind === 'conflict'
            ? t('overview.brief.assumptionConflict')
            : t('overview.brief.assumptionError'),
      )
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
