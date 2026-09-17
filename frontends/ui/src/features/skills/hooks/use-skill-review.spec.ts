/**
 * The review's state machine, which is where the failure mode lives: a review
 * that could not run must never read as a clean bill of health, and a verdict
 * must never outlive the text it was about.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSkillReview } from './use-skill-review'

const reviewSkill = vi.fn()
vi.mock('@/adapters/api/skills-client', () => ({
  reviewSkill: (...args: unknown[]) => reviewSkill(...args),
}))

const DRAFT = { name: 'oib-check', description: 'Prüft etwas.', body: 'Schritte' }

beforeEach(() => {
  reviewSkill.mockReset()
})

describe('useSkillReview', () => {
  it('asks for nothing until the author asks for it', () => {
    const { result } = renderHook(() => useSkillReview(DRAFT))
    expect(reviewSkill).not.toHaveBeenCalled()
    expect(result.current.state).toEqual({ kind: 'idle' })
    expect(result.current.gate.checked).toBe(false)
  })

  it('reviews the CURRENT draft, not a remembered one', async () => {
    reviewSkill.mockResolvedValue({ findings: [] })
    const { result } = renderHook(() => useSkillReview(DRAFT))
    await act(() => result.current.run())
    expect(reviewSkill).toHaveBeenCalledWith(DRAFT)
  })

  it('orders findings worst-first, and files each under its own field', async () => {
    reviewSkill.mockResolvedValue({
      findings: [
        { severity: 'suggestion', field: 'body', message: 'Add an example.', fix: 'Show output.' },
        { severity: 'error', field: 'description', message: 'No WHEN clause.', fix: 'Add one.' },
        { severity: 'warning', field: 'name', message: 'Vague name.', fix: 'Name the domain.' },
      ],
    })
    const { result } = renderHook(() => useSkillReview(DRAFT))
    await act(() => result.current.run())

    expect(result.current.findings.map((f) => f.message)).toEqual([
      'No WHEN clause.',
      'Vague name.',
      'Add an example.',
    ])
    // The grouping is what lets a finding be shown under the field it is about,
    // which is the whole point of holding the verdict above the steps.
    expect(result.current.findingsFor('description').map((f) => f.message)).toEqual([
      'No WHEN clause.',
    ])
    expect(result.current.findingsFor('body').map((f) => f.message)).toEqual(['Add an example.'])
  })

  it('opens the gate on a clean verdict', async () => {
    reviewSkill.mockResolvedValue({ findings: [] })
    const { result } = renderHook(() => useSkillReview(DRAFT))
    await act(() => result.current.run())
    expect(result.current.gate).toEqual({ checked: true, reason: 'reviewed' })
    expect(result.current.stale).toBe(false)
  })

  // `findings: null` is "could not check". Reading it as clean would tell an
  // author their skill is fine on the strength of a failed request.
  it('NEVER reads as clean when the review could not run — but never blocks either', async () => {
    reviewSkill.mockResolvedValue({ findings: null, error: 'review_failed' })
    const { result } = renderHook(() => useSkillReview(DRAFT))
    await act(() => result.current.run())

    expect(result.current.state).toEqual({ kind: 'unavailable' })
    expect(result.current.findings).toEqual([])
    // Our outage is not the author's to pay for with an unsaveable draft.
    expect(result.current.gate).toEqual({ checked: true, reason: 'unavailable' })
  })

  it('goes stale the moment the draft changes, and the gate closes with it', async () => {
    reviewSkill.mockResolvedValue({ findings: [] })
    const { result, rerender } = renderHook((draft) => useSkillReview(draft), {
      initialProps: DRAFT,
    })
    await act(() => result.current.run())
    expect(result.current.stale).toBe(false)

    rerender({ ...DRAFT, description: 'Etwas ganz anderes.' })
    await waitFor(() => expect(result.current.stale).toBe(true))
    expect(result.current.gate.checked).toBe(false)
  })

  // A character typed while the reviewer was thinking must leave the verdict
  // stale, or the gate opens on a draft nobody read.
  it('is stale when the draft moved while the request was in flight', async () => {
    let settle: (value: { findings: [] }) => void = () => {}
    reviewSkill.mockReturnValue(new Promise((resolve) => (settle = resolve)))
    const { result, rerender } = renderHook((draft) => useSkillReview(draft), {
      initialProps: DRAFT,
    })

    const running = act(() => result.current.run())
    rerender({ ...DRAFT, body: 'Andere Schritte' })
    settle({ findings: [] })
    await running

    await waitFor(() => expect(result.current.stale).toBe(true))
    expect(result.current.gate.checked).toBe(false)
  })
})
