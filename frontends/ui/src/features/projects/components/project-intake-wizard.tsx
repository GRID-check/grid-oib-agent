'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  FolderOpen,
  Loader2,
  PencilLine,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { AnimatePresence, easeQuiet, motion } from '@/components/motion'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import {
  answerKeyFor,
  answersFromProfile,
  buildIntakeProfile,
  bauwerkeFromAnswers,
  defaultBauwerke,
  evaluateIntakeCondition,
  formatIntakeAnswer,
  isIntakeAnswerProvided,
  mergeIntakeProfile,
  modeKeyFor,
  pruneStaleConditionalAnswers,
} from '@/lib/project-profile/intake-definition'
import type {
  BauwerkInstance,
  IntakeAnswerMode,
  ProjectIntakeDefinition,
  ProjectIntakeQuestion,
  ProjectIntakeStage,
} from '@/lib/project-profile/intake-definition'
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
  initialProfileVersion?: number | null
  conflictCheckEnabled?: boolean
  salvageNotice?: 'partial' | 'full' | null
  /**
   * Render offline with a supplied definition instead of fetching it — used by
   * the /dev/intake gallery and component tests so the whole wizard can render
   * without the API. Undefined in production (the definition is fetched).
   */
  definitionOverride?: ProjectIntakeDefinition
}

type Answers = Record<string, ProjectPrimitiveValue>

/** Shape of the autosaved intake draft persisted in localStorage. */
interface IntakeDraft {
  answers?: Answers
  bauwerke?: BauwerkInstance[]
  currentStep?: number
  savedAt?: number
  baseVersion?: number | null
}

function profileUpdatedAtMs(profile: ProjectProfile | null | undefined): number | null {
  if (!profile) return null
  let latest: number | null = null
  const consider = (iso: string | undefined) => {
    if (!iso) return
    const ms = Date.parse(iso)
    if (!Number.isNaN(ms)) latest = latest === null ? ms : Math.max(latest, ms)
  }
  for (const fact of Object.values(profile.facts ?? {})) consider(fact.updatedAt)
  for (const assumption of Object.values(profile.assumptions ?? {})) consider(assumption.updatedAt)
  return latest
}

function draftShouldWinInEditMode(
  draft: IntakeDraft,
  profile: ProjectProfile | null,
  profileVersion: number | null,
): boolean {
  if (typeof profileVersion === 'number' && typeof draft.baseVersion === 'number') {
    return profileVersion <= draft.baseVersion
  }
  const profileAt = profileUpdatedAtMs(profile)
  if (profileAt !== null && typeof draft.savedAt === 'number') {
    return draft.savedAt >= profileAt
  }
  return false
}

/**
 * May the wizard advance past this question? Non-required questions never block
 * on emptiness, but an ANSWERED numeric field must still be finite — an entered
 * "1e999" (→ Infinity) serializes to null and would corrupt the fact, so it is
 * rejected even when the field is optional.
 */
function isQuestionSatisfied(question: ProjectIntakeQuestion, answers: Answers, answerKey: string): boolean {
  const answer = answers[answerKey]
  if (question.type === 'number' || question.type === 'number_tri') {
    if (answers[modeKeyFor(answerKey)] === 'offen') return true
    if (!isIntakeAnswerProvided(answer)) return !question.required
    const numeric = typeof answer === 'number' ? answer : Number(answer)
    return Number.isFinite(numeric)
  }
  if (!question.required) return true
  if (question.type === 'multi_select') return Array.isArray(answer) && answer.length > 0
  return isIntakeAnswerProvided(answer)
}

function validationMessage(question: ProjectIntakeQuestion, t: Translator): string {
  switch (question.type) {
    case 'single_select':
      return t('intake.validation.selectOption')
    case 'multi_select':
      return t('intake.validation.selectAtLeastOne')
    case 'number':
    case 'number_tri':
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
  initialProfileVersion = null,
  conflictCheckEnabled = false,
  salvageNotice = null,
  definitionOverride,
}: ProjectIntakeWizardProps) {
  const t = useTranslations('projects')
  const { locale } = useLocale()
  const router = useRouter()
  const [definition, setDefinition] = useState<ProjectIntakeDefinition | null>(null)
  const [loading, setLoading] = useState(true)
  const [currentStep, setCurrentStep] = useState(0)
  const [answers, setAnswers] = useState<Answers>({})
  const [bauwerke, setBauwerke] = useState<BauwerkInstance[]>(defaultBauwerke())
  const [touched, setTouched] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [draftSaved, setDraftSaved] = useState(false)
  const [findings, setFindings] = useState<ConsistencyFinding[] | null>(null)
  const [checking, setChecking] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)

  const STORAGE_KEY = `intake-draft-${projectId}`
  const isEdit = mode === 'edit'
  const bwCounter = useRef(1)
  // The active module-stepper button, scrolled into view whenever the step changes
  // so the current pill never hides off the right edge on a narrow screen.
  const activeStepRef = useRef<HTMLButtonElement | null>(null)

  // Load the definition, then restore a draft or prefill from the stored profile.
  useEffect(() => {
    let cancelled = false
    const load = definitionOverride
      ? Promise.resolve(definitionOverride)
      : fetch(`/api/projects/${projectId}/intake-definition`).then((r) =>
          r.ok ? (r.json() as Promise<ProjectIntakeDefinition>) : Promise.reject(new Error('Failed to load')),
        )
    load
      .then((data: ProjectIntakeDefinition) => {
        if (cancelled) return
        setDefinition(data)

        let restored = false
        try {
          const raw = localStorage.getItem(STORAGE_KEY)
          if (raw) {
            const parsed = JSON.parse(raw) as IntakeDraft
            if (parsed.answers) {
              const restoreDraft =
                !isEdit ||
                !initialProfile ||
                draftShouldWinInEditMode(parsed, initialProfile, initialProfileVersion)
              if (restoreDraft) {
                const draftBauwerke =
                  parsed.bauwerke && parsed.bauwerke.length > 0
                    ? parsed.bauwerke
                    : bauwerkeFromAnswers(parsed.answers)
                setBauwerke(draftBauwerke)
                bwCounter.current = maxBwNumber(draftBauwerke)
                setAnswers(pruneStaleConditionalAnswers(parsed.answers, data))
                if (typeof parsed.currentStep === 'number') setCurrentStep(parsed.currentStep)
                restored = true
              } else {
                try {
                  localStorage.removeItem(STORAGE_KEY)
                } catch {
                  /* ignore */
                }
              }
            }
          }
        } catch {
          /* invalid draft, ignore */
        }

        if (!restored) {
          if (initialProfile) {
            const seeded = answersFromProfile(initialProfile, data)
            setBauwerke(seeded.bauwerke)
            bwCounter.current = maxBwNumber(seeded.bauwerke)
            setAnswers(pruneStaleConditionalAnswers(seeded.answers, data))
          } else if (projectName && !isEdit) {
            // Seed the project name captured at creation so A1 opens prefilled.
            setAnswers({ A1: projectName })
          }
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
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            answers,
            bauwerke,
            currentStep,
            savedAt: Date.now(),
            baseVersion: typeof initialProfileVersion === 'number' ? initialProfileVersion : null,
          } satisfies IntakeDraft),
        )
        setDraftSaved(true)
      } catch {
        /* quota exceeded, ignore */
      }
    }, 500)
    return () => clearTimeout(timer)
  }, [answers, bauwerke, currentStep, STORAGE_KEY, loading, initialProfileVersion])

  useEffect(() => {
    if (draftSaved) {
      const timer = setTimeout(() => setDraftSaved(false), 2000)
      return () => clearTimeout(timer)
    }
  }, [draftSaved])

  // Keep the active module pill visible: on a phone the A–H stepper is wider than
  // the screen, so from module E on the current step would sit off the right edge.
  useEffect(() => {
    const el = activeStepRef.current
    if (!el) return
    const prefersReduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView({
      inline: 'center',
      block: 'nearest',
      behavior: prefersReduced ? 'auto' : 'smooth',
    })
  }, [currentStep])

  const stages = definition?.stages ?? []
  const totalSteps = stages.length
  const stage: ProjectIntakeStage | null = stages[currentStep] ?? null
  const isReview = stage?.id === 'H'

  const setAnswer = useCallback((key: string, value: ProjectPrimitiveValue) => {
    setAnswers((prev) => pruneStaleConditionalAnswers({ ...prev, [key]: value }, definition))
    setFindings(null)
    setTouched((prev) => {
      if (!prev.has(key)) return prev
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  }, [definition])

  const setMode = useCallback((answerKey: string, nextMode: IntakeAnswerMode) => {
    setAnswers((prev) => {
      const next = { ...prev, [modeKeyFor(answerKey)]: nextMode }
      if (nextMode === 'offen') delete next[answerKey]
      return pruneStaleConditionalAnswers(next, definition)
    })
    setFindings(null)
  }, [definition])

  /** Visible questions on a projekt/grundstueck stage (bauwerk stages iterate instances). */
  const flatVisibleQuestions = useMemo(() => {
    if (!stage || stage.scope === 'bauwerk') return []
    return stage.questions.filter((q) => evaluateIntakeCondition(q, answers))
  }, [stage, answers])

  const stageValid = useMemo(() => {
    if (!stage) return true
    if (stage.scope === 'bauwerk') {
      return bauwerke.every((bw) =>
        stage.questions
          .filter((q) => evaluateIntakeCondition(q, answers, bw.id))
          .every((q) => isQuestionSatisfied(q, answers, answerKeyFor(q.id, bw.id))),
      )
    }
    return flatVisibleQuestions.every((q) => isQuestionSatisfied(q, answers, q.id))
  }, [stage, bauwerke, answers, flatVisibleQuestions])

  const directionRef = useRef(1)

  const goToStep = useCallback(
    (step: number) => {
      setError(null)
      setConflict(false)
      setFindings(null)
      setCurrentStep((prev) => {
        const next = Math.max(0, Math.min(step, totalSteps - 1))
        directionRef.current = next >= prev ? 1 : -1
        return next
      })
    },
    [totalSteps],
  )

  const markStageTouched = useCallback(() => {
    if (!stage) return
    setTouched((prev) => {
      const next = new Set(prev)
      if (stage.scope === 'bauwerk') {
        for (const bw of bauwerke) {
          for (const q of stage.questions) {
            const key = answerKeyFor(q.id, bw.id)
            if (evaluateIntakeCondition(q, answers, bw.id) && !isQuestionSatisfied(q, answers, key)) next.add(key)
          }
        }
      } else {
        for (const q of flatVisibleQuestions) {
          if (!isQuestionSatisfied(q, answers, q.id)) next.add(q.id)
        }
      }
      return next
    })
  }, [stage, bauwerke, answers, flatVisibleQuestions])

  const handleNext = useCallback(() => {
    if (!stageValid) {
      markStageTouched()
      return
    }
    goToStep(currentStep + 1)
  }, [stageValid, markStageTouched, goToStep, currentStep])

  // --- Bauwerk management (module C's C0 affordance) ---
  const addBauwerk = useCallback(() => {
    bwCounter.current += 1
    const id = `bw${bwCounter.current}`
    setBauwerke((prev) => [...prev, { id, name: `Bauwerk ${prev.length + 1}` }])
  }, [])

  const removeBauwerk = useCallback((id: string) => {
    setBauwerke((prev) => (prev.length > 1 ? prev.filter((bw) => bw.id !== id) : prev))
    // Drop every answer belonging to the removed building.
    setAnswers((prev) => {
      const next: Answers = {}
      for (const [key, value] of Object.entries(prev)) {
        if (!key.includes(`@${id}`)) next[key] = value
      }
      return next
    })
  }, [])

  const renameBauwerk = useCallback((id: string, name: string) => {
    setBauwerke((prev) => prev.map((bw) => (bw.id === id ? { ...bw, name } : bw)))
  }, [])

  const runSave = useCallback(async () => {
    if (!definition) return
    setFindings(null)
    setSaving(true)
    setError(null)
    setConflict(false)
    try {
      const built = buildIntakeProfile(answers, definition, { projectName, bauwerke })
      const profile: ProjectProfile = mergeIntakeProfile(built, initialProfile, definition)
      const res = await fetch(`/api/projects/${projectId}/profile`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(typeof initialProfileVersion === 'number'
            ? { 'If-Match': String(initialProfileVersion) }
            : {}),
        },
        body: JSON.stringify(profile),
      })
      if (!res.ok) {
        if (res.status === 409) throw new Error(t('intake.errors.saveConflict'))
        throw new Error('Failed to save')
      }

      try {
        localStorage.removeItem(STORAGE_KEY)
      } catch {
        /* ignore */
      }

      const capturedCount = Object.keys(built.facts).length + Object.keys(built.goals).length
      toast.success(t('intake.saveSuccess', { count: capturedCount }))
      router.push(`/app/projects/${projectId}`)
      router.refresh()
    } catch (e) {
      const isConflict = e instanceof Error && e.message === t('intake.errors.saveConflict')
      setConflict(isConflict)
      setError(isConflict ? (e as Error).message : t('intake.errors.saveFailed'))
      setSaving(false)
    }
  }, [definition, answers, bauwerke, initialProfile, initialProfileVersion, projectId, projectName, router, STORAGE_KEY, t])

  const reloadAfterConflict = useCallback(() => {
    setError(null)
    setConflict(false)
    router.refresh()
  }, [router])

  const handleSave = useCallback(async () => {
    if (!definition) return
    if (!conflictCheckEnabled) {
      await runSave()
      return
    }
    setError(null)

    let deterministic: ConsistencyFinding[]
    let freeText: ReturnType<typeof collectFreeTextFields>
    try {
      deterministic = checkIntakeConsistencyFromAnswers(answers, definition)
      freeText = collectFreeTextFields(answers, definition)
    } catch (e) {
      console.error('[ProjectIntakeWizard] Pre-save consistency gate threw; saving anyway (fail-open):', e)
      await runSave()
      return
    }

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

  const handleProceedAnyway = useCallback(() => {
    void runSave()
  }, [runSave])

  const handleReviseAt = useCallback(
    (stageIndex: number) => {
      setFindings(null)
      goToStep(stageIndex)
    },
    [goToStep],
  )

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6 md:py-12">
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
      <div className="mx-auto max-w-3xl px-4 py-6 md:py-12">
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

  if (!definition || !stage) return null

  const progress = ((currentStep + 1) / totalSteps) * 100

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 md:py-12">
      <header className="mb-8">
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          {isEdit ? t('intake.eyebrowEdit') : t('intake.eyebrowCreate')}
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          {projectName ?? t('intake.titleFallback')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('intake.subtitle')}</p>
      </header>

      {salvageNotice && (
        <Alert variant="warning" className="mb-6">
          <AlertTriangle aria-hidden />
          <AlertDescription>
            {salvageNotice === 'full' ? t('intake.salvage.full') : t('intake.salvage.partial')}
          </AlertDescription>
        </Alert>
      )}

      {/* Module stepper (A–H). The edge fades signal that it scrolls horizontally. */}
      <div className="relative mb-6">
        <nav aria-label={t('intake.progressAria')} className="-mx-1 overflow-x-auto px-1 pb-1">
          <ol className="flex min-w-max items-start gap-1.5">
            {stages.map((s, i) => {
              const state = i < currentStep ? 'complete' : i === currentStep ? 'current' : 'upcoming'
              const reachable = i <= currentStep
              return (
                <li key={s.id} className="shrink-0">
                  <button
                    type="button"
                    ref={state === 'current' ? activeStepRef : undefined}
                    onClick={() => reachable && goToStep(i)}
                    disabled={!reachable}
                    aria-current={state === 'current' ? 'step' : undefined}
                    className="group flex w-20 flex-col items-center gap-1.5 rounded-lg px-1 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default"
                  >
                    <span
                      className={cn(
                        'flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium transition-colors',
                        state === 'complete' && 'border-primary bg-primary text-primary-foreground',
                        state === 'current' && 'border-primary text-primary ring-2 ring-ring/30',
                        state === 'upcoming' && 'border-border text-muted-foreground',
                        reachable && state !== 'current' && 'group-hover:border-primary/60',
                      )}
                    >
                      {state === 'complete' ? <Check className="size-3.5" aria-hidden /> : s.id}
                    </span>
                    <span
                      className={cn(
                        'w-full truncate text-center text-[11px] leading-tight',
                        state === 'current' ? 'font-medium text-foreground' : 'text-muted-foreground',
                      )}
                    >
                      {s.title}
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
        </nav>
        {/* Scroll-affordance fades at each edge. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-4 bg-gradient-to-r from-background to-transparent"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-4 bg-gradient-to-l from-background to-transparent"
        />
      </div>

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

      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          if (saving || checking) return
          if (isReview) {
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
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-xs text-primary">Modul {stage.id}</span>
                <span className="text-xs text-muted-foreground">
                  {currentStep + 1}/{totalSteps}
                </span>
              </div>
              <h2 className="mt-1 text-lg font-semibold tracking-tight">{stage.title}</h2>
              {stage.description && (
                <p className="mt-1 text-sm text-muted-foreground">{stage.description}</p>
              )}
            </div>

            {isReview ? (
              <div className="space-y-4">
                <ReviewStep
                  definition={definition}
                  answers={answers}
                  bauwerke={bauwerke}
                  onEditStage={(stageIndex) => goToStep(stageIndex)}
                />
                {checking && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
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
            ) : stage.scope === 'bauwerk' ? (
              <BauwerkStage
                stage={stage}
                bauwerke={bauwerke}
                answers={answers}
                touched={touched}
                projectId={projectId}
                onSetAnswer={setAnswer}
                onSetMode={setMode}
                onAddBauwerk={addBauwerk}
                onRemoveBauwerk={removeBauwerk}
                onRenameBauwerk={renameBauwerk}
                validationMessageFor={(q) => validationMessage(q, t)}
              />
            ) : (
              <div className="space-y-6">
                {flatVisibleQuestions.map((q) => (
                  <QuestionField
                    key={q.id}
                    question={q}
                    answerKey={q.id}
                    answers={answers}
                    projectId={projectId}
                    error={
                      touched.has(q.id) && !isQuestionSatisfied(q, answers, q.id)
                        ? validationMessage(q, t)
                        : null
                    }
                    onSetAnswer={setAnswer}
                    onSetMode={setMode}
                  />
                ))}
              </div>
            )}
          </motion.div>
        </AnimatePresence>

        {error && definition && (
          <Alert variant="destructive" className="mt-8">
            <AlertDescription className={conflict ? 'flex flex-col items-start gap-3' : undefined}>
              <span>{error}</span>
              {conflict && (
                <Button type="button" variant="outline" size="sm" onClick={reloadAfterConflict}>
                  {t('intake.conflictReload')}
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}

        <div className="sticky bottom-0 z-20 -mx-4 mt-10 flex items-center justify-between gap-4 border-t bg-background/85 px-4 pt-4 backdrop-blur-md pb-[max(1rem,env(safe-area-inset-bottom))]">
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
              {t('intake.next')}
            </Button>
          )}
        </div>
      </form>
    </div>
  )
}

/** The highest bwN number present, so newly-added buildings never reuse an id. */
function maxBwNumber(bauwerke: BauwerkInstance[]): number {
  return bauwerke.reduce((max, bw) => {
    const n = Number(bw.id.replace(/^bw/, ''))
    return Number.isFinite(n) ? Math.max(max, n) : max
  }, 1)
}

// ---------------------------------------------------------------------------
// Bauwerk stage (modules C / D / E) — repeatable building cards.
// ---------------------------------------------------------------------------

function BauwerkStage({
  stage,
  bauwerke,
  answers,
  touched,
  projectId,
  onSetAnswer,
  onSetMode,
  onAddBauwerk,
  onRemoveBauwerk,
  onRenameBauwerk,
  validationMessageFor,
}: {
  stage: ProjectIntakeStage
  bauwerke: BauwerkInstance[]
  answers: Answers
  touched: Set<string>
  projectId: string
  onSetAnswer: (key: string, value: ProjectPrimitiveValue) => void
  onSetMode: (key: string, mode: IntakeAnswerMode) => void
  onAddBauwerk: () => void
  onRemoveBauwerk: (id: string) => void
  onRenameBauwerk: (id: string, name: string) => void
  validationMessageFor: (q: ProjectIntakeQuestion) => string
}) {
  const t = useTranslations('projects')
  // Only module C owns the add/remove building affordance.
  const canManage = stage.id === 'C'

  return (
    <div className="space-y-4">
      {bauwerke.map((bw, index) => (
        <div key={bw.id} className="overflow-hidden rounded-2xl border bg-card shadow-xs">
          <div className="flex items-center gap-3 border-b bg-muted/40 px-4 py-2.5">
            <Badge variant="default" className="font-mono">
              {bw.id.toUpperCase()}
            </Badge>
            {canManage ? (
              <input
                value={bw.name}
                onChange={(e) => onRenameBauwerk(bw.id, e.target.value)}
                aria-label={t('intake.bauwerk.nameAria')}
                className="min-w-0 flex-1 border-b border-dashed border-transparent bg-transparent py-0.5 text-sm font-medium outline-none hover:border-border focus:border-primary"
              />
            ) : (
              <span className="flex-1 truncate text-sm font-medium">{bw.name}</span>
            )}
            {canManage && bauwerke.length > 1 && (
              <button
                type="button"
                onClick={() => onRemoveBauwerk(bw.id)}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-destructive"
              >
                <Trash2 className="size-3.5" aria-hidden />
                {t('intake.bauwerk.remove')}
              </button>
            )}
          </div>

          <div className="space-y-6 px-4 py-5 md:px-6">
            {stage.questions
              .filter((q) => evaluateIntakeCondition(q, answers, bw.id))
              .map((q) => {
                const answerKey = answerKeyFor(q.id, bw.id)
                return (
                  <QuestionField
                    key={answerKey}
                    question={q}
                    answerKey={answerKey}
                    answers={answers}
                    projectId={projectId}
                    error={
                      touched.has(answerKey) && !isQuestionSatisfied(q, answers, answerKey)
                        ? validationMessageFor(q)
                        : null
                    }
                    onSetAnswer={onSetAnswer}
                    onSetMode={onSetMode}
                  />
                )
              })}

            {/* Module D: implicit use-zones expanded from D0. */}
            {stage.id === 'D' && <ZoneBlocks stage={stage} bw={bw} answers={answers} onSetAnswer={onSetAnswer} onSetMode={onSetMode} projectId={projectId} />}
          </div>
          {index === bauwerke.length - 1 && canManage && (
            <div className="border-t px-4 py-3 md:px-6">
              <button
                type="button"
                onClick={onAddBauwerk}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border py-2.5 font-mono text-xs text-muted-foreground transition-colors hover:border-primary/60 hover:bg-primary/5 hover:text-primary"
              >
                <Plus className="size-4" aria-hidden />
                {t('intake.bauwerk.add')}
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

/** Module D: a sub-zone block per selected use, with common + use-specific questions. */
function ZoneBlocks({
  stage,
  bw,
  answers,
  onSetAnswer,
  onSetMode,
  projectId,
}: {
  stage: ProjectIntakeStage
  bw: BauwerkInstance
  answers: Answers
  onSetAnswer: (key: string, value: ProjectPrimitiveValue) => void
  onSetMode: (key: string, mode: IntakeAnswerMode) => void
  projectId: string
}) {
  const selected = answers[answerKeyFor('D0', bw.id)]
  if (!Array.isArray(selected) || selected.length === 0) return null
  const d0 = stage.questions.find((q) => q.id === 'D0')

  return (
    <>
      {selected.map((use) => {
        const label = d0?.options?.find((o) => o.value === use)?.label ?? use
        const zoneQuestions = [...(stage.zoneCommon ?? []), ...(stage.zoneDefinitions?.[use]?.questions ?? [])]
        if (zoneQuestions.length === 0) return null
        return (
          <div key={use} className="rounded-xl border border-l-2 border-l-primary bg-primary/5 px-4 py-4">
            <p className="mb-3 font-mono text-[11px] uppercase tracking-wider text-primary">Zone · {label}</p>
            <div className="space-y-5">
              {zoneQuestions.map((q) => {
                const answerKey = answerKeyFor(q.id, bw.id, use)
                return (
                  <QuestionField
                    key={answerKey}
                    question={q}
                    answerKey={answerKey}
                    answers={answers}
                    projectId={projectId}
                    error={null}
                    onSetAnswer={onSetAnswer}
                    onSetMode={onSetMode}
                  />
                )
              })}
            </div>
          </div>
        )
      })}
    </>
  )
}

// ---------------------------------------------------------------------------
// Review (module H).
// ---------------------------------------------------------------------------

interface ReviewItem {
  label: string
  value: string
  mode?: 'geschaetzt' | 'offen'
}

function reviewItemsFor(
  questions: ProjectIntakeQuestion[],
  answers: Answers,
  keyOf: (q: ProjectIntakeQuestion) => string,
  instanceId?: string,
): ReviewItem[] {
  const items: ReviewItem[] = []
  for (const q of questions) {
    if (q.type === 'info_placeholder' || q.type === 'upload') continue
    if (!q.writesTo) continue
    if (!evaluateIntakeCondition(q, answers, instanceId)) continue
    const key = keyOf(q)
    const raw = answers[key]
    if (q.type === 'number_tri') {
      const mode = answers[modeKeyFor(key)] as IntakeAnswerMode | undefined
      if (mode === 'offen') {
        items.push({ label: q.label, value: '—', mode: 'offen' })
      } else if (isIntakeAnswerProvided(raw)) {
        items.push({
          label: q.label,
          value: formatIntakeAnswer(q, raw),
          mode: mode === 'geschaetzt' ? 'geschaetzt' : undefined,
        })
      }
      continue
    }
    if (q.type === 'yes_no_open') {
      if (raw === 'offen') items.push({ label: q.label, value: '—', mode: 'offen' })
      else if (raw === 'ja' || raw === 'nein') items.push({ label: q.label, value: raw === 'ja' ? 'Ja' : 'Nein' })
      continue
    }
    if (isIntakeAnswerProvided(raw)) items.push({ label: q.label, value: formatIntakeAnswer(q, raw) })
  }
  return items
}

function ReviewSection({
  title,
  items,
  onEdit,
  editLabel,
}: {
  title: string
  items: ReviewItem[]
  onEdit?: () => void
  editLabel: string
}) {
  if (items.length === 0) return null
  return (
    <section className="p-5 md:p-6">
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-sm font-semibold">{title}</h3>
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <PencilLine className="size-3" aria-hidden />
            {editLabel}
          </button>
        )}
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
        {items.map((item, i) => (
          <div key={i} className="flex flex-col">
            <dt className="text-xs text-muted-foreground">{item.label}</dt>
            <dd className={cn('mt-0.5 text-sm', item.mode === 'offen' ? 'text-muted-foreground' : 'font-medium')}>
              {item.value}
              {item.mode === 'geschaetzt' && (
                <Badge variant="warning" className="ml-2 align-middle">
                  geschätzt
                </Badge>
              )}
              {item.mode === 'offen' && (
                <Badge variant="outline" className="ml-2 align-middle">
                  noch offen
                </Badge>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function ReviewStep({
  definition,
  answers,
  bauwerke,
  onEditStage,
}: {
  definition: ProjectIntakeDefinition
  answers: Answers
  bauwerke: BauwerkInstance[]
  onEditStage: (stageIndex: number) => void
}) {
  const t = useTranslations('projects')

  const projektStages = definition.stages
    .map((stage, index) => ({ stage, index }))
    .filter(({ stage }) => stage.scope !== 'bauwerk' && stage.id !== 'H')
  const bauwerkStages = definition.stages
    .map((stage, index) => ({ stage, index }))
    .filter(({ stage }) => stage.scope === 'bauwerk')

  return (
    <div className="space-y-4">
      <div className="divide-y divide-border overflow-hidden rounded-2xl border bg-card shadow-xs">
        {projektStages.map(({ stage, index }) => (
          <ReviewSection
            key={stage.id}
            title={stage.title}
            editLabel={t('intake.edit')}
            onEdit={() => onEditStage(index)}
            items={reviewItemsFor(stage.questions, answers, (q) => q.id)}
          />
        ))}
      </div>

      {bauwerke.map((bw) => {
        const items: ReviewItem[] = []
        for (const { stage } of bauwerkStages) {
          items.push(...reviewItemsFor(stage.questions, answers, (q) => answerKeyFor(q.id, bw.id), bw.id))
          const uses = answers[answerKeyFor('D0', bw.id)]
          if (Array.isArray(uses)) {
            for (const use of uses) {
              const zoneQs = [...(stage.zoneCommon ?? []), ...(stage.zoneDefinitions?.[use]?.questions ?? [])]
              items.push(...reviewItemsFor(zoneQs, answers, (q) => answerKeyFor(q.id, bw.id, use), bw.id))
            }
          }
        }
        if (items.length === 0) return null
        return (
          <div key={bw.id} className="overflow-hidden rounded-2xl border bg-card shadow-xs">
            <ReviewSection
              title={bw.name}
              editLabel={t('intake.edit')}
              onEdit={() => onEditStage(bauwerkStages[0]?.index ?? 0)}
              items={items}
            />
          </div>
        )
      })}

      <div className="rounded-2xl border border-dashed bg-muted/30 p-5">
        <div className="flex items-start gap-2">
          <Sparkles className="size-4 shrink-0 translate-y-0.5 text-primary" aria-hidden />
          <div>
            <p className="text-sm font-medium">{t('intake.classification.title')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t('intake.classification.description')}</p>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Findings panel (unchanged behaviour, adapted to modules).
// ---------------------------------------------------------------------------

function resolveReviseStage(definition: ProjectIntakeDefinition, finding: ConsistencyFinding): number {
  for (const label of finding.fields) {
    const idx = definition.stages.findIndex((stage) => stage.questions.some((q) => q.label === label))
    if (idx >= 0) return idx
  }
  if (finding.kind === 'ai') {
    const freeTextStage = definition.stages.findIndex((stage) =>
      stage.questions.some((q) => q.type === 'text' || q.type === 'textarea'),
    )
    if (freeTextStage >= 0) return freeTextStage
  }
  return 0
}

function findingMessage(finding: ConsistencyFinding, t: Translator): string {
  if (finding.kind === 'ai') return finding.message
  return t(`intake.consistency.rules.${finding.messageKey}`, finding.params)
}

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
          const targetStage = resolveReviseStage(definition, finding)
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
                <button
                  type="button"
                  onClick={() => onRevise(targetStage)}
                  className="inline-flex items-center gap-1 text-xs font-medium underline-offset-2 hover:underline"
                >
                  <PencilLine className="size-3" aria-hidden />
                  {t('intake.consistency.revise')}
                </button>
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

// ---------------------------------------------------------------------------
// Atomic field renderer — one per question type.
// ---------------------------------------------------------------------------

function QuestionField({
  question,
  answerKey,
  answers,
  projectId,
  error,
  onSetAnswer,
  onSetMode,
}: {
  question: ProjectIntakeQuestion
  answerKey: string
  answers: Answers
  projectId: string
  error: string | null
  onSetAnswer: (key: string, value: ProjectPrimitiveValue) => void
  onSetMode: (key: string, mode: IntakeAnswerMode) => void
}) {
  const t = useTranslations('projects')
  const value = answers[answerKey]
  const domId = `q-${answerKey}`

  if (question.type === 'info_placeholder') {
    return <InfoPlaceholder question={question} />
  }
  if (question.type === 'upload') {
    return <UploadField question={question} projectId={projectId} />
  }

  const header = (
    <QuestionHeader question={question} domId={domId} />
  )
  const errorText = error ? (
    <p id={`${domId}-error`} className="text-sm text-destructive">
      {error}
    </p>
  ) : null

  switch (question.type) {
    case 'text':
      return (
        <div className="flex flex-col gap-2">
          {header}
          <Input
            id={domId}
            type="text"
            value={typeof value === 'string' ? value : ''}
            placeholder={question.placeholder}
            aria-invalid={error ? true : undefined}
            onChange={(e) => onSetAnswer(answerKey, e.target.value)}
            className="max-w-md"
          />
          {errorText}
        </div>
      )
    case 'textarea':
      return (
        <div className="flex flex-col gap-2">
          {header}
          <Textarea
            id={domId}
            value={typeof value === 'string' ? value : ''}
            placeholder={question.placeholder}
            onChange={(e) => onSetAnswer(answerKey, e.target.value)}
            className="min-h-24 max-w-2xl"
          />
          {errorText}
        </div>
      )
    case 'number':
      return (
        <div className="flex flex-col gap-2">
          {header}
          <Input
            id={domId}
            type="number"
            inputMode="decimal"
            value={typeof value === 'number' ? value : typeof value === 'string' ? value : ''}
            aria-invalid={error ? true : undefined}
            onChange={(e) => {
              const raw = e.target.value
              if (raw === '') return onSetAnswer(answerKey, '')
              const parsed = Number(raw)
              onSetAnswer(answerKey, Number.isFinite(parsed) ? parsed : raw)
            }}
            className="max-w-40"
          />
          {errorText}
        </div>
      )
    case 'number_tri':
      return (
        <div className="flex flex-col gap-2">
          {header}
          <NumberTriControl
            domId={domId}
            question={question}
            value={value}
            mode={(answers[modeKeyFor(answerKey)] as IntakeAnswerMode) ?? 'wert'}
            onValue={(v) => onSetAnswer(answerKey, v)}
            onMode={(m) => onSetMode(answerKey, m)}
          />
          {errorText}
        </div>
      )
    case 'yes_no_open':
      return (
        <div className="flex flex-col gap-2">
          {header}
          <Segmented
            ariaLabel={question.label}
            value={typeof value === 'string' ? value : ''}
            options={[
              { value: 'ja', label: t('intake.yes') },
              { value: 'nein', label: t('intake.no') },
              { value: 'offen', label: t('intake.open'), tone: 'muted' },
            ]}
            onChange={(v) => onSetAnswer(answerKey, v)}
          />
          {errorText}
        </div>
      )
    case 'boolean':
      return (
        <div className="flex flex-col gap-2">
          {header}
          <Segmented
            ariaLabel={question.label}
            value={value === true ? 'ja' : value === false ? 'nein' : ''}
            options={[
              { value: 'ja', label: t('intake.yes') },
              { value: 'nein', label: t('intake.no') },
            ]}
            onChange={(v) => onSetAnswer(answerKey, v === 'ja')}
          />
          {errorText}
        </div>
      )
    case 'single_select':
      return (
        <div className="flex flex-col gap-2">
          {header}
          <Select
            value={typeof value === 'string' ? value : ''}
            onValueChange={(v) => onSetAnswer(answerKey, v)}
          >
            <SelectTrigger id={domId} className="w-full max-w-md" aria-invalid={error ? true : undefined}>
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
        <div className="flex flex-col gap-2">
          {header}
          <ChipMultiSelect
            question={question}
            value={Array.isArray(value) ? value : []}
            onChange={(next) => onSetAnswer(answerKey, next)}
          />
          {errorText}
        </div>
      )
    default:
      return null
  }
}

function QuestionHeader({ question, domId }: { question: ProjectIntakeQuestion; domId: string }) {
  const t = useTranslations('projects')
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2">
        <Label htmlFor={domId} className="text-sm font-medium">
          {question.label}
          {/* Mark the handful of hard-required fields so they're distinguishable
              from the ~90 soft ones BEFORE Next is pressed (error prevention),
              mirroring the FieldShell required marker used elsewhere. */}
          {question.required && (
            <span aria-hidden className="text-destructive"> *</span>
          )}
        </Label>
        {question.optional && (
          <span className="text-xs font-normal text-muted-foreground">{t('intake.optional')}</span>
        )}
      </div>
      {question.why && <WhyDisclosure why={question.why} />}
      {question.help && <p className="text-xs text-muted-foreground">{question.help}</p>}
    </div>
  )
}

/** "Warum fragen wir das?" — collapsible legal rationale. */
function WhyDisclosure({ why }: { why: string }) {
  const t = useTranslations('projects')
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="-my-2 inline-flex min-h-11 items-center gap-1 py-2 font-mono text-[11px] text-primary transition-colors hover:text-primary/80 md:my-0 md:min-h-0 md:py-0"
      >
        <ChevronDown className={cn('size-3 transition-transform', open && 'rotate-180')} aria-hidden />
        {t('intake.why')}
      </button>
      {open && (
        <p className="mt-1.5 max-w-xl border-l-2 border-primary/40 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
          {why}
        </p>
      )}
    </div>
  )
}

/** Number input with a value/estimate/open answer-mode segmented control. */
function NumberTriControl({
  domId,
  question,
  value,
  mode,
  onValue,
  onMode,
}: {
  domId: string
  question: ProjectIntakeQuestion
  value: ProjectPrimitiveValue
  mode: IntakeAnswerMode
  onValue: (v: ProjectPrimitiveValue) => void
  onMode: (m: IntakeAnswerMode) => void
}) {
  const t = useTranslations('projects')
  const disabled = mode === 'offen'
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={domId}
          type="number"
          inputMode="decimal"
          disabled={disabled}
          placeholder={question.placeholder}
          value={typeof value === 'number' ? value : typeof value === 'string' ? value : ''}
          onChange={(e) => {
            const raw = e.target.value
            if (raw === '') return onValue('')
            const parsed = Number(raw)
            onValue(Number.isFinite(parsed) ? parsed : raw)
          }}
          className="max-w-32 font-mono"
        />
        {question.unit && <span className="font-mono text-xs text-muted-foreground">{question.unit}</span>}
        <Segmented
          ariaLabel={t('intake.mode.aria')}
          size="sm"
          value={mode}
          options={[
            { value: 'wert', label: t('intake.mode.wert') },
            { value: 'geschaetzt', label: t('intake.mode.geschaetzt'), tone: 'warning' },
            { value: 'offen', label: t('intake.mode.offen'), tone: 'muted' },
          ]}
          onChange={(v) => onMode(v as IntakeAnswerMode)}
        />
      </div>
      {question.hint && <p className="max-w-xl text-xs text-muted-foreground">{question.hint}</p>}
    </div>
  )
}

type SegmentTone = 'default' | 'warning' | 'muted'

/** A compact segmented single-choice control (yes/no/open, answer modes). */
function Segmented({
  value,
  options,
  onChange,
  ariaLabel,
  size = 'md',
}: {
  value: string
  options: { value: string; label: string; tone?: SegmentTone }[]
  onChange: (value: string) => void
  ariaLabel: string
  size?: 'sm' | 'md'
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex w-fit flex-wrap self-start overflow-hidden rounded-lg border border-border"
    >
      {options.map((opt, i) => {
        const active = value === opt.value
        const tone = opt.tone ?? 'default'
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              'inline-flex items-center justify-center border-border transition-colors',
              i > 0 && 'border-l',
              // Comfortable tap targets on touch screens; denser on desktop pointers.
              size === 'sm'
                ? 'min-h-9 px-3 text-xs font-medium md:min-h-8 md:px-2.5 md:text-[11px]'
                : 'min-h-11 px-4 text-sm md:min-h-9 md:px-3.5',
              !active && 'bg-card text-foreground hover:bg-muted',
              active && tone === 'default' && 'bg-primary text-primary-foreground',
              active && tone === 'warning' && 'bg-warning text-white',
              active && tone === 'muted' && 'bg-muted-foreground text-background',
            )}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

/** Multi-select rendered as toggleable chips. */
function ChipMultiSelect({
  question,
  value,
  onChange,
}: {
  question: ProjectIntakeQuestion
  value: string[]
  onChange: (next: string[]) => void
}) {
  return (
    <div className="flex max-w-2xl flex-wrap gap-2">
      {(question.options ?? []).map((opt) => {
        const active = value.includes(opt.value)
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(active ? value.filter((v) => v !== opt.value) : [...value, opt.value])}
            className={cn(
              'inline-flex min-h-11 items-center justify-center rounded-full border px-4 py-1.5 text-sm transition-colors md:min-h-9 md:px-3.5',
              active
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-card text-foreground hover:border-primary/50 hover:bg-primary/5',
            )}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

/** Upload slot — directs the user to the project's Files tab (v1: no in-wizard upload). */
function UploadField({ question, projectId }: { question: ProjectIntakeQuestion; projectId: string }) {
  const t = useTranslations('projects')
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">{question.label}</span>
      <Link
        href={`/app/projects/${projectId}/files`}
        className="inline-flex max-w-md items-center gap-3 rounded-lg border border-dashed border-border bg-muted/20 px-4 py-3 text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-foreground"
      >
        <FolderOpen className="size-4 shrink-0 text-primary" aria-hidden />
        <span>{t('intake.upload.hint')}</span>
      </Link>
    </div>
  )
}

/** Placeholder marking where a phase-2 system derivation will appear. */
function InfoPlaceholder({ question }: { question: ProjectIntakeQuestion }) {
  const t = useTranslations('projects')
  return (
    <div className="rounded-xl border border-dashed bg-muted/30 px-4 py-3.5">
      <div className="flex items-start gap-2.5">
        <Sparkles className="size-4 shrink-0 translate-y-0.5 text-primary" aria-hidden />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">{question.label}</p>
            <Badge variant="info">{t('intake.derived.badge')}</Badge>
          </div>
          {question.hint && <p className="mt-1 text-xs text-muted-foreground">{question.hint}</p>}
        </div>
      </div>
    </div>
  )
}
