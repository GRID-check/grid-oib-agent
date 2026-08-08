import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { S3ServiceException } from '@aws-sdk/client-s3'

import {
  assertValidBucketName,
  bucketForWrite,
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

const ORG = 'org_01H8XYZABCDEFGHJKMNPQRSTV' // pragma: allowlist secret (a WorkOS org id, not a credential)

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
    //
    // Only the LEADING part of the id survives now, and that is the price of the
    // 128-bit suffix: 9 characters of prefix plus 1 separator plus 32 of hash
    // leaves 21 for the slug, where 48 bits left 41. The suffix is what holds
    // the tenant boundary and the slug is what makes a bucket greppable, so when
    // the two compete the boundary wins.
    expect(tenantBucketName(ORG)).toContain('org-01h8xyz') // pragma: allowlist secret
  })

  it('ends in a 128-bit SHA-256 of the ORIGINAL id, not of the slug', () => {
    // 32 hex, not 12. At 48 bits the birthday bound over 100,000 organizations
    // was ≈1 in 56,000 — and a collision here is cross-tenant read and write
    // access, so the number had to stop being the weakest link. At 128 bits the
    // same population gives ≈1.5e-29.
    const expected = createHash('sha256').update(ORG).digest('hex').slice(0, 32)
    expect(expected).toHaveLength(32)
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

  // There is deliberately no test for enumerating "every bucket an organization
  // could be in", because there is deliberately no function for it any more.
  // `bucketsForOrganization` recomputed the set from the org id, so it silently
  // stopped returning the right bucket the moment the prefix or the hash width
  // changed — and it reported success while doing so, because sweeping a bucket
  // that does not exist looks exactly like sweeping an empty one. The ledger is
  // the enumeration: `SELECT DISTINCT storage_bucket FROM documents`, which is
  // what the purger reads (see purger/purge-project.spec.mjs).
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

  const BUCKET = tenantBucketName(ORG)
  const MARKER = '.grid-bucket-owner'

  /**
   * A fake S3 that answers by command name, so a test states the STATE of the
   * bucket rather than a call sequence. Sequence-based mocks are what let the
   * marker protocol be added without any of these tests noticing.
   */
  function fakeS3(state: {
    bucketExists: boolean
    /** Marker contents; null means the object is absent. */
    marker?: string | null
    /** Keys in the bucket, excluding the marker. */
    keys?: string[]
    createFails?: S3ServiceException
    headFails?: unknown
  }) {
    const calls: Array<{ command: string; input: Record<string, unknown> }> = []
    const send = vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = command.constructor.name
      calls.push({ command: name, input: command.input })
      switch (name) {
        case 'HeadBucketCommand':
          if (state.headFails) throw state.headFails
          if (!state.bucketExists) throw s3Error('NotFound', 404)
          return {}
        case 'CreateBucketCommand':
          if (state.createFails) throw state.createFails
          state.bucketExists = true
          return {}
        case 'GetObjectCommand': {
          const marker = state.marker ?? null
          if (marker === null) throw s3Error('NoSuchKey', 404)
          return { Body: { transformToString: async () => marker } }
        }
        case 'ListObjectsV2Command':
          return {
            Contents: [
              ...(state.marker != null ? [{ Key: MARKER }] : []),
              ...(state.keys ?? []).map((Key) => ({ Key })),
            ].slice(0, Number(command.input.MaxKeys ?? 1000)),
          }
        case 'PutObjectCommand':
          state.marker = String(command.input.Body)
          return {}
        default:
          throw new Error(`unexpected command ${name}`)
      }
    })
    return { send, calls, state }
  }

  const names = (calls: Array<{ command: string }>): string[] => calls.map((c) => c.command)

  beforeEach(() => {
    __resetBucketCache()
    vi.stubEnv('SEAWEED_PER_ORG_BUCKETS', 'true')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('does nothing at all when the feature is off — not even a HeadBucket', async () => {
    vi.stubEnv('SEAWEED_PER_ORG_BUCKETS', 'false')
    const s3 = fakeS3({ bucketExists: false })
    expect(await ensureTenantBucket({ send: s3.send } as never, ORG)).toBe('grid-documents')
    expect(s3.send).not.toHaveBeenCalled()
  })

  // ── State 1: absent ────────────────────────────────────────────────────────
  it('creates the bucket and marks it, in that order', async () => {
    const s3 = fakeS3({ bucketExists: false })
    expect(await ensureTenantBucket({ send: s3.send } as never, ORG)).toBe(BUCKET)

    // No GetObject: a bucket this call just created cannot have a marker, and
    // asking would cost a round trip on every new tenant's first upload.
    expect(names(s3.calls)).toEqual([
      'HeadBucketCommand',
      'CreateBucketCommand',
      'PutObjectCommand',
    ])
    expect(s3.state.marker).toBe(ORG)
  })

  // ── State 2: present, marker matches ──────────────────────────────────────
  it('accepts a bucket whose marker names this organization', async () => {
    const s3 = fakeS3({ bucketExists: true, marker: ORG, keys: ['org/x/doc.pdf'] })
    expect(await ensureTenantBucket({ send: s3.send } as never, ORG)).toBe(BUCKET)
    expect(names(s3.calls)).toEqual(['HeadBucketCommand', 'GetObjectCommand'])
    // Nothing rewritten: the marker is already correct.
    expect(names(s3.calls)).not.toContain('PutObjectCommand')
  })

  // ── State 3: present, marker names someone else ───────────────────────────
  //
  // The case the marker exists for. Two organizations whose names collide — or
  // two deployments sharing one SeaweedFS with the same tenant prefix — would
  // otherwise read and write one bucket with nothing anywhere saying so.
  // Refusing the upload is the only safe answer, and it names both parties so an
  // operator can act on it.
  it('refuses a bucket marked for a different organization', async () => {
    const s3 = fakeS3({ bucketExists: true, marker: 'org_SOMEONE_ELSE' })
    await expect(ensureTenantBucket({ send: s3.send } as never, ORG)).rejects.toThrow(
      /belonging to organization "org_SOMEONE_ELSE"/,
    )
    // Critically: it did not write, and it did not overwrite the marker.
    expect(names(s3.calls)).not.toContain('PutObjectCommand')
    expect(s3.state.marker).toBe('org_SOMEONE_ELSE')
  })

  it('does not cache a bucket it refused', async () => {
    const s3 = fakeS3({ bucketExists: true, marker: 'org_SOMEONE_ELSE' })
    await expect(ensureTenantBucket({ send: s3.send } as never, ORG)).rejects.toThrow()
    // A refusal that poisoned the cache as "seen" would make the SECOND upload
    // succeed into the wrong tenant's bucket.
    await expect(ensureTenantBucket({ send: s3.send } as never, ORG)).rejects.toThrow()
  })

  // ── State 4: present, no marker ───────────────────────────────────────────
  it('claims an empty unmarked bucket, which is a half-finished provision', async () => {
    // Exactly the state left behind when a previous attempt created the bucket
    // and failed before writing the marker. Refusing here would make a transient
    // failure permanent for that tenant.
    const s3 = fakeS3({ bucketExists: true, marker: null, keys: [] })
    expect(await ensureTenantBucket({ send: s3.send } as never, ORG)).toBe(BUCKET)
    expect(s3.state.marker).toBe(ORG)
  })

  it('refuses a NON-empty unmarked bucket', async () => {
    // Objects that cannot be attributed. Claiming it would silently adopt
    // whatever is in there as this organization's documents.
    const s3 = fakeS3({ bucketExists: true, marker: null, keys: ['org/other/doc.pdf'] })
    await expect(ensureTenantBucket({ send: s3.send } as never, ORG)).rejects.toThrow(
      /holds objects but carries no ownership marker/,
    )
    expect(s3.state.marker).toBeNull()
  })

  // ── Races and failures ────────────────────────────────────────────────────
  //
  // Two concurrent first-uploads for a new organization both miss the cache,
  // both 404, and both create. Losing that race must be success, or one of the
  // two uploads fails for a reason the user cannot act on. The loser then has to
  // verify the marker like any other existing bucket — the winner may not have
  // written it yet, which is why the empty-bucket path exists.
  it('treats losing the create race as success', async () => {
    const s3 = fakeS3({
      bucketExists: false,
      marker: null,
      keys: [],
      createFails: s3Error('BucketAlreadyOwnedByYou', 409),
    })
    expect(await ensureTenantBucket({ send: s3.send } as never, ORG)).toBe(BUCKET)
    expect(s3.state.marker).toBe(ORG)
  })

  it('propagates a HeadBucket failure that is not a 404', async () => {
    // A 403 means the credential is wrong, not that the bucket is absent.
    // Swallowing it would turn a misconfigured deployment into a CreateBucket
    // storm, and then into uploads that 500 with the wrong cause.
    const s3 = fakeS3({ bucketExists: true, headFails: s3Error('AccessDenied', 403) })
    await expect(ensureTenantBucket({ send: s3.send } as never, ORG)).rejects.toThrow()
    expect(names(s3.calls)).toEqual(['HeadBucketCommand'])
  })

  // Guards the narrowing itself. A transport failure — a socket reset, a DNS
  // miss — is a plain Error, not an S3ServiceException. Reading it as "bucket
  // absent" would send the code on to CreateBucket against a storage tier that
  // is simply unreachable.
  it('does not mistake a plain transport error for a missing bucket', async () => {
    const s3 = fakeS3({ bucketExists: true, headFails: new Error('ECONNREFUSED') })
    await expect(ensureTenantBucket({ send: s3.send } as never, ORG)).rejects.toThrow(
      'ECONNREFUSED',
    )
    expect(names(s3.calls)).toEqual(['HeadBucketCommand'])
  })

  // The marker read is narrowed on `NoSuchKey` alone, deliberately tighter than
  // the bucket check. A 403 on the marker means this deployment cannot READ the
  // bucket it is about to claim — treating that as "no marker" would overwrite
  // the ownership record of a bucket it has no business in.
  it('does not treat an unreadable marker as an absent one', async () => {
    const s3 = fakeS3({ bucketExists: true })
    s3.send.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'HeadBucketCommand') return {}
      throw s3Error('AccessDenied', 403)
    })
    await expect(ensureTenantBucket({ send: s3.send } as never, ORG)).rejects.toThrow(
      'AccessDenied',
    )
  })

  it('verifies once per bucket, then serves from the cache', async () => {
    const s3 = fakeS3({ bucketExists: true, marker: ORG })
    await ensureTenantBucket({ send: s3.send } as never, ORG)
    const after = s3.calls.length
    await ensureTenantBucket({ send: s3.send } as never, ORG)
    // The marker check costs one extra round trip on a cold cache and nothing
    // afterwards — which is what makes it affordable on the upload path.
    expect(s3.calls.length).toBe(after)
    expect(after).toBe(2)
  })
})
