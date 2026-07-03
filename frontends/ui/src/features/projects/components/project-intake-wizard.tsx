'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ProjectIntakeDefinition, ProjectIntakeQuestion, ProjectIntakeStage } from '@/lib/project-profile/intake-definition'
import type { ProjectProfile, ProjectPrimitiveValue } from '@/lib/project-profile/types'

interface ProjectIntakeWizardProps {
  projectId: string
}

function evaluateCondition(
  question: ProjectIntakeQuestion,
  answers: Record<string, ProjectPrimitiveValue>,
): boolean {
  const cond = question.condition
  if (!cond) return true
  const answer = answers[cond.field]
  if (cond.equals !== undefined) return answer === cond.equals
  if (cond.oneOf !== undefined) return typeof answer === 'string' && cond.oneOf.includes(answer)
  return true
}

function buildProfileFromAnswers(answers: Record<string, ProjectPrimitiveValue>, definition: ProjectIntakeDefinition): ProjectProfile {
  const facts: ProjectProfile['facts'] = {}
  const goals: ProjectProfile['goals'] = {}
  const now = new Date().toISOString()

  const allQuestions = definition.stages.flatMap((s) => s.questions)
  for (const question of allQuestions) {
    const answer = answers[question.id]
    if (answer === undefined || answer === null || answer === '') continue

    const writesTo = question.writesTo || ''
    if (writesTo.startsWith('/goals/')) {
      const key = writesTo.replace('/goals/', '')
      goals[key] = answer
    } else if (writesTo.startsWith('/facts/')) {
      const match = writesTo.match(/^\/facts\/([^/]+)/)
      if (match) {
        facts[match[1]] = {
          value: answer,
          confidence: 'confirmed' as const,
          source: 'onboarding' as const,
          updatedAt: now,
        }
      }
    }
  }

  return { facts, goals, unknowns: [], assumptions: {} }
}

export function ProjectIntakeWizard({ projectId }: ProjectIntakeWizardProps) {
  const router = useRouter()
  const [definition, setDefinition] = useState<ProjectIntakeDefinition | null>(null)
  const [loading, setLoading] = useState(true)
  const [currentStage, setCurrentStage] = useState(0)
  const [answers, setAnswers] = useState<Record<string, ProjectPrimitiveValue>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draftSaved, setDraftSaved] = useState(false)

  const STORAGE_KEY = `intake-draft-${projectId}`

  useEffect(() => {
    fetch(`/api/projects/${projectId}/intake-definition`)
      .then((r) => (r.ok ? r.json() : Promise.reject('Failed to load')))
      .then((data) => {
        setDefinition(data)
        try {
          const draft = sessionStorage.getItem(STORAGE_KEY)
          if (draft) {
            const parsed = JSON.parse(draft)
            if (parsed.answers) setAnswers(parsed.answers)
            if (typeof parsed.currentStage === 'number') setCurrentStage(parsed.currentStage)
          }
        } catch { /* invalid draft, ignore */ }
        setLoading(false)
      })
      .catch(() => { setError('Failed to load project questions'); setLoading(false) })
  }, [projectId])

  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ answers, currentStage }))
        setDraftSaved(true)
      } catch { /* quota exceeded, ignore */ }
    }, 500)
    return () => clearTimeout(timer)
  }, [answers, currentStage, STORAGE_KEY])

  useEffect(() => {
    if (draftSaved) {
      const timer = setTimeout(() => setDraftSaved(false), 2000)
      return () => clearTimeout(timer)
    }
  }, [draftSaved])

  const stage = definition?.stages[currentStage] ?? null
  const isFirst = currentStage === 0
  const isLast = definition ? currentStage >= definition.stages.length - 1 : true

  const visibleQuestions = useMemo(() => {
    if (!stage) return []
    return stage.questions.filter((q) => evaluateCondition(q, answers))
  }, [stage, answers])

  const setAnswer = useCallback((id: string, value: ProjectPrimitiveValue) => {
    setAnswers((prev) => ({ ...prev, [id]: value }))
  }, [])

  const canProceed = visibleQuestions.every((q) => {
    const answer = answers[q.id]
    if (q.type === 'boolean') return answer !== undefined
    if (q.type === 'number') return answer !== undefined && answer !== ''
    if (q.type === 'text') return typeof answer === 'string' && answer.trim().length > 0
    if (q.type === 'single_select') return typeof answer === 'string' && answer.length > 0
    if (q.type === 'multi_select') return Array.isArray(answer) && answer.length > 0
    return answer !== undefined && answer !== null
  })

  const handleSave = useCallback(async () => {
    if (!definition) return
    setSaving(true)
    try {
      const profile = buildProfileFromAnswers(answers, definition)
      const res = await fetch(`/api/projects/${projectId}/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profile),
      })
      if (!res.ok) throw new Error('Failed to save')
      try {
        sessionStorage.removeItem(STORAGE_KEY)
      } catch { /* ignore */ }
      await fetch(`/api/projects/${projectId}/generate-summary`, { method: 'POST' })
      router.push(`/projects/${projectId}`)
      router.refresh()
    } catch {
      setError('Failed to save project profile')
    } finally {
      setSaving(false)
    }
  }, [definition, answers, projectId, router])

  const nextStage = useCallback(() => {
    if (definition && currentStage < definition.stages.length - 1) {
      setCurrentStage((s) => s + 1)
    }
  }, [currentStage, definition])

  const prevStage = useCallback(() => {
    if (currentStage > 0) setCurrentStage((s) => s - 1)
  }, [currentStage])

  if (loading) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16">
        <div className="h-4 w-48 animate-pulse rounded bg-surface-raised-30" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16">
        <p className="text-sm text-red-600">{error}</p>
      </div>
    )
  }

  if (!definition || !stage) return null

  const progress = definition.stages.length > 1
    ? ((currentStage + 1) / definition.stages.length) * 100
    : 100

  return (
    <div className="mx-auto max-w-2xl px-4 py-12">
      {/* Progress bar */}
      <div className="mb-8">
        <div className="flex items-center justify-between text-xs text-subtle">
          <span>Step {currentStage + 1} of {definition.stages.length}</span>
          <span>{stage.title}</span>
        </div>
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-surface-raised-30">
          <div className="h-full rounded-full bg-brand transition-all duration-300" style={{ width: `${progress}%` }} />
        </div>
        {draftSaved && (
          <p className="mt-1 text-xs text-success">Draft saved</p>
        )}
      </div>

      {/* Current stage */}
      <div>
        <h2 className="text-lg font-semibold text-primary">{stage.title}</h2>
        <div className="mt-6 space-y-6">
          {visibleQuestions.map((q) => (
            <QuestionField key={q.id} question={q} value={answers[q.id]} onChange={(v) => setAnswer(q.id, v)} />
          ))}
        </div>
      </div>

      {/* Navigation */}
      <div className="mt-10 flex items-center justify-between border-t border-base pt-6">
        <button
          type="button"
          onClick={prevStage}
          disabled={isFirst}
          className="rounded-lg border border-base px-4 py-2 text-sm font-medium text-secondary transition hover:bg-surface-sunken disabled:opacity-30"
        >
          Back
        </button>

        <span className="text-xs text-subtle">
          {visibleQuestions.length} question{visibleQuestions.length !== 1 ? 's' : ''}
        </span>

        {isLast ? (
          <button
            type="button"
            onClick={handleSave}
            disabled={!canProceed || saving}
            className="rounded-lg bg-primary px-6 py-2 text-sm font-medium text-white transition hover:bg-primary-hover disabled:opacity-40"
          >
            {saving ? 'Saving...' : 'Save & Finish'}
          </button>
        ) : (
          <button
            type="button"
            onClick={nextStage}
            disabled={!canProceed}
            className="rounded-lg bg-primary px-6 py-2 text-sm font-medium text-white transition hover:bg-primary-hover disabled:opacity-40"
          >
            Next
          </button>
        )}
      </div>
    </div>
  )
}

function QuestionField({
  question,
  value,
  onChange,
}: {
  question: ProjectIntakeQuestion
  value: ProjectPrimitiveValue
  onChange: (value: ProjectPrimitiveValue) => void
}) {
  const id = `q-${question.id}`

  switch (question.type) {
    case 'text':
      return (
        <div>
          <label htmlFor={id} className="block text-sm font-medium text-secondary">{question.label}</label>
          <input
            id={id}
            type="text"
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
            className="mt-1 block w-full rounded-lg border border-base px-3 py-2 text-sm shadow-sm focus:border-brand focus:outline-none"
          />
        </div>
      )
    case 'number':
      return (
        <div>
          <label htmlFor={id} className="block text-sm font-medium text-secondary">{question.label}</label>
          <input
            id={id}
            type="number"
            value={typeof value === 'number' ? value : (typeof value === 'string' ? value : '')}
            onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
            className="mt-1 block w-full rounded-lg border border-base px-3 py-2 text-sm shadow-sm focus:border-brand focus:outline-none"
          />
        </div>
      )
    case 'boolean':
      return (
        <fieldset>
          <legend className="text-sm font-medium text-secondary">{question.label}</legend>
          <div className="mt-2 flex gap-4">
            {['true', 'false'].map((opt) => {
              const boolVal = opt === 'true'
              return (
                <label key={opt} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={id}
                    checked={value === boolVal}
                    onChange={() => onChange(boolVal)}
                    className="text-primary focus:ring-brand"
                  />
                  <span className="text-sm text-secondary">{opt === 'true' ? 'Yes' : 'No'}</span>
                </label>
              )
            })}
          </div>
        </fieldset>
      )
    case 'single_select':
      return (
        <div>
          <label htmlFor={id} className="block text-sm font-medium text-secondary">{question.label}</label>
          <select
            id={id}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
            className="mt-1 block w-full rounded-lg border border-base px-3 py-2 text-sm shadow-sm focus:border-brand focus:outline-none"
          >
            <option value="">Select...</option>
            {(question.options ?? []).map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      )
    case 'multi_select':
      return (
        <fieldset>
          <legend className="text-sm font-medium text-secondary">{question.label}</legend>
          <div className="mt-2 space-y-2">
            {(question.options ?? []).map((opt) => {
              const arr = Array.isArray(value) ? value : []
              const checked = arr.includes(opt.value)
              return (
                <label key={opt.value} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      const next = checked
                        ? arr.filter((v) => v !== opt.value)
                        : [...arr, opt.value]
                      onChange(next)
                    }}
                    className="text-primary focus:ring-brand"
                  />
                  <span className="text-sm text-secondary">{opt.label}</span>
                </label>
              )
            })}
          </div>
        </fieldset>
      )
    default:
      return null
  }
}
