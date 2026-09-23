/**
 * The plan hook: read by id, polled while it can still change hands, left
 * alone once started, and every action answered with the plan the BFF has.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/plans/plan-client', () => ({
  fetchPlan: vi.fn(),
  editPlan: vi.fn(),
  holdPlan: vi.fn(),
  startPlan: vi.fn(),
}))

import { editPlan, fetchPlan, holdPlan, startPlan } from '@/lib/plans/plan-client'
import type { ResearchPlan } from '@/lib/plans/plan-types'
import { PLAN_POLL_MS, usePlan } from './use-plan'

const plan = (status: ResearchPlan['status']): ResearchPlan =>
  ({ id: 'plan-1', status, sections: ['A'] }) as unknown as ResearchPlan

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('usePlan', () => {
  it('reads nothing without both ids', () => {
    const { result } = renderHook(() => usePlan(null, 'plan-1'))
    expect(result.current.plan).toBeNull()
    expect(fetchPlan).not.toHaveBeenCalled()
  })

  it('reads the plan and offers the three actions while it can still start', async () => {
    vi.mocked(fetchPlan).mockResolvedValue(plan('proposed'))
    const { result } = renderHook(() => usePlan('proj', 'plan-1'))
    await waitFor(() => expect(result.current.plan?.status).toBe('proposed'))
    expect(result.current.edit).not.toBeNull()

    vi.mocked(holdPlan).mockResolvedValue(plan('held'))
    await act(() => result.current.hold?.() ?? Promise.resolve())
    expect(result.current.plan?.status).toBe('held')

    vi.mocked(editPlan).mockResolvedValue(plan('held'))
    await act(() => result.current.edit?.({ sections: ['B'] }) ?? Promise.resolve())
    expect(editPlan).toHaveBeenCalledWith('proj', 'plan-1', { sections: ['B'] })

    vi.mocked(startPlan).mockResolvedValue(plan('approved'))
    await act(() => result.current.start?.() ?? Promise.resolve())
    expect(result.current.plan?.status).toBe('approved')
  })

  it('stops polling and offers nothing once the plan has started', async () => {
    vi.useFakeTimers()
    vi.mocked(fetchPlan).mockResolvedValue(plan('started'))
    const { result } = renderHook(() => usePlan('proj', 'plan-1'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.plan?.status).toBe('started')
    expect(result.current.start).toBeNull()
    const calls = vi.mocked(fetchPlan).mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PLAN_POLL_MS * 3)
    })
    expect(vi.mocked(fetchPlan).mock.calls.length).toBe(calls)
  })

  it('keeps the plan it had when an action fails', async () => {
    vi.mocked(fetchPlan).mockResolvedValue(plan('proposed'))
    const { result } = renderHook(() => usePlan('proj', 'plan-1'))
    await waitFor(() => expect(result.current.plan).not.toBeNull())
    vi.mocked(startPlan).mockRejectedValue(new Error('409'))
    await act(() => result.current.start?.() ?? Promise.resolve())
    expect(result.current.plan?.status).toBe('proposed')
  })
})
