import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

vi.mock('./repository', () => ({
  DRIVE_CREDENTIAL_LIST_LIMIT: 50,
  insertDriveCredential: vi.fn(),
  findDriveCredentialById: vi.fn(),
  listDriveCredentialsForUser: vi.fn().mockResolvedValue([]),
  revokeDriveCredentialForUser: vi.fn(),
  touchDriveCredentialLastUsed: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/audit/service', () => ({
  recordAuditEvent: vi.fn().mockResolvedValue(undefined),
}))

import {
  findDriveCredentialById,
  insertDriveCredential,
  listDriveCredentialsForUser,
  touchDriveCredentialLastUsed,
} from './repository'
import { recordAuditEvent } from '@/lib/audit/service'
import { createDriveCredential, parseSecretCredentialId, verifyMountCredential } from './service'
import type { AuthorizedSession } from '@/lib/auth/types'

const session = {
  userId: 'user_1',
  email: 'alice@acme.test',
  organizationId: 'org_acme',
} as AuthorizedSession

const request = new Request('https://grid.test/api/drive/credentials', { method: 'POST' })

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

describe('createDriveCredential', () => {
  beforeEach(() => vi.clearAllMocks())

  it('mints a one-time secret whose embedded id matches the stored row, and stores only the hash', async () => {
    const created = await createDriveCredential(session, { label: 'Work MacBook' }, request)

    expect(created.username).toBe('alice@acme.test')
    expect(created.secret.startsWith('gdk_')).toBe(true)
    expect(parseSecretCredentialId(created.secret)).toBe(created.id)

    const inserted = vi.mocked(insertDriveCredential).mock.calls[0][0]
    expect(inserted.id).toBe(created.id)
    expect(inserted.secretHash).toBe(sha256(created.secret))
    // The plaintext secret must never be persisted anywhere.
    expect(JSON.stringify(inserted)).not.toContain(created.secret)
    expect(inserted.expiresAt!.getTime()).toBeGreaterThan(Date.now())

    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'drive.credential_created', targetId: created.id }),
    )
  })

  it('rejects when the device cap is reached', async () => {
    vi.mocked(listDriveCredentialsForUser).mockResolvedValueOnce(
      Array.from({ length: 50 }, (_, i) => ({ id: `${i}` }) as never),
    )
    await expect(createDriveCredential(session, { label: 'One more' }, request)).rejects.toThrow(/Too many/)
    expect(insertDriveCredential).not.toHaveBeenCalled()
  })
})

describe('parseSecretCredentialId', () => {
  const hex = 'a'.repeat(32)
  it.each([
    ['no prefix', `${hex}.${'b'.repeat(43)}`],
    ['wrong prefix', `tok_${hex}.${'b'.repeat(43)}`],
    ['no dot', `gdk_${hex}${'b'.repeat(43)}`],
    ['short id', `gdk_${'a'.repeat(31)}.${'b'.repeat(43)}`],
    ['non-hex id', `gdk_${'z'.repeat(32)}.${'b'.repeat(43)}`],
    ['short random part', `gdk_${hex}.short`],
    ['empty', ''],
  ])('rejects %s', (_name, secret) => {
    expect(parseSecretCredentialId(secret)).toBeNull()
  })

  it('extracts the embedded uuid', () => {
    expect(parseSecretCredentialId(`gdk_${'0123456789abcdef'.repeat(2)}.${'b'.repeat(43)}`)).toBe(
      '01234567-89ab-cdef-0123-456789abcdef',
    )
  })
})

describe('verifyMountCredential', () => {
  const id = '01234567-89ab-cdef-0123-456789abcdef'
  const secret = `gdk_0123456789abcdef0123456789abcdef.${'r'.repeat(43)}`
  const row = {
    id,
    userId: 'user_1',
    organizationId: 'org_acme',
    username: 'alice@acme.test',
    label: 'Work MacBook',
    secretHash: sha256(secret),
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    lastUsedAt: null,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(findDriveCredentialById).mockResolvedValue(row as never)
  })

  it('allows a valid credential, returns the subject, and stamps last-used', async () => {
    await expect(verifyMountCredential({ username: 'alice@acme.test', secret })).resolves.toEqual({
      allow: true,
      userId: 'user_1',
      organizationId: 'org_acme',
    })
    expect(touchDriveCredentialLastUsed).toHaveBeenCalledWith(id)
  })

  it('username comparison is case-insensitive (OS dialogs mangle case)', async () => {
    await expect(verifyMountCredential({ username: 'Alice@ACME.test', secret })).resolves.toMatchObject({
      allow: true,
    })
  })

  it('denies a malformed secret without touching the database', async () => {
    await expect(verifyMountCredential({ username: 'alice@acme.test', secret: 'password123' })).resolves.toEqual({
      allow: false,
    })
    expect(findDriveCredentialById).not.toHaveBeenCalled()
  })

  it.each([
    ['unknown id', () => vi.mocked(findDriveCredentialById).mockResolvedValue(null)],
    ['revoked', () => vi.mocked(findDriveCredentialById).mockResolvedValue({ ...row, revokedAt: new Date() } as never)],
    [
      'expired',
      () =>
        vi
          .mocked(findDriveCredentialById)
          .mockResolvedValue({ ...row, expiresAt: new Date(Date.now() - 1000) } as never),
    ],
  ])('denies uniformly when %s', async (_name, arrange) => {
    arrange()
    await expect(verifyMountCredential({ username: 'alice@acme.test', secret })).resolves.toEqual({ allow: false })
  })

  it('denies a username that does not match the credential', async () => {
    await expect(verifyMountCredential({ username: 'mallory@acme.test', secret })).resolves.toEqual({ allow: false })
  })

  it('denies a wrong secret for a real credential id (hash mismatch)', async () => {
    const wrong = `gdk_0123456789abcdef0123456789abcdef.${'x'.repeat(43)}`
    await expect(verifyMountCredential({ username: 'alice@acme.test', secret: wrong })).resolves.toEqual({
      allow: false,
    })
    expect(touchDriveCredentialLastUsed).not.toHaveBeenCalled()
  })
})
