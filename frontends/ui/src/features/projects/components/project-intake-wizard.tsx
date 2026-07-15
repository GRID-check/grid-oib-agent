'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Check, Loader2, PencilLine } from 'lucide-react'
import { AnimatePresence, easeQuiet, motion } from '@/components/motion'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import {
  answersFromProfile,
  buildIntakeProfile,
  evaluateIntakeCondition,
  formatIntakeAnswer,
  isIntakeAnswerProvided,
  labelForProfileKey,
} from '@/lib/project-profile/intake-definition'
import type { ProjectIntakeDefinition, ProjectIntakeQuestion } from '@/lib/project-profile/intake-definition'
import {
  checkIntakeConsistencyFromAnswers,
  collectFreeTextFields,
  collectStructuredContextFields,
} from '@/lib/project-profile/intake-consistency'
import type { ConsistencyFinding } from '@/lib/project-profile/intake-consistency'
import type { ProjectPrimitiveValue, ProjectProfile } from '@/lib/project-profile/types'
import { useLocale, useTranslations } from '@/i18n'
import type { Translator } from '@/i18n'

interface ProjectIntakeWizardProps {
  projectId: string
  projectName?: string
  mode?: 'create' | 'edit'
  initialProfile?: ProjectProfile | null
  /** FB-13: gate the end-of-wizard conflict check. Off → save exactly as before. */
  conflictCheckEnabled?: boolean
}

type Answers = Record<string, ProjectPrimitiveValue>

/** Is a single question satisfactorily answered for its type? */
function isQuestionValid(question: ProjectIntakeQuestion, answers: Answers): boolean {
  const answer = answers[question.id]
  // Optional questions never block progress; unanswered ones become unknowns.
  if (question.optional && !isIntakeAnswerProvided(answer)) return true
  switch (question.type) {
    case 'boolean':
      return answer !== undefined
    case 'number':
      return answer !== undefined && answer !== '' && answer !== null
    case 'text':
      return typeof answer === 'string' && answer.trim().length > 0
    case 'single_select':
      return typeof answer === 'string' && answer.length > 0
    case 'multi_select':
      return Array.isArray(answer) && answer.length > 0
    default:
      return isIntakeAnswerProvided(answer)
  }
}

function validationMessage(question: ProjectIntakeQuestion, t: Translator): string {
  switch (question.type) {
    case 'single_select':
      return t('intake.validation.selectOption')
    case 'multi_select':
      return t('intake.validation.selectAtLeastOne')
    case 'boolean':
      return t('intake.validation.chooseYesNo')
    case 'number':
      return t('intake.validation.enterNumber')
    default:
      return t('intake.validation.required')
  }
}

export function ProjectIntakeWizard({
  projectId,
  projectName,
  mode = 'create',
  initialProfile = null,
  conflictCheckEnabled = false,
}: ProjectIntakeWizardProps) {
  const t = useTranslations('projects')
  const { locale } = useLocale()
  const router = useRouter()
  const [definition, setDefinition] = useState<ProjectIntakeDefinition | null>(null)
  const [loading, setLoading] = useState(true)
  const [currentStep, setCurrentStep] = useState(0)
  const [answers, setAnswers] = useState<Answers>({})
  const [touched, setTouched] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draftSaved, setDraftSaved] = useState(false)
  /** FB-13: findings held for confirm/override (null = none / not yet checked). */
  const [findings, setFindings] = useState<ConsistencyFinding[] | null>(null)
  /** FB-13: the free-text LLM check is in flight (deterministic part is instant). */
  const [checking, setChecking] = useState(false)
  /** Bumped by "Try again" to re-run the definition fetch after a load failure. */
  const [loadAttempt, setLoadAttempt] = useState(0)

  const STORAGE_KEY = `intake-draft-${projectId}`
  const isEdit = mode === 'edit'

  // Load the definition, then restore a saved draft, or (in edit mode) prefill from
  // the existing profile so re-entering intake opens ready to edit.
  useEffect(() => {
    let cancelled = false
    fetch(`/api/projects/${projectId}/intake-definition`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Failed to load'))))
      .then((data: ProjectIntakeDefinition) => {
        if (cancelled) return
        setDefinition(data)

        let restored = false
        try {
          const draft = sessionStorage.getItem(STORAGE_KEY)
          if (draft) {
            const parsed = JSON.parse(draft)
            if (parsed.answers) {
              setAnswers(parsed.answers)
              restored = true
            }
            if (typeof parsed.currentStep === 'number') setCurrentStep(parsed.currentStep)
          }
        } catch {
          /* invalid draft, ignore */
        }

        if (!restored && initialProfile) {
          setAnswers(answersFromProfile(initialProfile, data))
        }
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setError(t('intake.errors.loadFailed'))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, loadAttempt])

  const retryLoad = useCallback(() => {
    setError(null)
    setLoading(true)
    setLoadAttempt((attempt) => attempt + 1)
  }, [])

  // Debounced autosave of the working draft.
  useEffect(() => {
    if (loading) return
    const timer = setTimeout(() => {
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ answers, currentStep }))
        setDraftSaved(true)
      } catch {
        /* quota exceeded, ignore */
      }
    }, 500)
    return () => clearTimeout(timer)
  }, [answers, currentStep, STORAGE_KEY, loading])

  useEffect(() => {
    if (draftSaved) {
      const timer = setTimeout(() => setDraftSaved(false), 2000)
      return () => clearTimeout(timer)
    }
  }, [draftSaved])

  const stages = definition?.stages ?? []
  const totalSteps = stages.length + 1 // stages + review
  const reviewStep = stages.length
  const isReview = currentStep === reviewStep
  const stage = !isReview ? stages[currentStep] ?? null : null

  const visibleQuestions = useMemo(() => {
    if (!stage) return []
    return stage.questions.filter((q) => evaluateIntakeCondition(q, answers))
  }, [stage, answers])

  const setAnswer = useCallback((id: string, value: ProjectPrimitiveValue) => {
    setAnswers((prev) => ({ ...prev, [id]: value }))
    // Editing invalidates any held conflict findings — the check re-runs on Save.
    setFindings(null)
    setTouched((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  const stageValid = visibleQuestions.every((q) => isQuestionValid(q, answers))

  /** +1 when moving forward, -1 when moving back — drives the step slide direction. */
  const directionRef = useRef(1)

  const goToStep = useCallback(
    (step: number) => {
      setError(null)
      setFindings(null)
      setCurrentStep((prev) => {
        const next = Math.max(0, Math.min(step, totalSteps - 1))
        directionRef.current = next >= prev ? 1 : -1
        return next
      })
    },
    [totalSteps],
  )

  const handleNext = useCallback(() => {
    if (!stageValid) {
      // Reveal inline errors instead of a silently disabled button.
      setTouched((prev) => {
        const next = new Set(prev)
        visibleQuestions.forEach((q) => {
          if (!isQuestionValid(q, answers)) next.add(q.id)
        })
        return next
      })
      return
    }
    goToStep(currentStep + 1)
  }, [stageValid, visibleQuestions, answers, goToStep, currentStep])

  /** Persist the profile and leave for Overview. The actual save, sans checks. */
  const runSave = useCallback(async () => {
    if (!definition) return
    setFindings(null)
    setSaving(true)
    setError(null)
    try {
      const profile = buildIntakeProfile(answers, definition, { projectName })
      const res = await fetch(`/api/projects/${projectId}/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profile),
      })
      if (!res.ok) {
        if (res.status === 409) {
          throw new Error(t('intake.errors.saveConflict'))
        }
        throw new Error('Failed to save')
      }

      // Profile is durably persisted from here on.
      try {
        sessionStorage.removeItem(STORAGE_KEY)
      } catch {
        /* ignore */
      }

      // Summary generation is an enrichment — never let its failure look like a save failure.
      try {
        const res = await fetch(`/api/projects/${projectId}/generate-summary`, { method: 'POST' })
        if (!res.ok) {
          console.warn('[ProjectIntakeWizard] Summary generation returned a non-ok status (non-fatal):', res.status)
        } else {
          const data = await res.json().catch(() => null) as { error?: string | null } | null
          if (data?.error) {
            console.warn('[ProjectIntakeWizard] Summary generation failed (non-fatal):', data.error)
          }
        }
      } catch (e) {
        console.warn('[ProjectIntakeWizard] Summary generation request failed (non-fatal):', e)
      }

      router.push(`/app/projects/${projectId}`)
      router.refresh()
    } catch (e) {
      setError(
        e instanceof Error && e.message === t('intake.errors.saveConflict')
          ? e.message
          : t('intake.errors.saveFailed'),
      )
      setSaving(false)
    }
  }, [definition, answers, projectId, projectName, router, STORAGE_KEY, t])

  /**
   * FB-13 Save entry point. Flag off → save immediately (unchanged). Flag on →
   * run the conflict check once for this attempt: structured answers checked
   * deterministically (instant), free-text answers checked by the LLM (only when
   * substantive free text is present). Any findings hold the save for
   * confirm/override; none (or a check that errored) → save proceeds.
   */
  const handleSave = useCallback(async () => {
    if (!definition) return
    if (!conflictCheckEnabled) {
      await runSave()
      return
    }
    setError(null)

    const deterministic = checkIntakeConsistencyFromAnswers(answers, definition)

    const freeText = collectFreeTextFields(answers, definition)
    let aiFindings: ConsistencyFinding[] = []
    if (freeText.length > 0) {
      setChecking(true)
      try {
        const res = await fetch(`/api/projects/${projectId}/consistency-check`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            freeText,
            structured: collectStructuredContextFields(answers, definition),
            locale,
          }),
        })
        if (res.ok) {
          const data = (await res.json().catch(() => null)) as { findings?: ConsistencyFinding[] | null } | null
          // null findings = the check errored (fail-open); [] = free text is fine.
          if (data?.findings) aiFindings = data.findings
        } else {
          console.warn('[ProjectIntakeWizard] Consistency check returned a non-ok status (non-fatal):', res.status)
        }
      } catch (e) {
        console.warn('[ProjectIntakeWizard] Consistency check request failed (non-fatal):', e)
      } finally {
        setChecking(false)
      }
    }

    const all: ConsistencyFinding[] = [...deterministic, ...aiFindings]
    if (all.length > 0) {
      setFindings(all)
      return
    }
    await runSave()
  }, [definition, conflictCheckEnabled, answers, projectId, locale, runSave])

  /** "Trotzdem speichern" — accept the findings and persist (the human gate). */
  const handleProceedAnyway = useCallback(() => {
    void runSave()
  }, [runSave])

  /** "Überarbeiten" — dismiss findings and jump to the stage to fix. */
  const handleReviseAt = useCallback(
    (stageIndex: number) => {
      setFindings(null)
      goToStep(stageIndex)
    },
    [goToStep],
  )

  if (loading) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-6 md:py-12">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="mt-4 h-2 w-full" />
        <Skeleton className="mt-8 h-6 w-56" />
        <div className="mt-6 space-y-6">
          {[0, 1, 2].map((i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-9 w-full" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (error && !definition) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-6 md:py-12">
        <Alert variant="destructive">
          <AlertDescription className="flex flex-col items-start gap-3">
            <span>{error}</span>
            <Button variant="outline" size="sm" onClick={retryLoad}>
              {t('intake.tryAgain')}
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  if (!definition) return null

  const progress = ((currentStep + 1) / totalSteps) * 100
  const stepTitle = isReview ? t('intake.reviewTitle') : (stage?.title ?? '')

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 md:py-12">
      {/* Header */}
      <header className="mb-8">
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          {isEdit ? t('intake.eyebrowEdit') : t('intake.eyebrowCreate')}
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          {projectName ?? t('intake.titleFallback')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('intake.subtitle')}</p>
      </header>

      {/* Stepper */}
      <nav aria-label={t('intake.progressAria')} className="mb-6">
        <ol className="flex items-center gap-1.5">
          {stages.map((s, i) => {
            const state = i < currentStep ? 'complete' : i === currentStep ? 'current' : 'upcoming'
            const reachable = i <= currentStep
            return (
              <li key={s.id} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => reachable && goToStep(i)}
                  disabled={!reachable}
                  aria-current={state === 'current' ? 'step' : undefined}
                  className={cn(
                    'flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium transition-colors',
                    state === 'complete' && 'border-primary bg-primary text-primary-foreground',
                    state === 'current' && 'border-primary text-primary ring-2 ring-ring/30',
                    state === 'upcoming' && 'border-border text-muted-foreground',
                    reachable && state !== 'current' && 'hover:border-primary/60',
                  )}
                >
                  {state === 'complete' ? <Check className="size-3.5" aria-hidden /> : i + 1}
                </button>
                <span
                  className={cn(
                    'w-full truncate text-center text-xs leading-tight',
                    state === 'current' ? 'font-medium text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {s.title}
                </span>
              </li>
            )
          })}
          {/* Review step marker */}
          <li className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
            <span
              aria-current={isReview ? 'step' : undefined}
              className={cn(
                'flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium',
                isReview ? 'border-primary text-primary ring-2 ring-ring/30' : 'border-border text-muted-foreground',
              )}
            >
              {stages.length + 1}
            </span>
            <span
              className={cn(
                'w-full truncate text-center text-xs leading-tight',
                isReview ? 'font-medium text-foreground' : 'text-muted-foreground',
              )}
            >
              {t('intake.reviewStep')}
            </span>
          </li>
        </ol>
      </nav>

      {/* Progress bar + autosave indicator */}
      <div className="mb-8 flex items-center justify-between gap-4">
        <Progress value={progress} className="h-1 flex-1" />
        <span
          className={cn(
            'shrink-0 text-xs transition-opacity',
            draftSaved ? 'text-success opacity-100' : 'text-muted-foreground opacity-0',
          )}
          aria-live="polite"
        >
          {t('intake.draftSaved')}
        </span>
      </div>

      {/* Step content — keyed so each transition re-animates, sliding in the travel direction.
          Wrapped in a form so Enter in a field advances the step (or saves on review). */}
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          if (saving || checking) return
          if (isReview) {
            // When findings are shown, the user acts via the panel, not Enter.
            if (findings && findings.length > 0) return
            void handleSave()
          } else {
            handleNext()
          }
        }}
      >
      <AnimatePresence mode="wait" initial={false} custom={directionRef.current}>
      <motion.div
        key={currentStep}
        custom={directionRef.current}
        variants={{
          enter: (direction: number) => ({ opacity: 0, x: direction * 12 }),
          center: { opacity: 1, x: 0 },
          exit: (direction: number) => ({ opacity: 0, x: direction * -12 }),
        }}
        initial="enter"
        animate="center"
        exit="exit"
        transition={easeQuiet}
      >
        <div className="mb-6">
          <h2 className="text-lg font-semibold tracking-tight">{stepTitle}</h2>
          {!isReview && stage?.description && (
            <p className="mt-1 text-sm text-muted-foreground">{stage.description}</p>
          )}
          {isReview && (
            <p className="mt-1 text-sm text-muted-foreground">{t('intake.reviewDescription')}</p>
          )}
        </div>

        {isReview ? (
          <div className="space-y-4">
            <ReviewStep
              definition={definition}
              answers={answers}
              onEditStage={(stageIndex) => goToStep(stageIndex)}
            />
            {checking && (
              <div
                className="flex items-center gap-2 text-sm text-muted-foreground"
                aria-live="polite"
              >
                <Loader2 className="size-4 animate-spin" aria-hidden />
                {t('intake.consistency.checking')}
              </div>
            )}
            {findings && findings.length > 0 && (
              <ConflictFindings
                definition={definition}
                findings={findings}
                saving={saving}
                onRevise={handleReviseAt}
                onProceed={handleProceedAnyway}
              />
            )}
          </div>
        ) : (
          <div className="space-y-6">
            {visibleQuestions.map((q) => (
              <QuestionField
                key={q.id}
                question={q}
                value={answers[q.id]}
                error={touched.has(q.id) && !isQuestionValid(q, answers) ? validationMessage(q, t) : null}
                onChange={(v) => setAnswer(q.id, v)}
              />
            ))}
          </div>
        )}
      </motion.div>
      </AnimatePresence>

      {error && definition && (
        <Alert variant="destructive" className="mt-8">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Navigation */}
      <div className="mt-10 flex items-center justify-between gap-4 border-t pt-6">
        <Button
          type="button"
          variant="outline"
          onClick={() => goToStep(currentStep - 1)}
          disabled={currentStep === 0 || saving}
        >
          {t('intake.back')}
        </Button>

        <span className="text-xs text-muted-foreground">
          {t('intake.stepCounter', { current: currentStep + 1, total: totalSteps })}
        </span>

        {isReview ? (
          // While findings are shown the save action lives in the findings panel
          // ("Trotzdem speichern") — hide the duplicate nav button.
          findings && findings.length > 0 ? (
            <span aria-hidden />
          ) : (
            <Button type="submit" disabled={saving || checking}>
              {(saving || checking) && <Loader2 className="size-4 animate-spin" aria-hidden />}
              {checking
                ? t('intake.consistency.checking')
                : saving
                  ? t('intake.saving')
                  : isEdit
                    ? t('intake.saveChanges')
                    : t('intake.saveAndSee')}
            </Button>
          )
        ) : (
          <Button type="submit" disabled={saving}>
            {currentStep === reviewStep - 1 ? t('intake.reviewStep') : t('intake.next')}
          </Button>
        )}
      </div>
      </form>
    </div>
  )
}

function ReviewStep({
  definition,
  answers,
  onEditStage,
}: {
  definition: ProjectIntakeDefinition
  answers: Answers
  onEditStage: (stageIndex: number) => void
}) {
  const t = useTranslations('projects')
  const unknowns = useMemo(() => buildIntakeProfile(answers, definition).unknowns, [answers, definition])

  return (
    <div className="space-y-4">
      <div className="divide-y divide-border overflow-hidden rounded-2xl border bg-card shadow-xs">
        {definition.stages.map((stage, stageIndex) => {
          const items = stage.questions
            .filter((q) => evaluateIntakeCondition(q, answers))
            .map((q) => ({ question: q, value: answers[q.id] }))
          if (items.length === 0) return null

          return (
            <section key={stage.id} className="p-6">
              <div className="flex items-center justify-between gap-4">
                <h3 className="text-sm font-semibold">{stage.title}</h3>
                <button
                  type="button"
                  onClick={() => onEditStage(stageIndex)}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  <PencilLine className="size-3" aria-hidden />
                  {t('intake.edit')}
                </button>
              </div>
              <dl className="mt-3 grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
                {items.map(({ question, value }) => (
                  <div key={question.id} className="flex flex-col">
                    <dt className="text-xs text-muted-foreground">{question.label}</dt>
                    <dd
                      className={cn(
                        'mt-0.5 text-sm',
                        isIntakeAnswerProvided(value) ? 'font-medium' : 'text-muted-foreground',
                      )}
                    >
                      {formatIntakeAnswer(question, value)}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          )
        })}
      </div>

      {unknowns.length > 0 && (
        <div className="rounded-2xl bg-muted/50 p-5">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            {t('intake.unknownsTitle')}
          </p>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {unknowns.map((u) => labelForProfileKey(definition, u)).join(' · ')}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{t('intake.unknownsHint')}</p>
        </div>
      )}
    </div>
  )
}

/** Find the stage index whose questions include one with this label (or -1). */
function stageIndexForFieldLabel(definition: ProjectIntakeDefinition, label: string): number {
  return definition.stages.findIndex((stage) => stage.questions.some((q) => q.label === label))
}

/** Human text for a finding — deterministic ones resolve their i18n key. */
function findingMessage(finding: ConsistencyFinding, t: Translator): string {
  if (finding.kind === 'ai') return finding.message
  return t(`intake.consistency.rules.${finding.messageKey}`, finding.params)
}

/**
 * FB-13 conflict findings panel: renders merged deterministic + AI findings with
 * per-finding severity tint, the affected question labels, an Edit ("Überarbeiten")
 * link to the offending stage, and a single "Trotzdem speichern" override that
 * proceeds with the save (the human gate).
 */
function ConflictFindings({
  definition,
  findings,
  saving,
  onRevise,
  onProceed,
}: {
  definition: ProjectIntakeDefinition
  findings: ConsistencyFinding[]
  saving: boolean
  onRevise: (stageIndex: number) => void
  onProceed: () => void
}) {
  const t = useTranslations('projects')
  return (
    <section aria-label={t('intake.consistency.title')} className="rounded-2xl border bg-card p-5 shadow-xs">
      <div className="flex items-start gap-2">
        <AlertTriangle className="size-4 shrink-0 translate-y-0.5 text-warning" aria-hidden />
        <div>
          <h3 className="text-sm font-semibold">{t('intake.consistency.title')}</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">{t('intake.consistency.subtitle')}</p>
        </div>
      </div>

      <ul className="mt-4 space-y-3">
        {findings.map((finding, index) => {
          const isHard = finding.severity === 'inconsistency'
          const targetStage = finding.fields
            .map((label) => stageIndexForFieldLabel(definition, label))
            .find((i) => i >= 0)
          return (
            <li
              key={index}
              className={cn(
                'rounded-xl border px-4 py-3 text-sm',
                isHard
                  ? 'border-destructive/30 bg-danger-subtle text-destructive'
                  : 'border-warning/40 bg-warning-subtle text-warning',
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium uppercase tracking-wide">
                  {isHard
                    ? t('intake.consistency.severity.inconsistency')
                    : t('intake.consistency.severity.warning')}
                </span>
                {targetStage !== undefined && (
                  <button
                    type="button"
                    onClick={() => onRevise(targetStage)}
                    className="inline-flex items-center gap-1 text-xs font-medium underline-offset-2 hover:underline"
                  >
                    <PencilLine className="size-3" aria-hidden />
                    {t('intake.consistency.revise')}
                  </button>
                )}
              </div>
              <p className="mt-1 text-foreground">{findingMessage(finding, t)}</p>
              {finding.fields.length > 0 && (
                <p className="mt-1.5 text-xs text-muted-foreground">{finding.fields.join(' · ')}</p>
              )}
            </li>
          )
        })}
      </ul>

      <div className="mt-4 flex items-center justify-end">
        <Button type="button" onClick={onProceed} disabled={saving}>
          {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
          {t('intake.consistency.proceed')}
        </Button>
      </div>
    </section>
  )
}

function QuestionField({
  question,
  value,
  error,
  onChange,
}: {
  question: ProjectIntakeQuestion
  value: ProjectPrimitiveValue
  error: string | null
  onChange: (value: ProjectPrimitiveValue) => void
}) {
  const t = useTranslations('projects')
  const id = `q-${question.id}`
  const describedBy = error ? `${id}-error` : question.help ? `${id}-help` : undefined

  const labelContent = (
    <>
      {question.label}
      {question.optional && (
        <span className="ml-1 font-normal text-muted-foreground">{t('intake.optional')}</span>
      )}
    </>
  )

  const help = question.help ? (
    <p id={`${id}-help`} className="text-xs text-muted-foreground">
      {question.help}
    </p>
  ) : null

  const errorText = error ? (
    <p id={`${id}-error`} className="text-sm text-destructive">
      {error}
    </p>
  ) : null

  switch (question.type) {
    case 'text':
      return (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={id} className="text-sm font-medium">
            {labelContent}
          </Label>
          {help}
          <Input
            id={id}
            type="text"
            value={typeof value === 'string' ? value : ''}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            onChange={(e) => onChange(e.target.value)}
          />
          {errorText}
        </div>
      )
    case 'number':
      return (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={id} className="text-sm font-medium">
            {labelContent}
          </Label>
          {help}
          <Input
            id={id}
            type="number"
            value={typeof value === 'number' ? value : typeof value === 'string' ? value : ''}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
          />
          {errorText}
        </div>
      )
    case 'boolean':
      return (
        <fieldset aria-describedby={describedBy}>
          <legend className="text-sm font-medium">{labelContent}</legend>
          {help}
          <div className="mt-2 flex gap-4">
            {['true', 'false'].map((opt) => {
              const boolVal = opt === 'true'
              return (
                <label key={opt} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name={id}
                    checked={value === boolVal}
                    onChange={() => onChange(boolVal)}
                    className="h-4 w-4 accent-primary"
                  />
                  {opt === 'true' ? t('intake.yes') : t('intake.no')}
                </label>
              )
            })}
          </div>
          {errorText}
        </fieldset>
      )
    case 'single_select':
      return (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={id} className="text-sm font-medium">
            {labelContent}
          </Label>
          {help}
          <Select value={typeof value === 'string' ? value : ''} onValueChange={(v) => onChange(v)}>
            <SelectTrigger id={id} className="w-full" aria-invalid={error ? true : undefined} aria-describedby={describedBy}>
              <SelectValue placeholder={t('intake.selectPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {(question.options ?? []).map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {errorText}
        </div>
      )
    case 'multi_select':
      return (
        <fieldset aria-describedby={describedBy}>
          <legend className="text-sm font-medium">{labelContent}</legend>
          {help}
          <div className="mt-2 flex flex-col gap-2">
            {(question.options ?? []).map((opt) => {
              const arr = Array.isArray(value) ? value : []
              const checked = arr.includes(opt.value)
              return (
                <div key={opt.value} className="flex items-center gap-2">
                  <Checkbox
                    id={`${id}-${opt.value}`}
                    checked={checked}
                    onCheckedChange={() => {
                      const next = checked ? arr.filter((v) => v !== opt.value) : [...arr, opt.value]
                      onChange(next)
                    }}
                  />
                  <Label htmlFor={`${id}-${opt.value}`} className="text-sm font-normal">
                    {opt.label}
                  </Label>
                </div>
              )
            })}
          </div>
          {errorText}
        </fieldset>
      )
    default:
      return null
  }
}
