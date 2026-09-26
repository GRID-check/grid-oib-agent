'use client'

/**
 * The plan a run waits on, as the block holds it (ADR-0068).
 *
 * Read by id from the run's message (`metadata.plan_id`), polled while the
 * plan can still change hands — proposed, held, approved — so the block sees
 * the worker start it, and left alone once it is started. Every action answers
 * with the plan as the BFF now has it, which replaces what is held: one plan,
 * one writer. Each call fails open; the block keeps the plan it had.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  editPlan as patchPlan,
  fetchPlan,
  holdPlan as postHold,
  startPlan as postStart,
} from '@/lib/plans/plan-client'
import { applyPlanEdit } from '@/lib/plans/plan-edit'
import { isEditablePlanStatus, type ResearchPlan, type ResearchPlanEdit } from '@/lib/plans/plan-types'

/** How often a plan that can still start is re-read. */
export const PLAN_POLL_MS = 3_000

export interface UsePlanResult {
  plan: ResearchPlan | null
  pending: boolean
  edit: ((edit: ResearchPlanEdit) => Promise<void>) | null
  hold: (() => Promise<void>) | null
  start: (() => Promise<void>) | null
}

export function usePlan(projectId: string | null, planId: string | null): UsePlanResult {
  const [plan, setPlan] = useState<ResearchPlan | null>(null)
  const [pending, setPending] = useState(false)
  const editable = plan ? isEditablePlanStatus(plan.status) : true

  useEffect(() => {
    if (!projectId || !planId || !editable) return
    let cancelled = false
    const read = () =>
      fetchPlan(projectId, planId)
        .then((next) => {
          if (!cancelled) setPlan(next)
        })
        .catch(() => undefined)
    void read()
    const timer = setInterval(read, PLAN_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [projectId, planId, editable])

  const act = useCallback(
    async (call: () => Promise<ResearchPlan>) => {
      setPending(true)
      try {
        setPlan(await call())
      } catch {
        // Fail open: the next poll says what the plan is.
      } finally {
        setPending(false)
      }
    },
    []
  )

  const live = Boolean(projectId && planId && plan && editable)
  return {
    plan,
    pending,
    edit: live
      ? (next) => {
          // Optimistic: the next edit is diffed against this one, not the plan before it.
          setPlan((current) => (current ? applyPlanEdit(current, next) : current))
          return act(() => patchPlan(projectId as string, planId as string, next))
        }
      : null,
    hold: live ? () => act(() => postHold(projectId as string, planId as string)) : null,
    start: live ? () => act(() => postStart(projectId as string, planId as string)) : null,
  }
}
