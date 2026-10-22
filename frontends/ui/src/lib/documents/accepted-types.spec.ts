/**
 * @vitest-environment node
 */
/**
 * The organization's accepted types without a session equal the session's own
 * upload allow-list (`assertUploadTypeAllowed`) for the same flags, VLM
 * capability, deployment list and authentication mode, row by row: the mail a
 * project receives is offered exactly what an upload of that office accepts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/workos/feature-flags', () => ({ enabledFlagsForOrganization: vi.fn() }))
vi.mock('@/lib/documents/vlm-capability', () => ({ isVlmConfigured: vi.fn() }))

import { BadRequestError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { FEATURE_FLAGS } from '@/lib/authz/feature-flags'
import { isVlmConfigured } from '@/lib/documents/vlm-capability'
import { enabledFlagsForOrganization } from '@/lib/workos/feature-flags'
import { acceptedTypesForOrganization, isAcceptedType } from './accepted-types'
import { assertUploadTypeAllowed } from './service'

const session = (featureFlags: string[]): AuthorizedSession => ({
  userId: 'user_1',
  email: 'a@piloti.test',
  name: null,
  accessToken: '',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [],
  featureFlags,
})

/** What the session's allow-list accepts: the list its refusal of a type-less name carries. */
async function sessionAccepted(featureFlags: string[]): Promise<readonly string[]> {
  const refusal = await assertUploadTypeAllowed(session(featureFlags), 'no-extension').catch((error: unknown) => error)
  if (!(refusal instanceof BadRequestError)) throw new Error('a name without an extension was not refused')
  return (refusal.details as { accepted: string[] }).accepted
}

const IMAGES = FEATURE_FLAGS.imageUpload
const IFC = FEATURE_FLAGS.ifcModels

const FLAG_SETS: readonly (readonly string[])[] = [[], [IMAGES], [IFC], [IMAGES, IFC], [FEATURE_FLAGS.mailImport]]
const ENV_LISTS: readonly (string | undefined)[] = [undefined, '.pdf, .PNG,.ifc,.html,,.DOCX']
const AUTH_MODES = ['true', 'false'] as const

const ROWS = FLAG_SETS.flatMap((flags) =>
  [true, false].flatMap((vlm) =>
    ENV_LISTS.flatMap((envList) => AUTH_MODES.map((requireAuth) => ({ flags, vlm, envList, requireAuth })))
  )
)

beforeEach(() => {
  vi.mocked(enabledFlagsForOrganization).mockReset()
  vi.mocked(isVlmConfigured).mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('acceptedTypesForOrganization', () => {
  it.each(ROWS)(
    'equals the session allow-list: flags $flags, VLM $vlm, list $envList, REQUIRE_AUTH $requireAuth',
    async ({ flags, vlm, envList, requireAuth }) => {
      vi.stubEnv('REQUIRE_AUTH', requireAuth)
      vi.stubEnv('FILE_UPLOAD_ACCEPTED_TYPES', envList ?? '')
      vi.mocked(enabledFlagsForOrganization).mockResolvedValue([...flags])
      vi.mocked(isVlmConfigured).mockResolvedValue(vlm)

      const accepted = await acceptedTypesForOrganization('org_1')

      expect(accepted).toEqual(await sessionAccepted([...flags]))
      expect(enabledFlagsForOrganization).toHaveBeenCalledWith('org_1')
    }
  )

  it('answers the deployment default when no flag-governed type is on', async () => {
    vi.stubEnv('REQUIRE_AUTH', 'true')
    vi.stubEnv('FILE_UPLOAD_ACCEPTED_TYPES', '')
    vi.mocked(enabledFlagsForOrganization).mockResolvedValue([])
    vi.mocked(isVlmConfigured).mockResolvedValue(true)
    expect(await acceptedTypesForOrganization('org_1')).toEqual(['.pdf', '.docx', '.txt', '.md', '.csv', '.xlsx', '.pptx'])
  })

  it('adds pictures only with the flag and a vision model, and models with their flag', async () => {
    vi.stubEnv('REQUIRE_AUTH', 'true')
    vi.stubEnv('FILE_UPLOAD_ACCEPTED_TYPES', '')
    vi.mocked(enabledFlagsForOrganization).mockResolvedValue([IMAGES, IFC])
    vi.mocked(isVlmConfigured).mockResolvedValue(true)
    expect(await acceptedTypesForOrganization('org_1')).toEqual(expect.arrayContaining(['.png', '.jpg', '.jpeg', '.webp', '.ifc']))
    vi.mocked(isVlmConfigured).mockResolvedValue(false)
    expect(await acceptedTypesForOrganization('org_1')).not.toContain('.png')
  })

  it('throws when WorkOS cannot be read, so the job retries instead of refusing every picture', async () => {
    vi.mocked(enabledFlagsForOrganization).mockRejectedValue(new Error('WorkOS unavailable'))
    vi.mocked(isVlmConfigured).mockResolvedValue(true)
    await expect(acceptedTypesForOrganization('org_1')).rejects.toThrow('WorkOS unavailable')
  })
})

describe('isAcceptedType', () => {
  const accepted = ['.pdf', '.docx']

  it.each([
    ['Plan EG.PDF', true],
    ['bericht.final.docx', true],
    ['grundriss.dwg', false],
    ['README', false],
    ['.pdf', false],
    ['', false],
  ])('reads %j as the upload reads it: %s', (name, expected) => {
    expect(isAcceptedType(name, accepted)).toBe(expected)
  })
})
