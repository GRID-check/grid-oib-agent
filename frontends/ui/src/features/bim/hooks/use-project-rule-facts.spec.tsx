/**
 * The project facts the rule catalogue reads.
 *
 * This hook decides what counts as a usable fact, and the answer has to be
 * conservative in one specific direction: a fact it cannot vouch for must
 * arrive as `null`, so the rules that need it stand down with their reason. A
 * `gebaeudeklasse` guessed from a malformed profile would silently pick the
 * fire-resistance thresholds for the wrong building.
 */

import { describe, expect, it, vi, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useProjectRuleFacts } from './use-bim-model'

function stubProfile(body: unknown, ok = true): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => body }))
  )
}

describe('useProjectRuleFacts', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads the facts the catalogue needs', async () => {
    stubProfile({ facts: { gebaeudeklasse: { value: 4 }, hauptnutzung: { value: 'wohnen' } } })
    const { result } = renderHook(() => useProjectRuleFacts('p1'))
    await waitFor(() => expect(result.current.gebaeudeklasse).toBe(4))
    expect(result.current.hauptnutzung).toBe('wohnen')
    expect(result.current.missing).toEqual([])
  })

  it('accepts a Gebäudeklasse the profile stored as a string', async () => {
    // Profiles are written by several paths; the number arriving as text is a
    // storage detail, not a reason to stand a fire rule down.
    stubProfile({ facts: { gebaeudeklasse: { value: '3' } } })
    const { result } = renderHook(() => useProjectRuleFacts('p1'))
    await waitFor(() => expect(result.current.gebaeudeklasse).toBe(3))
  })

  it('refuses a Gebäudeklasse outside 1–5 rather than clamping it', async () => {
    // Clamping 9 to 5 would invent a requirement the project never stated.
    stubProfile({ facts: { gebaeudeklasse: { value: 9 } } })
    const { result } = renderHook(() => useProjectRuleFacts('p1'))
    await waitFor(() => expect(result.current.missing).toContain('Gebäudeklasse'))
    expect(result.current.gebaeudeklasse).toBeNull()
  })

  it('refuses a non-numeric Gebäudeklasse', async () => {
    stubProfile({ facts: { gebaeudeklasse: { value: 'GK 4' } } })
    const { result } = renderHook(() => useProjectRuleFacts('p1'))
    await waitFor(() => expect(result.current.missing).toContain('Gebäudeklasse'))
  })

  it('treats an empty Hauptnutzung as absent', async () => {
    stubProfile({ facts: { hauptnutzung: { value: '  ' } } })
    const { result } = renderHook(() => useProjectRuleFacts('p1'))
    await waitFor(() => expect(result.current.missing).toContain('Hauptnutzung'))
  })

  it('names both gaps when the profile carries neither', async () => {
    stubProfile({ facts: {} })
    const { result } = renderHook(() => useProjectRuleFacts('p1'))
    await waitFor(() => expect(result.current.missing).toEqual(['Gebäudeklasse', 'Hauptnutzung']))
  })

  it('treats an unreadable profile the same as one carrying nothing', async () => {
    // The rules then stand down and say so, which is the honest outcome — never
    // a default that quietly picks thresholds.
    stubProfile({}, false)
    const { result } = renderHook(() => useProjectRuleFacts('p1'))
    await waitFor(() => expect(result.current.missing).toEqual(['Gebäudeklasse', 'Hauptnutzung']))
    expect(result.current.gebaeudeklasse).toBeNull()
  })

  it('fetches nothing without a project', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    renderHook(() => useProjectRuleFacts(null))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
