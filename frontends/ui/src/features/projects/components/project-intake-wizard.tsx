'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Check,
  FolderOpen,
  HelpCircle,
  Loader2,
  PencilLine,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { AnimatePresence, motion, springGlide } from '@/components/motion'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { SectionLabel } from '@/components/ui/section-label'
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
import { DocumentRoleField } from './document-role-field'
import { ProjektgrundlagenStep } from './projektgrundlagen-step'
import {
  answerKeyFor,
  bauwerkIdFromAnswerKey,
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

/**
 * Horizontal twin of the `scroll-fade-bottom` utility (`app/globals.css`): the
 * edges of a horizontally scrolling strip dissolve so a clipped step reads as
 * "there is more sideways", not as broken chrome.
 *
 * It is a MASK, deliberately. The overlay gradients this replaced painted
 * `from-background to-transparent`, which (a) is a gradient — a Do-not in
 * `grid-design-language.md` — and (b) hard-codes the surface, so the fade would
 * be visibly wrong the moment the wizard sits on a card or in a dialog. A mask
 * composites against whatever is actually behind it and names no colour.
 *
 * FOLLOW-UP for the `app/globals.css` owner: this belongs beside
 * `scroll-fade-bottom` as `@utility scroll-fade-x`, with the same
 * `--scroll-fade-size` var. It is inline here only because that file is not
 * this change's to edit.
 */
const SCROLL_FADE_X =
  'linear-gradient(to right, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)'

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
  /** Preview/deep-link entry module (index). A restored draft still wins. */
  initialStep?: number
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
  profileVersion: number | null
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
function isQuestionSatisfied(
  question: ProjectIntakeQuestion,
  answers: Answers,
  answerKey: string
): boolean {
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
  initialStep = 0,
}: ProjectIntakeWizardProps) {
  const t = useTranslations('projects')
  const { locale } = useLocale()
  const router = useRouter()
  const [definition, setDefinition] = useState<ProjectIntakeDefinition | null>(null)
  const [loading, setLoading] = useState(true)
  const [currentStep, setCurrentStep] = useState(initialStep)
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
  // Schnellstart (spec `core_flag`): show only Kernfragen. Everything skipped is
  // persisted with mode 'offen', which is already what an unanswered question
  // becomes — so the mode is a VIEW, not a second answer state to reconcile.
  const [quickStart, setQuickStart] = useState(false)
  // Modules where the user chose "alle anzeigen" despite Schnellstart.
  const [expandedStages, setExpandedStages] = useState<Set<string>>(new Set())

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
          r.ok
            ? (r.json() as Promise<ProjectIntakeDefinition>)
            : Promise.reject(new Error('Failed to load'))
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
          } satisfies IntakeDraft)
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

  const stages = useMemo(() => definition?.stages ?? [], [definition])
  const totalSteps = stages.length
  const stage: ProjectIntakeStage | null = stages[currentStep] ?? null
  const isReview = stage?.id === 'H'
  /** Modul I renders document slots from the role registry, not questions. */
  const isGrundlagen = stage?.id === 'I'

  const setAnswer = useCallback(
    (key: string, value: ProjectPrimitiveValue) => {
      setAnswers((prev) => pruneStaleConditionalAnswers({ ...prev, [key]: value }, definition))
      setFindings(null)
      setTouched((prev) => {
        if (!prev.has(key)) return prev
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    },
    [definition]
  )

  const setMode = useCallback(
    (answerKey: string, nextMode: IntakeAnswerMode) => {
      setAnswers((prev) => {
        const next = { ...prev, [modeKeyFor(answerKey)]: nextMode }
        if (nextMode === 'offen') delete next[answerKey]
        return pruneStaleConditionalAnswers(next, definition)
      })
      setFindings(null)
    },
    [definition]
  )

  /** Visible questions on a projekt/grundstueck stage (bauwerk stages iterate instances). */
  const stageVisibleQuestions = useMemo(() => {
    if (!stage || stage.scope === 'bauwerk') return []
    return stage.questions.filter((q) => evaluateIntakeCondition(q, answers))
  }, [stage, answers])

  /** Whether Schnellstart is currently narrowing THIS module. */
  const stageQuickStarted = quickStart && stage != null && !expandedStages.has(stage.id)

  /**
   * What the module actually renders. Validation still runs against the full
   * visible set — a required question hidden by Schnellstart would otherwise
   * let the user past a gate the spec keeps closed (only A1/A2/A5 are required,
   * and all of them are core, so in practice this never bites; it is here so a
   * later `required: true` on a non-core question cannot open a hole).
   */
  const flatVisibleQuestions = useMemo(() => {
    if (!stageQuickStarted) return stageVisibleQuestions
    return stageVisibleQuestions.filter((q) => q.core || q.required)
  }, [stageQuickStarted, stageVisibleQuestions])

  const hiddenByQuickStart = stageVisibleQuestions.length - flatVisibleQuestions.length

  /**
   * The stage a bauwerk module renders under Schnellstart.
   *
   * Required questions survive the filter for the same reason they do on a
   * project-scope module: narrowing the view must never narrow the gate.
   */
  const quickStartStage = useMemo(() => {
    if (!stage) return stage
    if (!stageQuickStarted) return stage
    return { ...stage, questions: stage.questions.filter((q) => q.core || q.required) }
  }, [stage, stageQuickStarted])

  const stageValid = useMemo(() => {
    if (!stage) return true
    if (stage.scope === 'bauwerk') {
      return bauwerke.every((bw) =>
        stage.questions
          .filter((q) => evaluateIntakeCondition(q, answers, bw.id))
          .every((q) => isQuestionSatisfied(q, answers, answerKeyFor(q.id, bw.id)))
      )
    }
    return stageVisibleQuestions.every((q) => isQuestionSatisfied(q, answers, q.id))
  }, [stage, bauwerke, answers, stageVisibleQuestions])

  /**
   * Answered / total per module, for the rail.
   *
   * Counts only questions currently VISIBLE (a conditional question the project
   * never reaches is not an unanswered one) and only those that write an answer
   * — an `info_placeholder` or a `document_role` slot has nothing to satisfy.
   * Bauwerk modules count across every building, which is what makes "3 von 14"
   * on module C honest when there are two buildings.
   */
  const stageProgress = useMemo(() => {
    const counts = new Map<string, { answered: number; total: number }>()
    for (const s of stages) {
      let answered = 0
      let total = 0
      const tally = (q: ProjectIntakeQuestion, key: string) => {
        if (q.type === 'info_placeholder' || q.type === 'document_role' || q.type === 'upload')
          return
        total += 1
        if (isIntakeAnswerProvided(answers[key]) || answers[modeKeyFor(key)] === 'offen')
          answered += 1
      }
      if (s.scope === 'bauwerk') {
        for (const bw of bauwerke) {
          for (const q of s.questions) {
            if (evaluateIntakeCondition(q, answers, bw.id)) tally(q, answerKeyFor(q.id, bw.id))
          }
          for (const zone of zoneQuestionsFor(s, bw.id, answers)) {
            tally(zone.question, answerKeyFor(zone.question.id, bw.id, zone.use))
          }
        }
      } else {
        for (const q of s.questions) {
          if (evaluateIntakeCondition(q, answers)) tally(q, q.id)
        }
      }
      counts.set(s.id, { answered, total })
    }
    return counts
  }, [stages, answers, bauwerke])

  /**
   * Record every unanswered question in this module as explicitly open.
   *
   * The spec's per-module "Rest überspringen – als offen übernehmen". Writing
   * mode 'offen' rather than leaving the answer absent is the whole point: both
   * produce an `unknown` in the profile, but only the explicit one can be told
   * apart from "not reached yet" in Modul H's completion checklist.
   */
  const skipRestOfStage = useCallback(() => {
    if (!stage) return
    setAnswers((prev) => {
      const next = { ...prev }
      const markOpen = (q: ProjectIntakeQuestion, key: string) => {
        if (q.type === 'info_placeholder' || q.type === 'document_role' || q.type === 'upload')
          return
        if (q.required) return
        if (isIntakeAnswerProvided(next[key])) return
        if (q.type === 'yes_no_open') {
          // Its own third state, not a mode sibling — so the control renders as
          // "noch offen" rather than merely unselected.
          next[key] = 'offen'
          return
        }
        next[modeKeyFor(key)] = 'offen'
        delete next[key]
      }
      if (stage.scope === 'bauwerk') {
        for (const bw of bauwerke) {
          for (const q of stage.questions) {
            if (evaluateIntakeCondition(q, next, bw.id)) markOpen(q, answerKeyFor(q.id, bw.id))
          }
          // Modul D renders a question set per selected use. Skipping the
          // module while leaving those on screen unanswered is not skipping it.
          for (const zone of zoneQuestionsFor(stage, bw.id, next)) {
            markOpen(zone.question, answerKeyFor(zone.question.id, bw.id, zone.use))
          }
        }
      } else {
        for (const q of stage.questions) {
          if (evaluateIntakeCondition(q, next)) markOpen(q, q.id)
        }
      }
      return pruneStaleConditionalAnswers(next, definition)
    })
    setFindings(null)
  }, [stage, bauwerke, definition])

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
    [totalSteps]
  )

  const markStageTouched = useCallback(() => {
    if (!stage) return
    setTouched((prev) => {
      const next = new Set(prev)
      if (stage.scope === 'bauwerk') {
        for (const bw of bauwerke) {
          for (const q of stage.questions) {
            const key = answerKeyFor(q.id, bw.id)
            if (evaluateIntakeCondition(q, answers, bw.id) && !isQuestionSatisfied(q, answers, key))
              next.add(key)
          }
        }
      } else {
        for (const q of stageVisibleQuestions) {
          if (!isQuestionSatisfied(q, answers, q.id)) next.add(q.id)
        }
      }
      return next
    })
  }, [stage, bauwerke, answers, stageVisibleQuestions])

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
  }, [
    definition,
    answers,
    bauwerke,
    initialProfile,
    initialProfileVersion,
    projectId,
    projectName,
    router,
    STORAGE_KEY,
    t,
  ])

  const reloadAfterConflict = useCallback(() => {
    setError(null)
    setConflict(false)
    router.refresh()
  }, [router])

  /**
   * The first unanswered required question anywhere in the definition.
   *
   * Per-stage validation only guards the Next button, which was enough while
   * the only way forward was linear. It is not enough now: Modul H declares no
   * required questions of its own, so ANY route that lands on it — the module
   * rail, a restored draft's `currentStep`, a condition that turned a required
   * question visible after it was passed — reaches a Save that would persist a
   * profile without A1/A2/A5.
   *
   * Guarding the save rather than re-locking the rail is deliberate. Locking
   * navigation would close one route to a gate that is missing, and take the
   * rail's whole point with it; this closes the gate.
   */
  const firstMissingRequired = useCallback((): { stageIndex: number; key: string } | null => {
    if (!definition) return null
    for (const [stageIndex, s] of definition.stages.entries()) {
      if (s.scope === 'bauwerk') {
        for (const bw of bauwerke) {
          for (const q of s.questions) {
            if (!q.required) continue
            const key = answerKeyFor(q.id, bw.id)
            if (!evaluateIntakeCondition(q, answers, bw.id)) continue
            if (!isQuestionSatisfied(q, answers, key)) return { stageIndex, key }
          }
        }
        continue
      }
      for (const q of s.questions) {
        if (!q.required) continue
        if (!evaluateIntakeCondition(q, answers)) continue
        if (!isQuestionSatisfied(q, answers, q.id)) return { stageIndex, key: q.id }
      }
    }
    return null
  }, [definition, bauwerke, answers])

  const handleSave = useCallback(async () => {
    if (!definition) return

    const missing = firstMissingRequired()
    if (missing) {
      // Land the user ON the unanswered question with its error showing, rather
      // than refusing from the summary with nothing to act on.
      setTouched((previous) => new Set(previous).add(missing.key))
      goToStep(missing.stageIndex)
      return
    }

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
      console.error(
        '[ProjectIntakeWizard] Pre-save consistency gate threw; saving anyway (fail-open):',
        e
      )
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
          const data = (await res.json().catch(() => null)) as {
            findings?: ConsistencyFinding[] | null
          } | null
          if (data?.findings) aiFindings = data.findings
        } else {
          console.warn(
            '[ProjectIntakeWizard] Consistency check returned a non-ok status (non-fatal):',
            res.status
          )
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
  }, [
    definition,
    conflictCheckEnabled,
    answers,
    projectId,
    locale,
    runSave,
    firstMissingRequired,
    goToStep,
  ])

  const handleProceedAnyway = useCallback(() => {
    void runSave()
  }, [runSave])

  const handleReviseAt = useCallback(
    (stageIndex: number) => {
      setFindings(null)
      goToStep(stageIndex)
    },
    [goToStep]
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
    <div className="mx-auto max-w-6xl px-4 py-6 md:py-10">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <SectionLabel>
            {isEdit ? t('intake.eyebrowEdit') : t('intake.eyebrowCreate')}
          </SectionLabel>
          <h1 className="mt-1 truncate text-xl font-semibold tracking-tight">
            {projectName || t('intake.titleFallback')}
          </h1>
          <p className="text-muted-foreground mt-1 max-w-prose text-sm">{t('intake.subtitle')}</p>
        </div>
        <QuickStartToggle
          enabled={quickStart}
          onToggle={() => {
            setQuickStart((previous) => !previous)
            setExpandedStages(new Set())
          }}
          t={t}
        />
      </header>

      {salvageNotice && (
        <Alert variant="warning" className="mb-6">
          <AlertTriangle aria-hidden />
          <AlertDescription>
            {salvageNotice === 'full' ? t('intake.salvage.full') : t('intake.salvage.partial')}
          </AlertDescription>
        </Alert>
      )}

      {/* Two columns from `lg`: a persistent module rail beside the questions.
          The horizontal A–H stepper this replaced truncated every label past
          eight characters ("Grundstück …", "Zusammenfa…"), which is the one job
          a module nav has. Vertically there is room for the real title AND a
          per-module count, so the rail answers "where am I / what is left"
          without the user opening a module to find out. Below `lg` it collapses
          to the same scrolling strip, where truncation is at least a real
          space constraint rather than a layout choice. */}
      <div className="lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start lg:gap-10">
        <ModuleRail
          stages={stages}
          currentStep={currentStep}
          progress={stageProgress}
          onSelect={goToStep}
          activeStepRef={activeStepRef}
          t={t}
        />

        <div className="min-w-0 lg:max-w-2xl">
          <div className="mb-6 flex items-center justify-between gap-4">
            <Progress value={progress} className="h-1 flex-1" />
            <span
              className={cn(
                'shrink-0 text-xs transition-opacity duration-quick ease-out motion-reduce:transition-none',
                draftSaved ? 'text-success opacity-100' : 'text-muted-foreground opacity-0'
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
                transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
              >
                <div className="mb-6">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-primary font-mono text-xs">Modul {stage.id}</span>
                      <span className="text-muted-foreground text-xs">
                        {currentStep + 1}/{totalSteps}
                      </span>
                    </div>
                    {/* Per-module "Rest überspringen – als offen übernehmen". Only
                      where there is something to skip, and never on the two
                      modules that carry no questions to skip. */}
                    {!isReview &&
                      !isGrundlagen &&
                      stageProgress.get(stage.id) !== undefined &&
                      stageProgress.get(stage.id)!.answered <
                        stageProgress.get(stage.id)!.total && (
                        <Button type="button" variant="ghost" size="sm" onClick={skipRestOfStage}>
                          {t('intake.skipRest')}
                        </Button>
                      )}
                  </div>
                  <h2 className="mt-1 text-lg font-semibold tracking-tight">{stage.title}</h2>
                  {stage.description && (
                    <p className="text-muted-foreground mt-1 max-w-prose text-sm">
                      {stage.description}
                    </p>
                  )}
                </div>

                {isGrundlagen ? (
                  <ProjektgrundlagenStep
                    projectId={projectId}
                    answers={answers}
                    bauwerke={bauwerke}
                  />
                ) : isReview ? (
                  <div className="space-y-4">
                    <ReviewStep
                      definition={definition}
                      answers={answers}
                      bauwerke={bauwerke}
                      onEditStage={(stageIndex) => goToStep(stageIndex)}
                    />
                    {checking && (
                      <div
                        className="text-muted-foreground flex items-center gap-2 text-sm"
                        aria-live="polite"
                      >
                        <Loader2
                          className="size-4 animate-spin motion-reduce:animate-none"
                          aria-hidden
                        />
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
                    // Schnellstart is a view over the QUESTIONS, so it has to be
                    // applied here as well: passing the raw stage left modules
                    // C, D and E showing every question while the toggle claimed
                    // to be showing only Kernfragen.
                    stage={quickStartStage}
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
                    {/* Says what Schnellstart is hiding, and offers it here. A
                      count the user cannot act on would just be a nag. */}
                    {hiddenByQuickStart > 0 && (
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-dashed px-4 py-3">
                        <span className="text-muted-foreground text-sm">
                          {t('intake.hiddenByQuickstart', { count: hiddenByQuickStart })}
                        </span>
                        <Button
                          type="button"
                          variant="link"
                          size="sm"
                          className="h-auto p-0"
                          onClick={() =>
                            setExpandedStages((previous) => new Set(previous).add(stage.id))
                          }
                        >
                          {t('intake.showAllHere')}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </motion.div>
            </AnimatePresence>

            {error && definition && (
              <Alert variant="destructive" className="mt-8">
                <AlertDescription
                  className={conflict ? 'flex flex-col items-start gap-3' : undefined}
                >
                  <span>{error}</span>
                  {conflict && (
                    <Button type="button" variant="outline" size="sm" onClick={reloadAfterConflict}>
                      {t('intake.conflictReload')}
                    </Button>
                  )}
                </AlertDescription>
              </Alert>
            )}

            <div className="bg-background/85 sticky bottom-0 z-20 -mx-4 mt-10 flex items-center justify-between gap-4 border-t px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 backdrop-blur-md">
              <Button
                type="button"
                variant="outline"
                onClick={() => goToStep(currentStep - 1)}
                disabled={currentStep === 0 || saving}
              >
                {t('intake.back')}
              </Button>

              <span className="text-muted-foreground text-xs">
                {t('intake.stepCounter', { current: currentStep + 1, total: totalSteps })}
              </span>

              {isReview ? (
                findings && findings.length > 0 ? (
                  <span aria-hidden className="inline-flex min-h-9 min-w-36" />
                ) : (
                  <Button type="submit" disabled={saving || checking} className="min-w-36">
                    <Loader2
                      className={
                        saving || checking
                          ? 'size-4 animate-spin motion-reduce:animate-none'
                          : 'size-4 opacity-0'
                      }
                      aria-hidden
                    />
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
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Module rail — the wizard's primary orientation surface.
// ---------------------------------------------------------------------------

/**
 * The A–I module list, vertical on desktop and a scrolling strip below `lg`.
 *
 * Each row carries the module's real title and its answered/total count, which
 * is the pair that answers "where am I and what is left" at a glance. The
 * horizontal stepper this replaced could show neither: at eight modules across
 * a 3xl column every label truncated to about eight characters, so the nav read
 * "Grundstück …", "Technik & En…", "Zusammenfa…" — three labels that are the
 * same word to a reader scanning for where to click.
 *
 * Rows stay reachable in BOTH directions. Forward navigation to an unvisited
 * module is deliberate: the spec's validation is soft everywhere but A1/A2/A5,
 * so a locked-until-complete rail would enforce a gate the questionnaire does
 * not have, and an architect who wants to fill in the Bauwerk geometry first
 * should be able to.
 */
function ModuleRail({
  stages,
  currentStep,
  progress,
  onSelect,
  activeStepRef,
  t,
}: {
  stages: ProjectIntakeStage[]
  currentStep: number
  progress: Map<string, { answered: number; total: number }>
  onSelect: (step: number) => void
  activeStepRef: MutableRefObject<HTMLButtonElement | null>
  t: Translator
}) {
  return (
    <nav aria-label={t('intake.moduleNavAria')} className="mb-6 lg:sticky lg:top-6 lg:mb-0">
      <SectionLabel className="mb-2 hidden lg:block">{t('intake.moduleNav')}</SectionLabel>
      <ol
        className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 lg:mx-0 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:px-0 lg:pb-0"
        style={{ maskImage: SCROLL_FADE_X, WebkitMaskImage: SCROLL_FADE_X }}
      >
        {stages.map((stage, index) => {
          const state =
            index < currentStep ? 'visited' : index === currentStep ? 'current' : 'upcoming'
          const counts = progress.get(stage.id)
          const complete =
            counts !== undefined && counts.total > 0 && counts.answered === counts.total
          return (
            <li key={stage.id} className="shrink-0 lg:shrink">
              <button
                type="button"
                ref={state === 'current' ? activeStepRef : undefined}
                onClick={() => onSelect(index)}
                aria-current={state === 'current' ? 'step' : undefined}
                className={cn(
                  'duration-quick focus-visible:ring-ring/40 group flex w-20 flex-col items-center gap-1.5 rounded-lg px-1 py-1.5 text-left outline-none transition-colors ease-out focus-visible:ring-2 motion-reduce:transition-none',
                  'lg:w-full lg:flex-row lg:items-center lg:gap-2.5 lg:px-2 lg:py-2',
                  state === 'current' ? 'lg:bg-muted' : 'lg:hover:bg-muted/50'
                )}
              >
                <span
                  className={cn(
                    'duration-quick flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium transition-colors ease-out motion-reduce:transition-none',
                    complete &&
                      state !== 'current' &&
                      'border-primary bg-primary text-primary-foreground',
                    state === 'current' && 'border-primary text-primary ring-ring/30 ring-2',
                    !complete && state !== 'current' && 'border-border text-muted-foreground'
                  )}
                >
                  {/* The step NUMBER, not `stage.id`. Modul I (Projektgrundlagen)
                      deliberately runs before Modul H (Zusammenfassung) — the
                      documents are inputs to the B and C answers, and the
                      summary is the save gate, so it has to be last — which
                      makes a letter column read "… G, I, H" and look like a
                      bug. The letter still anchors the content header, where it
                      ties back to the spec. */}
                  {complete && state !== 'current' ? (
                    <Check className="size-3.5" aria-hidden />
                  ) : (
                    index + 1
                  )}
                </span>
                <span className="w-full min-w-0 lg:flex lg:flex-col">
                  <span
                    className={cn(
                      'block truncate text-center text-[11px] leading-tight lg:text-left lg:text-sm',
                      state === 'current' ? 'text-foreground font-medium' : 'text-muted-foreground'
                    )}
                  >
                    {stage.title}
                  </span>
                  {/* Counts on the rail only: on the mobile strip they would not
                      fit under a 20-unit-wide pill without truncating the title
                      they are meant to annotate. */}
                  {counts !== undefined && counts.total > 0 && (
                    <span className="text-muted-foreground hidden text-xs lg:block">
                      {complete
                        ? t('intake.moduleDone')
                        : t('intake.moduleProgress', {
                            answered: counts.answered,
                            total: counts.total,
                          })}
                    </span>
                  )}
                </span>
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

/**
 * Schnellstart switch (spec `core_flag`).
 *
 * A view, not a second answer state: it narrows each module to its Kernfragen,
 * and everything it hides is already what an unanswered question becomes — an
 * unknown. That is why turning it off cannot lose an answer, and why the copy
 * can promise the skipped questions come back in the summary's checklist.
 */
function QuickStartToggle({
  enabled,
  onToggle,
  t,
}: {
  enabled: boolean
  onToggle: () => void
  t: Translator
}) {
  return (
    <div className="flex items-start gap-3">
      <Button
        type="button"
        variant={enabled ? 'default' : 'outline'}
        size="sm"
        onClick={onToggle}
        aria-pressed={enabled}
        className="shrink-0"
      >
        <Sparkles className="size-4" aria-hidden />
        {t('intake.schnellstart')}
      </Button>
      <p className="text-muted-foreground max-w-[24rem] text-xs leading-snug">
        {enabled ? t('intake.schnellstartOn') : t('intake.schnellstartOff')}
      </p>
    </div>
  )
}

/**
 * The zone questions a building currently renders (Modul D).
 *
 * Zones are implicit: each use selected in `D0` expands into `zoneCommon` plus
 * that use's own set. Anything walking a bauwerk stage has to expand them too,
 * or it silently sees a module of three questions where the user sees thirty —
 * which is how both the per-module count and "Rest überspringen" came to ignore
 * every field in Modul D.
 */
function zoneQuestionsFor(
  stage: ProjectIntakeStage,
  bauwerkId: string,
  answers: Answers
): Array<{ question: ProjectIntakeQuestion; use: string }> {
  if (!stage.zoneCommon && !stage.zoneDefinitions) return []
  const selected = answers[answerKeyFor('D0', bauwerkId)]
  if (!Array.isArray(selected)) return []
  const out: Array<{ question: ProjectIntakeQuestion; use: string }> = []
  for (const use of selected) {
    const key = String(use)
    for (const question of [
      ...(stage.zoneCommon ?? []),
      ...(stage.zoneDefinitions?.[key]?.questions ?? []),
    ]) {
      out.push({ question, use: key })
    }
  }
  return out
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
        <div key={bw.id} className="bg-card shadow-xs overflow-hidden rounded-2xl border">
          <div className="bg-muted/40 flex items-center gap-3 border-b px-4 py-2.5">
            <Badge variant="default" className="font-mono">
              {bw.id.toUpperCase()}
            </Badge>
            {canManage ? (
              <input
                value={bw.name}
                onChange={(e) => onRenameBauwerk(bw.id, e.target.value)}
                aria-label={t('intake.bauwerk.nameAria')}
                // A raw `<input>`, so none of the Input primitive's phone
                // handling reaches it: at 14px iOS Safari zooms the page in when
                // the field takes focus — mid-way through a nine-step wizard, on
                // the field that renames the building everything after it refers
                // to. `pointer-coarse:text-base` is the same treatment
                // `ui/input.tsx` and the chat composer carry, on the same axis.
                // The height comes with it: 25px was half the floor for a control
                // whose whole affordance is a dashed underline you have to find.
                enterKeyHint="done"
                className="hover:border-border focus:border-primary min-w-0 flex-1 border-b border-dashed border-transparent bg-transparent py-0.5 text-sm font-medium outline-none pointer-coarse:py-2.5 pointer-coarse:text-base"
              />
            ) : (
              <span className="flex-1 truncate text-sm font-medium">{bw.name}</span>
            )}
            {canManage && bauwerke.length > 1 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onRemoveBauwerk(bw.id)}
                className="text-muted-foreground hover:text-destructive h-auto gap-1 px-2 py-1 text-xs"
              >
                <Trash2 className="size-3.5" aria-hidden />
                {t('intake.bauwerk.remove')}
              </Button>
            )}
          </div>

          <div className="space-y-6 px-4 py-5 md:px-6">
            {(() => {
              const visible = stage.questions.filter((q) =>
                evaluateIntakeCondition(q, answers, bw.id)
              )
              // Track the group ACROSS the filtered list, so a heading whose
              // first question is hidden still opens on the next one that is
              // visible — and a group with nothing visible prints no heading.
              let openGroup: string | undefined
              return visible.map((q) => {
                const answerKey = answerKeyFor(q.id, bw.id)
                const heading = q.group && q.group !== openGroup ? q.group : null
                if (q.group) openGroup = q.group
                return (
                  <div key={answerKey} className={heading ? 'space-y-6 pt-2' : undefined}>
                    {heading && (
                      <h3 className="text-muted-foreground border-b pb-2 text-xs font-medium uppercase tracking-wide">
                        {heading}
                      </h3>
                    )}
                    <QuestionField
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
                  </div>
                )
              })
            })()}

            {/* Module D: implicit use-zones expanded from D0. */}
            {stage.id === 'D' && (
              <ZoneBlocks
                stage={stage}
                bw={bw}
                answers={answers}
                onSetAnswer={onSetAnswer}
                onSetMode={onSetMode}
                projectId={projectId}
              />
            )}
          </div>
          {index === bauwerke.length - 1 && canManage && (
            <div className="border-t px-4 py-3 md:px-6">
              <button
                type="button"
                onClick={onAddBauwerk}
                className="border-border text-muted-foreground hover:border-primary/60 hover:bg-primary/5 hover:text-primary inline-flex w-full items-center justify-center gap-2 rounded-lg border border-dashed py-2.5 font-mono text-xs transition-colors duration-quick ease-out motion-reduce:transition-none"
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
        const zoneQuestions = [
          ...(stage.zoneCommon ?? []),
          ...(stage.zoneDefinitions?.[use]?.questions ?? []),
        ]
        if (zoneQuestions.length === 0) return null
        return (
          // The zone grouping is a quiet surface off the four-token ladder
          // (`bg-muted`), not a 5% tint of the ACTION ink: `bg-primary/5`
          // invented a fifth surface that no token controls. The left rule
          // stays — it is INK, which is allowed; `border` + `border-l-2` used
          // to draw that edge twice, so the shorthand now names the other
          // three sides only.
          <div
            key={use}
            className="border-l-primary bg-muted rounded-xl border-y border-l-2 border-r px-4 py-4"
          >
            <p className="text-primary mb-3 font-mono text-[11px] uppercase tracking-wider">
              Zone · {label}
            </p>
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
  instanceId?: string
): ReviewItem[] {
  const items: ReviewItem[] = []
  for (const q of questions) {
    if (q.type === 'info_placeholder' || q.type === 'upload' || q.type === 'document_role') continue
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
      else if (raw === 'ja' || raw === 'nein')
        items.push({ label: q.label, value: raw === 'ja' ? 'Ja' : 'Nein' })
      continue
    }
    // A plain question can be explicitly open too: "Rest überspringen" records
    // an unanswered one as mode 'offen'. Reading the sibling only for
    // `number_tri` made every skipped text/select question vanish from this
    // checklist — the one place the feature promises they reappear.
    if (answers[modeKeyFor(key)] === 'offen') {
      items.push({ label: q.label, value: '—', mode: 'offen' })
      continue
    }
    if (isIntakeAnswerProvided(raw))
      items.push({ label: q.label, value: formatIntakeAnswer(q, raw) })
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
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors duration-quick ease-out motion-reduce:transition-none"
          >
            <PencilLine className="size-3" aria-hidden />
            {editLabel}
          </button>
        )}
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
        {items.map((item, i) => (
          <div key={i} className="flex flex-col">
            <dt className="text-muted-foreground text-xs">{item.label}</dt>
            <dd
              className={cn(
                'mt-0.5 text-sm',
                item.mode === 'offen' ? 'text-muted-foreground' : 'font-medium'
              )}
            >
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
    // `H` is the summary itself. `I` holds document slots rather than answers,
    // so it would render as an empty section here — the bindings live in
    // `document_roles`, not in the answer map this summarises.
    .filter(({ stage }) => stage.scope !== 'bauwerk' && stage.id !== 'H' && stage.id !== 'I')
  const bauwerkStages = definition.stages
    .map((stage, index) => ({ stage, index }))
    .filter(({ stage }) => stage.scope === 'bauwerk')

  return (
    <div className="space-y-4">
      <div className="divide-border bg-card shadow-xs divide-y overflow-hidden rounded-2xl border">
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
          items.push(
            ...reviewItemsFor(stage.questions, answers, (q) => answerKeyFor(q.id, bw.id), bw.id)
          )
          const uses = answers[answerKeyFor('D0', bw.id)]
          if (Array.isArray(uses)) {
            for (const use of uses) {
              const zoneQs = [
                ...(stage.zoneCommon ?? []),
                ...(stage.zoneDefinitions?.[use]?.questions ?? []),
              ]
              items.push(
                ...reviewItemsFor(zoneQs, answers, (q) => answerKeyFor(q.id, bw.id, use), bw.id)
              )
            }
          }
        }
        if (items.length === 0) return null
        return (
          <div key={bw.id} className="bg-card shadow-xs overflow-hidden rounded-2xl border">
            <ReviewSection
              title={bw.name}
              editLabel={t('intake.edit')}
              onEdit={() => onEditStage(bauwerkStages[0]?.index ?? 0)}
              items={items}
            />
          </div>
        )
      })}

      <div className="bg-muted/30 rounded-2xl border border-dashed p-5">
        <div className="flex items-start gap-2">
          <Sparkles className="text-primary size-4 shrink-0 translate-y-0.5" aria-hidden />
          <div>
            <p className="text-sm font-medium">{t('intake.classification.title')}</p>
            <p className="text-muted-foreground mt-1 text-sm">
              {t('intake.classification.description')}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Findings panel (unchanged behaviour, adapted to modules).
// ---------------------------------------------------------------------------

function resolveReviseStage(
  definition: ProjectIntakeDefinition,
  finding: ConsistencyFinding
): number {
  for (const label of finding.fields) {
    const idx = definition.stages.findIndex((stage) =>
      stage.questions.some((q) => q.label === label)
    )
    if (idx >= 0) return idx
  }
  if (finding.kind === 'ai') {
    const freeTextStage = definition.stages.findIndex((stage) =>
      stage.questions.some((q) => q.type === 'text' || q.type === 'textarea')
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
    <section
      aria-label={t('intake.consistency.title')}
      className="bg-card shadow-xs rounded-2xl border p-5"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="text-warning size-4 shrink-0 translate-y-0.5" aria-hidden />
        <div>
          <h3 className="text-sm font-semibold">{t('intake.consistency.title')}</h3>
          <p className="text-muted-foreground mt-0.5 text-sm">{t('intake.consistency.subtitle')}</p>
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
                // `border-destructive` is a real theme colour (`--color-destructive`
                // in the `@theme inline` block), so its slash form compiles.
                // `border-warning` is a static `@utility` with no `--modifier()`,
                // so `border-warning/40` compiled to nothing and the soft-warning
                // row was outlined in the neutral default. The warning border token
                // is already ~55% alpha; the solid class is the intended edge.
                isHard
                  ? 'border-destructive/30 bg-danger-subtle text-destructive'
                  : 'border-warning bg-warning-subtle text-warning'
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
              <p className="text-foreground mt-1">{findingMessage(finding, t)}</p>
              {finding.fields.length > 0 && (
                <p className="text-muted-foreground mt-1.5 text-xs">{finding.fields.join(' · ')}</p>
              )}
            </li>
          )
        })}
      </ul>

      <div className="mt-4 flex items-center justify-end">
        <Button type="button" onClick={onProceed} disabled={saving} className="min-w-36">
          <Loader2
            className={
              saving ? 'size-4 animate-spin motion-reduce:animate-none' : 'size-4 opacity-0'
            }
            aria-hidden
          />
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
  if (question.type === 'document_role') {
    // A role question has no answer in the profile: the binding lives in
    // `document_roles`. Without a role it has nothing to bind, so it renders
    // as the plain pointer rather than a control that cannot work.
    if (!question.role) return <UploadField question={question} projectId={projectId} />
    return (
      <div className="flex flex-col gap-2">
        <QuestionHeader question={question} domId={domId} />
        <DocumentRoleField
          projectId={projectId}
          role={question.role}
          scopeInstanceId={bauwerkIdFromAnswerKey(answerKey)}
        />
      </div>
    )
  }

  const header = <QuestionHeader question={question} domId={domId} />
  const errorText = error ? (
    <p id={`${domId}-error`} className="text-destructive text-sm">
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
            <SelectTrigger
              id={domId}
              className="w-full max-w-md"
              aria-invalid={error ? true : undefined}
            >
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
  const [whyOpen, setWhyOpen] = useState(false)
  const whyId = `${domId}-why`
  return (
    <div className="flex flex-col gap-1">
      {/* `items-center` on touch: the rationale glyph beside the label is a full
          44px control there, and baseline alignment would hang it off the label's
          text baseline instead of centring it in the row it now defines. */}
      <div className="flex items-baseline gap-2 pointer-coarse:items-center">
        <Label htmlFor={domId} className="text-sm font-medium">
          {question.label}
          {/* Mark the handful of hard-required fields so they're distinguishable
              from the ~90 soft ones BEFORE Next is pressed (error prevention),
              mirroring the FieldShell required marker used elsewhere. */}
          {question.required && (
            <span aria-hidden className="text-destructive">
              {' '}
              *
            </span>
          )}
        </Label>
        {question.optional && (
          <span className="text-muted-foreground text-xs font-normal">{t('intake.optional')}</span>
        )}
        {/* The rationale rides ON the label row as a glyph rather than under it
            as its own "Warum fragen wir das?" line. Nearly every question in the
            catalog carries a `why`, so a per-field row put a second, louder
            control beside every label — an accordion the length of the form
            competing with the questions it annotates. */}
        {question.why && (
          <button
            type="button"
            onClick={() => setWhyOpen((previous) => !previous)}
            aria-expanded={whyOpen}
            aria-controls={whyId}
            aria-label={t('intake.why')}
            title={t('intake.why')}
            // 44px of REAL layout space, not a negative-margin overhang.
            //
            // The overhang is the tempting version — it grows the target and
            // moves nothing — and it is wrong here because this control has
            // neighbours on every side it would grow into: the `<Label>` is 8px
            // to its left and the field it annotates is 4px below. A 14px
            // overhang therefore covers the end of the label (which focuses the
            // field) and the top edge of the field itself, so the two taps a
            // reader is most likely to make in this row would both open the
            // rationale instead. A target that big by theft is worse than a
            // small one: it is wrong on purpose rather than by omission.
            //
            // The cost is the honest one — the label row is 44px tall on touch.
            // `pointer-coarse:items-center` below keeps the glyph and the label
            // aligned once the row is taller than its baseline.
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/40 pointer-coarse:size-11 inline-flex size-4 shrink-0 items-center justify-center self-center rounded-full outline-none transition-colors duration-quick ease-out focus-visible:ring-2 motion-reduce:transition-none"
          >
            <HelpCircle className="size-3.5" aria-hidden />
          </button>
        )}
      </div>
      {question.why && whyOpen && (
        // The documented quotation rule (`border-l-2 border-border`) on a real
        // surface, rather than a second differently-alpha'd action ink.
        <p
          id={whyId}
          className="border-border bg-muted text-muted-foreground max-w-prose border-l-2 px-3 py-2 text-xs"
        >
          {question.why}
        </p>
      )}
      {question.help && <p className="text-muted-foreground text-xs">{question.help}</p>}
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
        {question.unit && (
          <span className="text-muted-foreground font-mono text-xs">{question.unit}</span>
        )}
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
      {question.hint && <p className="text-muted-foreground max-w-xl text-xs">{question.hint}</p>}
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
  // One pill per control: several Segmented share a page, so the shared-layout
  // id is scoped to this instance or the fill would fly between questions.
  const pillId = useId()
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="border-border inline-flex w-fit flex-wrap self-start overflow-hidden rounded-lg border"
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
              'border-border relative isolate inline-flex items-center justify-center transition-colors duration-quick ease-out motion-reduce:transition-none',
              i > 0 && 'border-l',
              // Comfortable tap targets on touch screens; denser on desktop pointers.
              size === 'sm'
                ? 'min-h-9 px-3 text-xs font-medium md:min-h-8 md:px-2.5 md:text-[11px]'
                : 'min-h-11 px-4 text-sm md:min-h-9 md:px-3.5',
              !active && 'bg-card text-foreground hover:bg-muted',
              active && tone === 'default' && 'text-primary-foreground',
              active && tone === 'warning' && 'text-white',
              active && tone === 'muted' && 'text-background'
            )}
          >
            {active && (
              <motion.span
                layoutId={pillId}
                transition={springGlide}
                aria-hidden="true"
                className={cn(
                  'absolute inset-0 -z-10',
                  tone === 'default' && 'bg-primary',
                  tone === 'warning' && 'bg-warning',
                  tone === 'muted' && 'bg-muted-foreground'
                )}
              />
            )}
            <span className="relative">{opt.label}</span>
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
            onClick={() =>
              onChange(active ? value.filter((v) => v !== opt.value) : [...value, opt.value])
            }
            className={cn(
              'inline-flex min-h-11 items-center justify-center rounded-full border px-4 py-1.5 text-sm transition-colors duration-quick ease-out motion-reduce:transition-none md:min-h-9 md:px-3.5',
              active
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-card text-foreground hover:border-primary/50 hover:bg-primary/5'
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
function UploadField({
  question,
  projectId,
}: {
  question: ProjectIntakeQuestion
  projectId: string
}) {
  const t = useTranslations('projects')
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">{question.label}</span>
      <Link
        href={`/app/projects/${projectId}/files`}
        className="border-border bg-muted/20 text-muted-foreground hover:border-primary/50 hover:bg-primary/5 hover:text-foreground inline-flex max-w-md items-center gap-3 rounded-lg border border-dashed px-4 py-3 text-sm transition-colors duration-quick ease-out motion-reduce:transition-none"
      >
        <FolderOpen className="text-primary size-4 shrink-0" aria-hidden />
        <span>{t('intake.upload.hint')}</span>
      </Link>
    </div>
  )
}

/** Confirmed-brief facts that look derived. The class is not computed here. */
function InfoPlaceholder({ question }: { question: ProjectIntakeQuestion }) {
  const t = useTranslations('projects')
  return (
    <div className="bg-muted/30 rounded-xl border border-dashed px-4 py-3.5">
      <div className="flex items-start gap-2.5">
        <Sparkles className="text-primary size-4 shrink-0 translate-y-0.5" aria-hidden />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">{question.label}</p>
            <Badge variant="info">{t('intake.derived.badge')}</Badge>
          </div>
          {question.hint && <p className="text-muted-foreground mt-1 text-xs">{question.hint}</p>}
        </div>
      </div>
    </div>
  )
}
