'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
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
import type { ProjectIntakeDefinition, ProjectIntakeQuestion } from '@/lib/project-profile/intake-definition'
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
    const normalizedValue = Array.isArray(answer) ? JSON.stringify(answer) : answer

    const writesTo = question.writesTo || ''
    if (writesTo.startsWith('/goals/')) {
      const key = writesTo.replace('/goals/', '')
      goals[key] = normalizedValue
    } else if (writesTo.startsWith('/facts/')) {
      const match = writesTo.match(/^\/facts\/([^/]+)/)
      if (match) {
        facts[match[1]] = {
          value: normalizedValue,
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
        <Skeleton className="h-4 w-48" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16">
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
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
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Step {currentStage + 1} of {definition.stages.length}</span>
          <span>{stage.title}</span>
        </div>
        <Progress value={progress} className="mt-2 h-1" />
        {draftSaved && (
          <p className="mt-1 text-xs text-[var(--text-color-feedback-success)]">Draft saved</p>
        )}
      </div>

      {/* Current stage */}
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{stage.title}</h2>
        <div className="mt-6 space-y-6">
          {visibleQuestions.map((q) => (
            <QuestionField key={q.id} question={q} value={answers[q.id]} onChange={(v) => setAnswer(q.id, v)} />
          ))}
        </div>
      </div>

      {/* Navigation */}
      <div className="mt-10 flex items-center justify-between border-t pt-6">
        <Button type="button" variant="outline" onClick={prevStage} disabled={isFirst}>
          Back
        </Button>

        <span className="text-xs text-muted-foreground">
          {visibleQuestions.length} question{visibleQuestions.length !== 1 ? 's' : ''}
        </span>

        {isLast ? (
          <Button type="button" onClick={handleSave} disabled={!canProceed || saving}>
            {saving ? 'Saving...' : 'Save & Finish'}
          </Button>
        ) : (
          <Button type="button" onClick={nextStage} disabled={!canProceed}>
            Next
          </Button>
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
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={id} className="text-sm font-medium">{question.label}</Label>
          <Input
            id={id}
            type="text"
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      )
    case 'number':
      return (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={id} className="text-sm font-medium">{question.label}</Label>
          <Input
            id={id}
            type="number"
            value={typeof value === 'number' ? value : (typeof value === 'string' ? value : '')}
            onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
          />
        </div>
      )
    case 'boolean':
      return (
        <fieldset>
          <legend className="text-sm font-medium">{question.label}</legend>
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
                  {opt === 'true' ? 'Yes' : 'No'}
                </label>
              )
            })}
          </div>
        </fieldset>
      )
    case 'single_select':
      return (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={id} className="text-sm font-medium">{question.label}</Label>
          <Select
            value={typeof value === 'string' ? value : ''}
            onValueChange={(v) => onChange(v)}
          >
            <SelectTrigger id={id} className="w-full">
              <SelectValue placeholder="Select..." />
            </SelectTrigger>
            <SelectContent>
              {(question.options ?? []).map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )
    case 'multi_select':
      return (
        <fieldset>
          <legend className="text-sm font-medium">{question.label}</legend>
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
                      const next = checked
                        ? arr.filter((v) => v !== opt.value)
                        : [...arr, opt.value]
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
        </fieldset>
      )
    default:
      return null
  }
}
