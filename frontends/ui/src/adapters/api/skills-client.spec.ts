/**
 * @vitest-environment node
 *
 * The URLs this client puts on the wire.
 *
 * Written because one of them was wrong and nothing noticed. The curated
 * activation route was renamed from `/api/skills/platform/[name]` to
 * `/api/skills/curated/[name]`; the rename swept identifiers, not the string
 * literal in the fetch call, so every activation request went to a path with no
 * handler. Types cannot catch that — a URL is a string on both sides — and the
 * component specs mock this module out entirely, so the mismatch was invisible
 * from both ends.
 *
 * These assertions are deliberately about the PATH and the METHOD only. The
 * response shapes are the service's contract and are covered there; what is
 * covered here is the one thing no other layer looks at.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createPlatformSkill,
  deletePlatformSkill,
  listPlatformSkills,
  setCuratedSkillEnabled,
  updatePlatformSkill,
} from './skills-client'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  // A FRESH Response per call: a body can only be read once, so a single
  // shared instance makes the second call in a test throw rather than assert.
  fetchMock.mockImplementation(async () =>
    new Response(JSON.stringify({ skills: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The (url, init) of the single request the call under test made. */
function lastRequest(): { url: string; method: string | undefined } {
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined]
  return { url, method: init?.method }
}

describe('setCuratedSkillEnabled', () => {
  it('PATCHes the curated activation route, which is where the handler lives', async () => {
    await setCuratedSkillEnabled('oib-fire-check', true)
    expect(lastRequest()).toEqual({
      url: '/api/skills/curated/oib-fire-check',
      method: 'PATCH',
    })
  })

  it('encodes the name, because it is a path segment', async () => {
    await setCuratedSkillEnabled('a/b', false)
    expect(lastRequest().url).toBe('/api/skills/curated/a%2Fb')
  })
})

describe('the platform catalogue', () => {
  it('addresses the platform routes, not the org toolbox', async () => {
    await listPlatformSkills()
    expect(lastRequest().url).toBe('/api/platform/skills')

    fetchMock.mockClear()
    await createPlatformSkill({ name: 'a', description: 'b', body: 'c' })
    expect(lastRequest()).toEqual({ url: '/api/platform/skills', method: 'POST' })

    fetchMock.mockClear()
    await updatePlatformSkill('ps-1', { published: true })
    expect(lastRequest()).toEqual({ url: '/api/platform/skills/ps-1', method: 'PATCH' })

    fetchMock.mockClear()
    await deletePlatformSkill('ps-1')
    expect(lastRequest()).toEqual({ url: '/api/platform/skills/ps-1', method: 'DELETE' })
  })
})
