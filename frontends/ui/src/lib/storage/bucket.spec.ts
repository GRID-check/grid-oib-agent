import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { S3ServiceException } from '@aws-sdk/client-s3'

import {
  assertValidBucketName,
  bucketForWrite,
  bucketsForOrganization,
  ensureTenantBucket,
  perOrgBucketsEnabled,
  resolveDocumentBucket,
  tenantBucketName,
  __resetBucketCache,
} from './bucket'

/**
 * The bucket name is a tenant boundary, so these are not naming-convention
 * tests. Two organizations sharing a bucket is cross-tenant data access, and an
 * organization whose bucket name is not reproducible is an organization whose
 * data cannot be erased. Each block below pins one of those properties.
 */

const ORG = 'org_01H8XYZABCDEFGHJKMNPQRSTV'

describe('tenantBucketName', () => {
  it('is deterministic', () => {
    expect(tenantBucketName(ORG)).toBe(tenantBucketName(ORG))
  })

  it('produces a legal S3 bucket name', () => {
    expect(() => assertValidBucketName(tenantBucketName(ORG))).not.toThrow()
  })

  it('keeps the organization recognisable in the name', () => {
    // The operator-facing half of the contract: an incident should not start
    // with a lookup table.
    expect(tenantBucketName(ORG)).toContain('01h8xyzabcdefghjkmnpqrstv')
  })

  it('ends in a truncated SHA-256 of the ORIGINAL id, not of the slug', () => {
    const expected = createHash('sha256').update(ORG).digest('hex').slice(0, 12)
    expect(tenantBucketName(ORG).endsWith(expected)).toBe(true)
  })

  // The reason the hash exists at all. Sanitising into the S3 alphabet is
  // lossy, so ids that differ only in case or punctuation slug identically —
  // and a shared bucket between two tenants is the exact failure this whole
  // change exists to prevent.
  it.each([
    ['Org_1', 'org-1'],
    ['org.1', 'org_1'],
    ['ORG-1', 'org--1'],
    ['a_b', 'a-b'],
  ])('does not collide for ids that slug identically (%s vs %s)', (left, right) => {
    expect(tenantBucketName(left)).not.toBe(tenantBucketName(right))
  })

  it('stays inside 63 characters for a long organization id', () => {
    const long = `org_${'X'.repeat(120)}`
    const name = tenantBucketName(long)
    expect(name.length).toBeLessThanOrEqual(63)
    expect(() => assertValidBucketName(name)).not.toThrow()
  })

  it('still distinguishes two long ids that share a truncated prefix', () => {
    // Truncation alone would map both to the same slug. The hash is computed
    // before truncation, so it does not.
    const a = `org_${'X'.repeat(120)}a`
    const b = `org_${'X'.repeat(120)}b`
    expect(tenantBucketName(a)).not.toBe(tenantBucketName(b))
  })

  it('produces a valid name for an id with no usable characters at all', () => {
    const name = tenantBucketName('___')
    expect(() => assertValidBucketName(name)).not.toThrow()
    // No `--` from an empty slug meeting the prefix's trailing hyphen.
    expect(name).not.toContain('--')
  })

  it('never leaves a trailing hyphen where truncation cut the slug', () => {
    // A slug whose budget boundary lands on a `-` would otherwise produce
    // `...-<hash>` with a doubled hyphen, or worse, end in one.
    for (let n = 30; n < 60; n++) {
      const name = tenantBucketName(`org-${'a-'.repeat(n)}`)
      expect(() => assertValidBucketName(name)).not.toThrow()
    }
  })

  it('refuses an empty organization id rather than minting a shared bucket', () => {
    expect(() => tenantBucketName('')).toThrow(/non-empty/)
  })

  it('honours SEAWEED_TENANT_BUCKET_PREFIX', () => {
    vi.stubEnv('SEAWEED_TENANT_BUCKET_PREFIX', 'acme-t-')
    expect(tenantBucketName(ORG).startsWith('acme-t-')).toBe(true)
  })
})

describe('assertValidBucketName', () => {
  it.each([
    ['ab', /length/],
    [`${'a'.repeat(64)}`, /length/],
    ['Grid-Org-1', /lowercase/],
    ['-grid-org-1', /lowercase/],
    ['grid-org-1-', /lowercase/],
    ['grid..org', /consecutive dots/],
    ['10.0.0.1', /IP address/],
  ])('rejects %s', (name, message) => {
    expect(() => assertValidBucketName(name)).toThrow(message)
  })

  it('accepts a well-formed name', () => {
    expect(assertValidBucketName('grid-org-abc-0123456789ab')).toBe('grid-org-abc-0123456789ab')
  })
})

describe('bucket selection', () => {
  beforeEach(() => {
    __resetBucketCache()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('writes to the shared bucket when the feature is off', () => {
    vi.stubEnv('SEAWEED_PER_ORG_BUCKETS', 'false')
    expect(perOrgBucketsEnabled()).toBe(false)
    expect(bucketForWrite(ORG)).toBe('grid-documents')
  })

  it('writes to the organization bucket when the feature is on', () => {
    vi.stubEnv('SEAWEED_PER_ORG_BUCKETS', 'true')
    expect(bucketForWrite(ORG)).toBe(tenantBucketName(ORG))
  })

  // The compatibility contract. A row written before migration 0033 carries
  // NULL, and NULL has exactly one meaning, forever — recomputing the bucket
  // from the org id on a read is what would turn the feature flag into a
  // cutover that strands every older object.
  it('resolves a NULL recorded bucket to the shared bucket even when the feature is on', () => {
    vi.stubEnv('SEAWEED_PER_ORG_BUCKETS', 'true')
    expect(resolveDocumentBucket(null)).toBe('grid-documents')
    expect(resolveDocumentBucket(undefined)).toBe('grid-documents')
  })

  it('resolves a recorded bucket to itself', () => {
    expect(resolveDocumentBucket('grid-org-whatever-0123456789ab')).toBe(
      'grid-org-whatever-0123456789ab',
    )
  })

  // Erasure must visit both. An organization that predates the flip has objects
  // in the shared bucket AND in its own; sweeping only the current one leaves
  // the older half behind, which for a deletion request is the whole failure.
  it('enumerates both buckets for an organization when the feature is on', () => {
    vi.stubEnv('SEAWEED_PER_ORG_BUCKETS', 'true')
    expect(bucketsForOrganization(ORG)).toEqual(['grid-documents', tenantBucketName(ORG)])
  })

  it('enumerates only the shared bucket when the feature is off', () => {
    vi.stubEnv('SEAWEED_PER_ORG_BUCKETS', 'false')
    expect(bucketsForOrganization(ORG)).toEqual(['grid-documents'])
  })
})

describe('ensureTenantBucket', () => {
  // Real `S3ServiceException`s, because that is what the production code
  // narrows on — a duck-typed plain object would pass a test the running code
  // would fail.
  const s3Error = (name: string, status: number): S3ServiceException =>
    new S3ServiceException({
      name,
      $fault: 'client',
      $metadata: { httpStatusCode: status },
      message: name,
    })

  beforeEach(() => {
    __resetBucketCache()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('does nothing at all when the feature is off — not even a HeadBucket', async () => {
    vi.stubEnv('SEAWEED_PER_ORG_BUCKETS', 'false')
    const send = vi.fn()
    const bucket = await ensureTenantBucket({ send } as never, ORG)
    expect(bucket).toBe('grid-documents')
    expect(send).not.toHaveBeenCalled()
  })

  it('returns without creating when the bucket already exists', async () => {
    vi.stubEnv('SEAWEED_PER_ORG_BUCKETS', 'true')
    const send = vi.fn().mockResolvedValue({})
    const bucket = await ensureTenantBucket({ send } as never, ORG)
    expect(bucket).toBe(tenantBucketName(ORG))
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('creates the bucket when HeadBucket 404s', async () => {
    vi.stubEnv('SEAWEED_PER_ORG_BUCKETS', 'true')
    const send = vi
      .fn()
      .mockRejectedValueOnce(s3Error('NotFound', 404))
      .mockResolvedValueOnce({})
    await ensureTenantBucket({ send } as never, ORG)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1][0].input).toEqual({ Bucket: tenantBucketName(ORG) })
  })

  // Two concurrent first-uploads for a new organization both miss the cache,
  // both 404, and both create. Losing that race must be success, or one of the
  // two uploads fails for a reason the user cannot act on.
  it('treats losing the create race as success', async () => {
    vi.stubEnv('SEAWEED_PER_ORG_BUCKETS', 'true')
    const send = vi
      .fn()
      .mockRejectedValueOnce(s3Error('NotFound', 404))
      .mockRejectedValueOnce(s3Error('BucketAlreadyOwnedByYou', 409))
    await expect(ensureTenantBucket({ send } as never, ORG)).resolves.toBe(tenantBucketName(ORG))
  })

  it('propagates a HeadBucket failure that is not a 404', async () => {
    vi.stubEnv('SEAWEED_PER_ORG_BUCKETS', 'true')
    // A 403 means the credential is wrong, not that the bucket is absent.
    // Swallowing it would turn a misconfigured deployment into a CreateBucket
    // storm, and then into uploads that 500 with the wrong cause.
    const send = vi.fn().mockRejectedValue(s3Error('AccessDenied', 403))
    await expect(ensureTenantBucket({ send } as never, ORG)).rejects.toThrow()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('does not re-check a bucket it has already seen', async () => {
    vi.stubEnv('SEAWEED_PER_ORG_BUCKETS', 'true')
    const send = vi.fn().mockResolvedValue({})
    await ensureTenantBucket({ send } as never, ORG)
    await ensureTenantBucket({ send } as never, ORG)
    expect(send).toHaveBeenCalledTimes(1)
  })

  // Guards the narrowing itself. A transport failure — a socket reset, a DNS
  // miss — is a plain Error, not an S3ServiceException. Reading it as "bucket
  // absent" would send the code on to CreateBucket against a storage tier that
  // is simply unreachable.
  it('does not mistake a plain transport error for a missing bucket', async () => {
    vi.stubEnv('SEAWEED_PER_ORG_BUCKETS', 'true')
    const send = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(ensureTenantBucket({ send } as never, ORG)).rejects.toThrow('ECONNREFUSED')
    expect(send).toHaveBeenCalledTimes(1)
  })
})
