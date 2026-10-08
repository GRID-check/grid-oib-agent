/**
 * The server's repeat of the name gate (ADR-0086), when the office's policy
 * cannot be read.
 *
 * It is the authority for a client that skipped the browser's check, so it
 * must not decide with Piloti's suggested list: a file that matches only a
 * term the office added would pass that list and be stored. It refuses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/organizations/service', () => ({
  getOrgSettings: vi.fn(),
  writeDedicatedOrgSetting: vi.fn(),
}))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))

import { invalidateCached } from '@/lib/cache'
import { getOrgSettings } from '@/lib/organizations/service'
import { SUGGESTED_SCREENING_POLICY } from './policy'
import { ScreenedUploadError, ScreeningPolicyUnavailableError, assertUploadNameAllowed } from './service'

const officePolicy = { ...SUGGESTED_SCREENING_POLICY, nameTerms: [...SUGGESTED_SCREENING_POLICY.nameTerms, 'Huber'] }

beforeEach(async () => {
  await invalidateCached('upload-screening:org-1')
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('assertUploadNameAllowed', () => {
  it("refuses a name that matches only the office's own term", async () => {
    vi.mocked(getOrgSettings).mockResolvedValue({
      displayName: null,
      defaultLocale: 'de',
      settings: { uploadScreening: officePolicy },
    })
    await expect(assertUploadNameAllowed('org-1', { filename: 'Notizen Huber.pdf' }, false)).rejects.toBeInstanceOf(
      ScreenedUploadError
    )
  })

  it('refuses every upload with a 503 while the policy cannot be read, rather than screening with the suggestion', async () => {
    vi.mocked(getOrgSettings).mockRejectedValue(new Error('db down'))
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const refusal = await assertUploadNameAllowed('org-1', { filename: 'Notizen Huber.pdf' }, false).catch(
      (error: unknown) => error
    )

    expect(refusal).toBeInstanceOf(ScreeningPolicyUnavailableError)
    expect(refusal).toMatchObject({ status: 503, code: 'UPLOAD_SCREENING_UNAVAILABLE' })
    errorLog.mockRestore()
  })
})
