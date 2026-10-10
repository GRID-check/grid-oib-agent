import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_FASSUNG } from '@/lib/documents/fassung'
import { FassungRequestError, requestFassungLink, setFassungLink } from './fassung-request'

const mockFetch = vi.fn()
const FACTS = {
  supersededBy: null,
  supersedes: [{ id: 'doc-a', filename: 'Grundriss_A.pdf' }],
  suggestion: null,
  changeSummary: null,
}

describe('fassung-request', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
    mockFetch.mockReset()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('PUTs the older document and the flag to the newer one’s route', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ id: 'doc-b', fassung: FACTS, older: { id: 'doc-a', fassung: null } })))

    const facts = await setFassungLink('doc-b', 'doc-a', true)

    expect(facts).toEqual(FACTS)
    expect(mockFetch).toHaveBeenCalledWith('/api/documents/doc-b/fassung', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ older: 'doc-a', linked: true }),
    })
  })

  it('answers the facts of both documents', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ id: 'doc-b', fassung: FACTS, older: { id: 'doc-a', fassung: FACTS } })))

    expect(await requestFassungLink('doc-b', 'doc-a', false)).toEqual({ newer: FACTS, older: FACTS })
  })

  it('reads a body without facts as nothing to say', async () => {
    mockFetch.mockResolvedValue(new Response('{}'))

    expect(await setFassungLink('doc-b', 'doc-a', false)).toEqual(EMPTY_FASSUNG)
  })

  it('throws the status of a refusal', async () => {
    mockFetch.mockResolvedValue(new Response('{}', { status: 403 }))

    await expect(setFassungLink('doc-b', 'doc-a', true)).rejects.toMatchObject({ name: 'FassungRequestError', status: 403 })
  })

  it('throws status 0 when nothing answered', async () => {
    mockFetch.mockRejectedValue(new TypeError('network'))

    const error = await setFassungLink('doc-b', 'doc-a', true).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(FassungRequestError)
    expect((error as FassungRequestError).status).toBe(0)
  })
})
