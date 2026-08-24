/**
 * @vitest-environment happy-dom
 *
 * The reasoning-skills preference: the pure reader's fail-open default, and the
 * hook's hydrate-then-persist cycle.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const fetchUserPreferences = vi.fn()
const persist = vi.fn()

vi.mock('./client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./client')>()
  return {
    ...actual,
    fetchUserPreferences: (...args: unknown[]) => fetchUserPreferences(...args),
    setShowReasoningSkills: (...args: unknown[]) => persist(...args),
  }
})

import { readShowReasoningSkills, SHOW_REASONING_SKILLS_DEFAULT } from './client'
import { useShowReasoningSkills } from './use-show-reasoning-skills'

beforeEach(() => {
  fetchUserPreferences.mockReset()
  persist.mockReset()
  persist.mockResolvedValue(true)
})

describe('readShowReasoningSkills', () => {
  it('defaults CLOSED so hidden skills stay out of the live line', () => {
    expect(SHOW_REASONING_SKILLS_DEFAULT).toBe(false)
    expect(readShowReasoningSkills(undefined)).toBe(false)
    expect(readShowReasoningSkills(null)).toBe(false)
    expect(readShowReasoningSkills({})).toBe(false)
  })

  it('reads a stored boolean, and ignores a non-boolean rather than throwing', () => {
    expect(readShowReasoningSkills({ showReasoningSkills: true })).toBe(true)
    expect(readShowReasoningSkills({ showReasoningSkills: false })).toBe(false)
    // A corrupt / hand-edited value reads as the default, never a crash.
    expect(readShowReasoningSkills({ showReasoningSkills: 'yes' as unknown as boolean })).toBe(false)
  })
})

describe('useShowReasoningSkills', () => {
  it('hydrates from the stored preference', async () => {
    fetchUserPreferences.mockResolvedValue({ showReasoningSkills: true })
    const { result } = renderHook(() => useShowReasoningSkills())

    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.showReasoningSkills).toBe(true)
  })

  it('falls back to the closed default when nothing is stored', async () => {
    fetchUserPreferences.mockResolvedValue({})
    const { result } = renderHook(() => useShowReasoningSkills())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.showReasoningSkills).toBe(false)
  })

  it('updates optimistically and persists the change', async () => {
    fetchUserPreferences.mockResolvedValue({})
    const { result } = renderHook(() => useShowReasoningSkills())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => result.current.setShowReasoningSkills(true))

    expect(result.current.showReasoningSkills).toBe(true)
    expect(persist).toHaveBeenCalledWith(true)
  })
})
