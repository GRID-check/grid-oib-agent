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
  const CLAIM_PREFIX = '.grid-bucket-owner/'
  /** The key one organization claims with — mirrors `ownerClaimKey`. */
  const claimKey = (org: string): string =>
    `${CLAIM_PREFIX}${createHash('sha256').update(org).digest('hex')}`

  /**
   * A fake object STORE, not a fake call sequence.
   *
   * Deliberately a real little key-value bucket with real List/Get/Put semantics
   * (prefix filtering, MaxKeys, NoSuchKey), because the protocol under test is
   * about what the store contains and in what order things become visible. A
   * mock that answered per call in a fixed sequence is exactly what let a
   * last-write-wins ownership marker pass for a verified boundary.
   *
   * `objects` is shared across bucket names on purpose in the collision tests —
   * one flat namespace IS the situation the claim exists for (two organization
   * ids resolving to one container), and it is otherwise unreachable, since
   * `tenantBucketName` will not hand out the same name twice.
   */
  function fakeS3(state: {
    bucketExists: boolean
    /** Initial contents, key → body. */
    objects?: Map<string, string>
    createFails?: S3ServiceException
    headFails?: unknown
    /** Called after every command, so a test can interleave a second caller. */
    onCommand?: (name: string) => Promise<void> | void
  }) {
    const objects = state.objects ?? new Map<string, string>()
    const calls: Array<{ command: string; input: Record<string, unknown> }> = []
    const send = vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = command.constructor.name
      const input = command.input
      calls.push({ command: name, input })
      const answer = ((): unknown => {
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
            const body = objects.get(String(input.Key))
            if (body === undefined) throw s3Error('NoSuchKey', 404)
            return { Body: { transformToString: async () => body } }
          }
          case 'ListObjectsV2Command': {
            const prefix = input.Prefix === undefined ? '' : String(input.Prefix)
            const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort()
            return { Contents: keys.slice(0, Number(input.MaxKeys ?? 1000)).map((Key) => ({ Key })) }
          }
          case 'PutObjectCommand':
            objects.set(String(input.Key), String(input.Body))
            return {}
          default:
            throw new Error(`unexpected command ${name}`)
        }
      })()
      await state.onCommand?.(name)
      return answer
    })
    return { send, calls, objects, state }
  }

  const names = (calls: Array<{ command: string }>): string[] => calls.map((c) => c.command)
  /** Who, if anyone, the store says owns the bucket. */
  const owners = (objects: Map<string, string>): string[] =>
    [...objects.entries()].filter(([key]) => key.startsWith(CLAIM_PREFIX)).map(([, body]) => body)

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
  it('creates the bucket, claims it, and verifies the claim, in that order', async () => {
    const s3 = fakeS3({ bucketExists: false })
    expect(await ensureTenantBucket({ send: s3.send } as never, ORG)).toBe(BUCKET)

    // No listing BEFORE the create: a bucket this call just made can hold neither
    // a claim nor a stranger's objects, and asking would cost two round trips on
    // every new tenant's first upload. The listing AFTER the claim is not
    // skippable — it is the whole concurrency argument (see the interleaving test
    // below).
    expect(names(s3.calls)).toEqual([
      'HeadBucketCommand',
      'CreateBucketCommand',
      'PutObjectCommand',
      'ListObjectsV2Command',
    ])
    expect(owners(s3.objects)).toEqual([ORG])
  })

  // ── State 2: present, claimed by us ───────────────────────────────────────
  it('accepts a bucket already claimed by this organization, and writes nothing', async () => {
    const s3 = fakeS3({
      bucketExists: true,
      objects: new Map([
        [claimKey(ORG), ORG],
        ['org/x/doc.pdf', 'x'],
      ]),
    })
    expect(await ensureTenantBucket({ send: s3.send } as never, ORG)).toBe(BUCKET)
    // One listing and nothing else. This is the cost every cold-cache upload
    // pays, so it is the number that has to stay small.
    expect(names(s3.calls)).toEqual(['HeadBucketCommand', 'ListObjectsV2Command'])
    expect(names(s3.calls)).not.toContain('PutObjectCommand')
  })

  // ── State 3: present, claimed by someone else ─────────────────────────────
  //
  // The case the claim exists for. Two organizations whose bucket names collide —
  // or two deployments sharing one SeaweedFS with the same tenant prefix — would
  // otherwise read and write one bucket with nothing anywhere saying so.
  // Refusing the upload is the only safe answer, and it names both parties so an
  // operator can act on it.
  it('refuses a bucket claimed by a different organization', async () => {
    const s3 = fakeS3({
      bucketExists: true,
      objects: new Map([[claimKey('org_SOMEONE_ELSE'), 'org_SOMEONE_ELSE']]),
    })
    await expect(ensureTenantBucket({ send: s3.send } as never, ORG)).rejects.toThrow(
      /claimed by organization "org_SOMEONE_ELSE"/,
    )
    // Critically: it wrote nothing at all — not the object, and not a claim of
    // its own alongside the other tenant's.
    expect(names(s3.calls)).not.toContain('PutObjectCommand')
    expect(owners(s3.objects)).toEqual(['org_SOMEONE_ELSE'])
  })

  it('does not cache a bucket it refused', async () => {
    const s3 = fakeS3({
      bucketExists: true,
      objects: new Map([[claimKey('org_SOMEONE_ELSE'), 'org_SOMEONE_ELSE']]),
    })
    await expect(ensureTenantBucket({ send: s3.send } as never, ORG)).rejects.toThrow()
    // A refusal that poisoned the cache as "seen" would make the SECOND upload
    // succeed into the wrong tenant's bucket.
    await expect(ensureTenantBucket({ send: s3.send } as never, ORG)).rejects.toThrow()
  })

  // ── State 4: present, unclaimed ───────────────────────────────────────────
  it('claims an empty unclaimed bucket, which is a half-finished provision', async () => {
    // Exactly the state left behind when a previous attempt created the bucket
    // and failed before claiming it. Refusing here would make a transient
    // failure permanent for that tenant.
    const s3 = fakeS3({ bucketExists: true })
    expect(await ensureTenantBucket({ send: s3.send } as never, ORG)).toBe(BUCKET)
    expect(owners(s3.objects)).toEqual([ORG])
  })

  it('refuses a NON-empty unclaimed bucket', async () => {
    // Objects that cannot be attributed. Claiming it would silently adopt
    // whatever is in there as this organization's documents.
    const s3 = fakeS3({
      bucketExists: true,
      objects: new Map([['org/other/doc.pdf', 'x']]),
    })
    await expect(ensureTenantBucket({ send: s3.send } as never, ORG)).rejects.toThrow(
      /holds objects but carries no ownership claim/,
    )
    // And left no claim behind, which would have made the next attempt believe
    // those objects were accounted for.
    expect(owners(s3.objects)).toEqual([])
  })

  // ── Races and failures ────────────────────────────────────────────────────
  //
  // Two concurrent first-uploads for a new organization both miss the cache,
  // both 404, and both create. Losing that race must be success, or one of the
  // two uploads fails for a reason the user cannot act on. The loser then has to
  // verify ownership like any other existing bucket — the winner may not have
  // claimed it yet, which is why the empty-bucket path exists.
  it('treats losing the create race as success', async () => {
    const s3 = fakeS3({
      bucketExists: false,
      createFails: s3Error('BucketAlreadyOwnedByYou', 409),
    })
    expect(await ensureTenantBucket({ send: s3.send } as never, ORG)).toBe(BUCKET)
    expect(owners(s3.objects)).toEqual([ORG])
  })

  /**
   * The race a single mutable marker could not detect, and the reason the claim
   * is a prefix.
   *
   * Two organizations resolving to ONE container — a hash collision, or two
   * deployments sharing a SeaweedFS with the same tenant prefix. With one
   * marker object they both read "absent", both wrote their own id, and
   * last-write-wins: each had already read back its own value, so both proceeded
   * and two tenants shared a bucket while the marker asserted the boundary was
   * verified.
   *
   * Here the interleaving is forced to the worst case — BOTH parties look, see an
   * unclaimed bucket, and only then write — by parking the first caller on its
   * opening listing and running the second one all the way through. That is the
   * exact window a read-then-write protocol leaves open, and the one the old
   * marker fell into.
   *
   * The invariant is not "the first one wins". It is that AT MOST ONE proceeds,
   * and that both claims survive so an operator can see the conflict. Which one
   * is refused is timing; that one is, is the design.
   */
  it('cannot let two organizations both claim one bucket, whatever the interleaving', async () => {
    const OTHER = 'org_01H8COLLIDESWITHTHEFIRSTONE' // pragma: allowlist secret (an org id)
    // One flat namespace across both bucket names: the collision itself, which
    // `tenantBucketName` deliberately will not otherwise produce.
    const objects = new Map<string, string>()

    let release: (() => void) | undefined
    const parked = new Promise<void>((resolve) => {
      release = resolve
    })
    let lists = 0
    const onCommand = async (name: string): Promise<void> => {
      if (name !== 'ListObjectsV2Command') return
      lists += 1
      // Hold the first caller right after it has seen "unclaimed", before it
      // writes anything.
      if (lists === 1) await parked
    }

    const s3 = fakeS3({ bucketExists: true, objects, onCommand })
    const first = ensureTenantBucket({ send: s3.send } as never, ORG)
    await vi.waitFor(() => expect(lists).toBe(1))

    // The second caller sees the same unclaimed bucket the first one did, and
    // completes: claim, verify, done.
    const second = await Promise.allSettled([ensureTenantBucket({ send: s3.send } as never, OTHER)])
    release?.()
    const firstResult = await Promise.allSettled([first])

    const settled = [...firstResult, ...second]
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    // The one that came second in real time is the one that got there first, and
    // the other is refused by name rather than silently joining it.
    expect(second[0]!.status).toBe('fulfilled')
    expect(firstResult[0]!.status).toBe('rejected')
    // Both claims survive, which is what turns a silent overwrite into something
    // an operator can see and resolve.
    expect(owners(objects).sort()).toEqual([OTHER, ORG].sort())
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
    const s3 = fakeS3({ bucketExists: true, objects: new Map([[claimKey(ORG), ORG]]) })
    await ensureTenantBucket({ send: s3.send } as never, ORG)
    const after = s3.calls.length
    await ensureTenantBucket({ send: s3.send } as never, ORG)
    // The ownership check costs one extra round trip on a cold cache and nothing
    // afterwards — which is what makes it affordable on the upload path. Pinned as
    // a number because "verified" is the sort of property that gets paid for again
    // on every request once nobody is counting.
    expect(s3.calls.length).toBe(after)
    expect(after).toBe(2)
  })
})
