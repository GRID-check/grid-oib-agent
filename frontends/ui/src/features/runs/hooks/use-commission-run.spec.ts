/**
 * The thread's two doors into a run: a plain commission, and a continuation
 * that carries the last plan forward (ADR-0065). Both re-read the thread so
 * the new block appears; both fail open.
 */

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/runs/run-view-client', () => ({ commissionRun: vi.fn() }))
vi.mock('@/lib/plans/plan-client', () => ({ createPlan: vi.fn(), fetchPlan: vi.fn() }))

import { useChatStore } from '@/features/chat/store'
import { createPlan, fetchPlan } from '@/lib/plans/plan-client'
import type { ResearchPlan } from '@/lib/plans/plan-types'
import { commissionRun } from '@/lib/runs/run-view-client'
import { useCommissionRun } from './use-commission-run'

const hydrate = vi.fn(async () => undefined)
const previous = {
  title: 'Fluchtwege',
  sections: ['Bestand'],
  genre: 'bericht',
  depth: 'gutachten',
  grundlage: [],
  ausgeschlossen: [],
  nurGrundlage: false,
  dataSources: null,
  unterlagen: [],
} as unknown as ResearchPlan

beforeEach(() => {
  vi.clearAllMocks()
  useChatStore.setState({ hydrateConversationMessages: hydrate } as never)
})

describe('useCommissionRun', () => {
  it('is null without a project or a thread', () => {
    expect(renderHook(() => useCommissionRun(null, 's_conv')).result.current).toBeNull()
  })

  it('continues a planned run on its plan, with a countdown, and re-reads the thread', async () => {
    vi.mocked(fetchPlan).mockResolvedValue(previous)
    vi.mocked(createPlan).mockResolvedValue({} as never)
    const { result } = renderHook(() => useCommissionRun('proj', 's_conv'))
    let ok = false
    await act(async () => {
      ok = (await result.current?.continuePlanned({ question: 'Fortschreibung: Fluchtwege' }, 'plan-1')) ?? false
    })
    expect(ok).toBe(true)
    expect(fetchPlan).toHaveBeenCalledWith('proj', 'plan-1')
    expect(createPlan).toHaveBeenCalledWith(
      'proj',
      expect.objectContaining({ conversationId: 's_conv', sections: ['Bestand'], countdown: true })
    )
    expect(commissionRun).not.toHaveBeenCalled()
    expect(hydrate).toHaveBeenCalledWith('s_conv')
  })

  it('falls back to a plain commission when the earlier plan cannot be read', async () => {
    vi.mocked(fetchPlan).mockRejectedValue(new Error('404'))
    vi.mocked(commissionRun).mockResolvedValue({} as never)
    const { result } = renderHook(() => useCommissionRun('proj', 's_conv'))
    await act(async () => {
      await result.current?.continuePlanned({ question: 'Fortschreibung', context: 'Befunde' }, 'plan-1')
    })
    expect(createPlan).not.toHaveBeenCalled()
    expect(commissionRun).toHaveBeenCalledWith('proj', {
      conversationId: 's_conv',
      question: 'Fortschreibung',
      context: 'Befunde',
      documents: undefined,
    })
  })
})
