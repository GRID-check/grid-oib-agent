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
import { act, renderHook, waitFor } from '@testing-library/react'
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
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.gebaeudeklasse).toBeNull()
    expect(result.current.missing).toContain('Gebäudeklasse')
  })

  it('reads the canonical GK form the brief actually stores', async () => {
    // `GK1`…`GK5` is the vocabulary the card schema publishes and the chat
    // writes. `Number('GK4')` is NaN, so a CORRECTLY filled brief read as "no
    // Gebäudeklasse" — every rule depending on it stood down as "nicht
    // einschlägig" here while the agent, which passes the number, returned
    // real verdicts. The card and the answer above it disagreed on screen.
    stubProfile({ facts: { gebaeudeklasse: { value: 'GK4' } } })
    const { result } = renderHook(() => useProjectRuleFacts('p1'))
    await waitFor(() => expect(result.current.gebaeudeklasse).toBe(4))
    expect(result.current.missing).not.toContain('Gebäudeklasse')
  })

  it('accepts a bare number, which nothing forbids', async () => {
    stubProfile({ facts: { gebaeudeklasse: { value: 4 } } })
    const { result } = renderHook(() => useProjectRuleFacts('p1'))
    await waitFor(() => expect(result.current.gebaeudeklasse).toBe(4))
  })

  it('refuses a Gebäudeklasse it cannot read', async () => {
    // Asserted on `ready`, not on `missing`: `missing` contains everything
    // before the fetch resolves, so a `waitFor` on it passes at mount whatever
    // the answer turns out to be. This test used to do exactly that, and
    // therefore pinned nothing.
    stubProfile({ facts: { gebaeudeklasse: { value: 'Klasse vier' } } })
    const { result } = renderHook(() => useProjectRuleFacts('p1'))
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.gebaeudeklasse).toBeNull()
    expect(result.current.missing).toContain('Gebäudeklasse')
  })

  it('treats an empty Hauptnutzung as absent', async () => {
    // On `ready`, for the reason spelled out two tests up — and asserting the
    // VALUE, which is the distinction: `missing` says the same thing at mount
    // whatever the answer turns out to be.
    stubProfile({ facts: { hauptnutzung: { value: '  ' } } })
    const { result } = renderHook(() => useProjectRuleFacts('p1'))
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.hauptnutzung).toBeNull()
    expect(result.current.missing).toContain('Hauptnutzung')
  })

  it('names no gap at all until the brief has actually been read', async () => {
    /*
      `facts` starts `{null, null}`, so `missing` used to name both facts from
      the first frame. That is not a frame nobody sees: a compliance card's
      "im Modell zeigen" link carries `?tab=compliance`, so the drawer is open
      at mount and the panel tells the reader that the Gebäudeklasse and the
      Hauptnutzung are missing from the brief — on a project where both are
      set, with a call to go and set them, and coming back changes nothing.
    */
    stubProfile({ facts: { gebaeudeklasse: { value: 'GK4' }, hauptnutzung: { value: 'wohnen' } } })
    const { result } = renderHook(() => useProjectRuleFacts('p1'))

    expect(result.current.ready).toBe(false)
    expect(result.current.missing).toEqual([])

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.missing).toEqual([])
  })

  it('names both gaps when the profile carries neither', async () => {
    stubProfile({ facts: {} })
    const { result } = renderHook(() => useProjectRuleFacts('p1'))
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.failed).toBe(false)
    expect(result.current.missing).toEqual(['Gebäudeklasse', 'Hauptnutzung'])
  })

  it('reports a profile it could not READ as that, not as a brief with gaps', async () => {
    // The rules stand down either way, which is the honest outcome — never a
    // default that quietly picks thresholds. But "diese Angaben fehlen im
    // Briefing", with a link to go and set them, sends the reader to re-enter
    // values that are already there, and coming back changes nothing.
    //
    // This test used to assert the OPPOSITE of what the hook does, and passed
    // because `missing` holds both strings at mount: `waitFor` resolved on its
    // first poll, before the rejection had landed.
    stubProfile({}, false)
    const { result } = renderHook(() => useProjectRuleFacts('p1'))
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.failed).toBe(true)
    expect(result.current.missing).toEqual([])
    expect(result.current.gebaeudeklasse).toBeNull()
  })

  it('clears the failure when the retry succeeds', async () => {
    stubProfile({}, false)
    const { result } = renderHook(() => useProjectRuleFacts('p1'))
    await waitFor(() => expect(result.current.failed).toBe(true))

    stubProfile({ facts: { gebaeudeklasse: { value: 'GK4' } } })
    act(() => result.current.reload())
    await waitFor(() => expect(result.current.gebaeudeklasse).toBe(4))
    expect(result.current.failed).toBe(false)
  })

  it('fetches nothing without a project', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    renderHook(() => useProjectRuleFacts(null))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports itself unsettled until the brief has been read', async () => {
    // The facts start as {null, null} and settle after /profile resolves. A
    // query keyed on them fires twice per page load and the first run applies
    // no Gebäudeklasse — a measured ~1.5s and ~126MB of server work discarded.
    const { result } = renderHook(() => useProjectRuleFacts('p1'))

    expect(result.current.ready).toBe(false)
    await waitFor(() => expect(result.current.ready).toBe(true))
  })

  it('settles even when the brief cannot be read', async () => {
    // Otherwise a failed profile parks the catalogue behind a spinner forever.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }))
    )
    const { result } = renderHook(() => useProjectRuleFacts('p1'))

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.gebaeudeklasse).toBeNull()
  })

  it('is settled immediately when there is no project', () => {
    const { result } = renderHook(() => useProjectRuleFacts(null))

    expect(result.current.ready).toBe(true)
  })
})
