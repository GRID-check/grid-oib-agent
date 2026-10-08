/**
 * The browser's copy of the office's upload-screening policy (ADR-0085): never
 * Piloti's suggestion in its place, and never older than the upload asking.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SUGGESTED_SCREENING_POLICY, type UploadScreeningPolicy } from '@/lib/upload-screening/policy'
import {
  forgetPendingUploadScreeningPolicyRead,
  loadUploadScreeningPolicy,
  UploadScreeningPolicyUnavailableError,
} from './upload-screening-policy'

const office = (nameTerms: string[]): UploadScreeningPolicy => ({ ...SUGGESTED_SCREENING_POLICY, nameTerms })

let respond: () => Response
const fetchMock = vi.fn(async () => respond())

beforeEach(() => {
  forgetPendingUploadScreeningPolicyRead()
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const serve = (policy: UploadScreeningPolicy) => () =>
  Response.json({ policy, suggested: false, suggestion: SUGGESTED_SCREENING_POLICY })

describe('loadUploadScreeningPolicy', () => {
  it("rejects instead of screening with Piloti's suggestion when the policy cannot be read", async () => {
    respond = () => Response.json({ error: { message: 'down' } }, { status: 503 })

    await expect(loadUploadScreeningPolicy()).rejects.toBeInstanceOf(UploadScreeningPolicyUnavailableError)
  })

  it('reads the policy again for the next upload, so a term saved in another tab applies at once', async () => {
    respond = serve(office(['Lohn']))
    expect((await loadUploadScreeningPolicy()).nameTerms).toEqual(['Lohn'])

    respond = serve(office(['Lohn', 'Huber']))
    expect((await loadUploadScreeningPolicy()).nameTerms).toEqual(['Lohn', 'Huber'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('shares one request between loads that overlap', async () => {
    respond = serve(office(['Lohn']))

    const [first, second] = await Promise.all([loadUploadScreeningPolicy(), loadUploadScreeningPolicy()])

    expect(first).toEqual(second)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('tries again after a failure rather than keeping it', async () => {
    respond = () => new Response(null, { status: 503 })
    await expect(loadUploadScreeningPolicy()).rejects.toBeInstanceOf(UploadScreeningPolicyUnavailableError)

    respond = serve(office(['Lohn']))
    expect((await loadUploadScreeningPolicy()).nameTerms).toEqual(['Lohn'])
  })

  it('does not hand a load begun before a save in this tab to the next upload', async () => {
    let release!: () => void
    respond = serve(office(['Lohn']))
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (release = () => resolve(serve(office(['Lohn']))())))
    )
    const stale = loadUploadScreeningPolicy()

    forgetPendingUploadScreeningPolicyRead()
    respond = serve(office(['Lohn', 'Huber']))
    const fresh = loadUploadScreeningPolicy()
    release()

    expect((await stale).nameTerms).toEqual(['Lohn'])
    expect((await fresh).nameTerms).toEqual(['Lohn', 'Huber'])
  })
})
