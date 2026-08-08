import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3'
import { createHash } from 'node:crypto'
import { bucketName as sharedBucketName } from '@/lib/s3'

/**
 * Which bucket an organization's objects live in (ADR-0043), and how one gets
 * created.
 *
 * One module: the naming rule, the resolution rule, and provisioning. It used
 * to be two, with the algorithm in a CommonJS twin so the purger could load it
 * — the purger is plain Node and cannot import TypeScript. That is gone, and
 * not by finding a way to load TypeScript from CommonJS: the purger stopped
 * needing the rule at all. It reads the buckets its documents RECORDED instead
 * of deriving them, which is both more complete and impossible to get wrong by
 * disagreeing with this file.
 *
 * ## The bucket is recorded, not recomputed
 *
 * Every document row carries `storage_bucket`. A NULL means "the shared
 * bucket", which is what every row written before this existed means, and the
 * read paths resolve it with {@link resolveDocumentBucket}. Nothing recomputes
 * the bucket from the org id on a READ.
 *
 * That is the whole compatibility story, and it is deliberate: turning
 * `SEAWEED_PER_ORG_BUCKETS` on changes where the NEXT object is written and
 * nothing else. Old objects keep resolving from their recorded bucket, forever,
 * with no cutover, no backfill and no window where a read can miss. Turning the
 * flag back off is equally uneventful.
 *
 * ## What per-org buckets actually buy
 *
 * Worth being precise, because it is less than "isolation" and more than
 * cosmetic:
 *
 * - **The container for a tenant's objects exists**, which is what makes
 *   erasing one a single operation rather than a paginated list-and-delete
 *   that can fail halfway and leave objects behind after the rows naming them
 *   are gone. Not yet realised: the deletion pipeline (ADR-0011) implements
 *   `project` and nothing else, and a project is a subset of an organization's
 *   bucket, so it stays a prefix sweep — across both buckets now. When the
 *   ORGANIZATION purger is built it can be `DeleteBucket`, and with SeaweedFS's
 *   `postgres2` store the metadata side of that is a `DROP TABLE`.
 * - **A key-construction bug stops being a cross-tenant bug.** The tenant
 *   boundary moves from a string prefix inside a shared namespace to the
 *   container itself.
 * - **Usage is measurable per tenant at the storage layer**, independently of
 *   the application's own ledger — which is what lets the two be reconciled.
 *
 * What it does NOT buy, and the reason is worth writing down: the BFF still
 * holds one credential, scoped `Read:grid-org-*` / `Write:grid-org-*` across
 * every tenant bucket. Per-organization CREDENTIALS would be the next step, and
 * SeaweedFS can express them — but they would have to live in the filer's
 * runtime IAM store, which the offsite mirror deliberately does not back up
 * (`-filerPath=/buckets` excludes `/etc`). Losing that state would lock every
 * tenant out of their own data. Authorization stays where ADR-0038 put it.
 */


/**
 * Default prefix. Mirrored by `seaweedfsTenantBucketPrefix` in the Pulumi
 * config, which validates it — including that it is not itself a prefix of any
 * platform bucket name, since the S3 grants are wildcarded on it.
 */
export const DEFAULT_TENANT_BUCKET_PREFIX = 'grid-org-'

/**
 * Hex characters of SHA-256 kept as the uniqueness suffix.
 *
 * 32 hex = 128 bits. A collision here is not cosmetic — two organizations would
 * resolve to the same bucket, which is cross-tenant read and write access — so
 * the question is not "is this unlikely" but "is this the weakest link".
 *
 * At 48 bits (the previous 12 characters) it was. The birthday bound is
 * `n²/(2·2^b)`: at 100,000 organizations that is ≈1.8e-5, about 1 in 56,000.
 * The ADR previously said 1 in 30,000, which was this same arithmetic missing
 * its factor of two — pessimistic, and wrong, in a note about a security
 * boundary.
 *
 * At 128 bits the same 100,000 organizations give ≈1.5e-29, and a million give
 * ≈1.5e-27. That is orders of magnitude below the probability of an undetected
 * memory or disk error in the same operation, so the hash stops being the thing
 * worth reasoning about.
 *
 * It is still a probability, not a proof — a truncated hash cannot be injective.
 * What makes that acceptable is not the exponent but {@link ensureTenantBucket}:
 * every bucket carries an ownership marker that is verified before it is used,
 * so a collision (or two deployments sharing one SeaweedFS) fails closed and
 * loudly instead of silently sharing a tenant's objects.
 */
const HASH_CHARS = 32

/** S3's hard ceiling on a bucket name. */
const MAX_BUCKET_NAME = 63

/**
 * Reduce an arbitrary identifier to the S3 bucket alphabet. Lossy by design —
 * the hash suffix is what restores uniqueness.
 */
function slugify(organizationId: string): string {
  return organizationId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Throw unless `name` is a legal S3 bucket name.
 *
 * Called on the way out of {@link tenantBucketName}, on a value this module
 * just built. Not redundant: the input is an organization id from an external
 * identity provider, so this is the only thing standing between a malformed id
 * and a bucket name. Failing at the call site beats a CreateBucket that returns
 * InvalidBucketName three layers down.
 */
export function assertValidBucketName(name: string): string {
  if (name.length < 3 || name.length > MAX_BUCKET_NAME) {
    throw new Error(
      `Invalid S3 bucket name "${name}": length ${name.length} is outside 3–${MAX_BUCKET_NAME}.`,
    )
  }
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(name)) {
    throw new Error(
      `Invalid S3 bucket name "${name}": must be lowercase alphanumeric, hyphen or dot, ` +
        'and start and end with a letter or digit.',
    )
  }
  if (name.includes('..')) {
    throw new Error(`Invalid S3 bucket name "${name}": consecutive dots are not allowed.`)
  }
  // A name that parses as an IPv4 address is rejected by S3 (and by SeaweedFS's
  // own VerifyS3BucketName) because it is ambiguous with virtual-host
  // addressing. Unreachable with the default prefix; checked anyway, because
  // the prefix is configurable.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) {
    throw new Error(`Invalid S3 bucket name "${name}": must not be formatted as an IP address.`)
  }
  // SeaweedFS's own `VerifyS3BucketName` rejects both of these outright, so a
  // name we accept and it does not is an upload that fails at bucket-creation
  // time for one specific tenant. `xn--` is reachable through a configured
  // prefix; `-s3alias` is not, because every name ends in hex — checked anyway,
  // since matching a validator we do not control is the cheaper half.
  if (name.startsWith('xn--')) {
    throw new Error(`Invalid S3 bucket name "${name}": must not start with "xn--".`)
  }
  if (name.endsWith('-s3alias')) {
    throw new Error(`Invalid S3 bucket name "${name}": must not end with "-s3alias".`)
  }
  return name
}

/**
 * The bucket for one organization. Pure: same inputs, same name, forever.
 *
 * Three properties, each load-bearing:
 *
 * 1. **Deterministic.** No lookup table, no state.
 * 2. **Collision-resistant, and verified anyway.** Slugging into the S3 alphabet
 *    is lossy (`Org_1` and `org-1` both reduce to `org-1`), so a truncated
 *    SHA-256 of the ORIGINAL id is appended unconditionally — unconditionally
 *    rather than only when the slug is lossy, because "is this id lossy?" is one
 *    more thing to get wrong. 128 bits makes a collision negligible (see
 *    {@link HASH_CHARS}); the ownership marker in {@link ensureTenantBucket}
 *    makes one DETECTABLE, which is the property that actually holds the
 *    boundary. A truncated hash can never be injective, so the design does not
 *    depend on it being so.
 * 3. **Recognisable.** An operator looking at `grid-org-org-01h8…-3f9a12c4…`
 *    can see which tenant it belongs to, which a bare hash would not give them.
 *    The 128-bit suffix costs 20 characters of the slug budget, so long ids are
 *    truncated further than before — the hash, not the slug, is what identifies.
 */
export function tenantBucketName(
  organizationId: string,
  prefix: string = tenantPrefix(),
): string {
  if (!organizationId) {
    throw new Error('tenantBucketName requires a non-empty organization id.')
  }
  const hash = createHash('sha256').update(organizationId).digest('hex').slice(0, HASH_CHARS)

  // Everything the prefix and the suffix do not already claim. The suffix costs
  // HASH_CHARS plus its separating hyphen.
  const slugBudget = MAX_BUCKET_NAME - prefix.length - 1 - HASH_CHARS
  if (slugBudget < 1) {
    throw new Error(
      `Tenant bucket prefix "${prefix}" leaves no room for an organization id ` +
        `within S3's ${MAX_BUCKET_NAME}-character limit.`,
    )
  }

  // Trim any hyphen the truncation exposed, so the slug never ends in one and
  // the name never contains `--` at the join.
  const slug = slugify(organizationId).slice(0, slugBudget).replace(/-+$/, '')

  // An id made entirely of characters outside the alphabet slugs to nothing.
  // The hash alone still identifies it uniquely.
  return assertValidBucketName(slug ? `${prefix}${slug}-${hash}` : `${prefix}${hash}`)
}

/**
 * Is this deployment writing per-organization buckets?
 *
 * Read per call rather than captured at module load: the specs flip it, and a
 * captured value would make the first spec to import this module decide the
 * answer for every later one.
 */
export function perOrgBucketsEnabled(): boolean {
  return process.env.SEAWEED_PER_ORG_BUCKETS === 'true'
}

function tenantPrefix(): string {
  return process.env.SEAWEED_TENANT_BUCKET_PREFIX || DEFAULT_TENANT_BUCKET_PREFIX
}

/**
 * The bucket the NEXT object for this organization should be written to.
 *
 * Write paths call this; read paths must not — they resolve from the row (see
 * {@link resolveDocumentBucket}), or an object written before the flag flipped
 * would be looked for in the wrong place.
 */
export function bucketForWrite(organizationId: string): string {
  return perOrgBucketsEnabled() ? tenantBucketName(organizationId) : sharedBucketName
}

/**
 * The bucket an existing object lives in. NULL means the shared bucket: that is
 * what every row predating ADR-0043 carries, and the meaning is fixed forever.
 */
export function resolveDocumentBucket(storageBucket: string | null | undefined): string {
  return storageBucket ?? sharedBucketName
}

/**
 * ## Enumerating an organization's buckets: read the ledger, never recompute
 *
 * There used to be a `bucketsForOrganization(orgId)` here that returned
 * `[shared, tenantBucketName(orgId)]`, for "usage reconciliation and any future
 * organization-level erasure". It is gone, and deleting it was the fix rather
 * than a side effect of one.
 *
 * It had no caller outside its own test, and it was a trap with a plausible
 * name. `tenantBucketName` depends on `SEAWEED_TENANT_BUCKET_PREFIX` and on the
 * hash width, so anything that recomputes the set silently stops returning the
 * bucket a tenant's objects are actually in the moment either changes — and it
 * reports success while doing so, because a sweep over a bucket that does not
 * exist looks exactly like a sweep over an empty one.
 *
 * The ledger is the only correct enumeration, and it already exists:
 *
 *     SELECT DISTINCT storage_bucket FROM documents WHERE organization_id = $1
 *
 * That is what `purger/purge-project.js` reads, and it is right for the reason
 * this function was wrong: it finds buckets written under a previous prefix, and
 * it cannot disagree with the code that did the writing. The restore procedure in
 * `docs/deployment/kubernetes.md` derives its bucket list the same way.
 *
 * Anything that needs to visit every bucket an organization has ever used should
 * query the ledger, not this module.
 */

/**
 * In-process memo of buckets known to exist.
 *
 * Purely a round-trip saver — `ensureTenantBucket` is correct without it, and
 * an empty cache after a restart costs one HeadBucket. It is a Set of names
 * rather than of org ids so that a prefix change invalidates it for free.
 */
const known = new Set<string>()

/** Reset the memo. Tests only. */
export function __resetBucketCache(): void {
  known.clear()
}

/**
 * Object at the root of every tenant bucket naming the organization that owns it.
 *
 * This is what turns the bucket boundary from ASSUMED into VERIFIED. The bucket
 * name is a slug plus a truncated hash, so no hash width makes the mapping
 * provably injective, and a shared SeaweedFS makes name reuse possible for
 * reasons that have nothing to do with hashing. Without a marker, either case
 * ends with two organizations reading and writing one bucket and nothing
 * anywhere saying so.
 *
 * Leading dot so it sorts and reads as metadata, and so a prefix sweep over
 * `org/<id>/…` never touches it.
 */
const OWNER_MARKER_KEY = '.grid-bucket-owner'

/**
 * Make sure the organization's bucket exists AND belongs to it, then return it.
 *
 * Idempotent, and safe to race: two uploads for a new organization can both miss
 * the cache, both HeadBucket 404, and both CreateBucket — the loser gets
 * `BucketAlreadyExists` / `BucketAlreadyOwnedByYou`, which is success.
 *
 * ## The four states, and why each behaves as it does
 *
 * 1. **Absent** — create it, then write the marker. In that order: a marker in a
 *    bucket that does not exist is not a thing, and a bucket without a marker is
 *    recoverable (state 4).
 * 2. **Present, marker names this organization** — the ordinary path.
 * 3. **Present, marker names a DIFFERENT organization** — refuse, loudly. This is
 *    the case the marker exists for: a hash collision, or two deployments
 *    sharing one SeaweedFS with the same tenant prefix. Writing here would mix
 *    two tenants' documents in one container, and reading would serve one
 *    tenant's bytes to the other. Failing the upload is the only safe answer,
 *    and it is a failure an operator can actually diagnose.
 * 4. **Present, no marker** — claim it only if it is EMPTY. An empty bucket
 *    cannot be holding another tenant's data, so claiming it is safe, and this
 *    is exactly the state left behind when a previous attempt created the bucket
 *    and failed before writing the marker. A NON-empty unmarked bucket is
 *    refused: it holds objects this deployment cannot account for.
 *
 * `client` is the bucket-lifecycle credential, NOT the one the request path uses
 * for objects. SeaweedFS's `Admin:<bucket>` authorises CreateBucket and
 * DeleteBucket together — it cannot express one without the other — so the only
 * way to keep DeleteBucket off the ordinary object path is to keep it on a
 * different credential (see `deploy/pulumi/src/data/seaweedfs-identities.ts`).
 * That credential does still live in this process; ADR-0043 records the residual
 * risk rather than claiming otherwise.
 */
export async function ensureTenantBucket(
  client: S3Client,
  organizationId: string,
): Promise<string> {
  const bucket = bucketForWrite(organizationId)
  // The shared bucket is created by the deployment, not at runtime, and is
  // deliberately unmarked — it belongs to every organization.
  if (bucket === sharedBucketName || known.has(bucket)) return bucket

  let exists = true
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }))
  } catch (error) {
    if (!isNotFound(error)) throw error
    exists = false
  }

  if (!exists) {
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }))
    } catch (error) {
      // Lost the race to a concurrent upload for the same new organization. The
      // bucket exists, so fall through and verify the marker like any other
      // existing bucket — the winner may not have written it yet.
      if (!isAlreadyExists(error)) throw error
      exists = true
    }
  }

  await assertBucketOwnership(client, bucket, organizationId, { created: !exists })
  known.add(bucket)
  return bucket
}

/**
 * Verify — or, where it is safe, establish — the bucket's ownership marker.
 *
 * `created` says this call just made the bucket, which means the marker is
 * expected to be absent and writing it is the completion of provisioning rather
 * than a claim over something pre-existing.
 */
async function assertBucketOwnership(
  client: S3Client,
  bucket: string,
  organizationId: string,
  { created }: { created: boolean },
): Promise<void> {
  const owner = created ? null : await readOwnerMarker(client, bucket)

  if (owner === organizationId) return

  if (owner !== null) {
    throw new Error(
      `Bucket "${bucket}" is marked as belonging to organization "${owner}", not ` +
        `"${organizationId}". Refusing to write: this is either a bucket-name collision or ` +
        'two deployments sharing one object store with the same tenant prefix. Change ' +
        'SEAWEED_TENANT_BUCKET_PREFIX for one of them, or migrate the objects.',
    )
  }

  // No marker. Safe to claim only when nothing is stored yet — see state 4.
  if (!created && !(await isBucketEmpty(client, bucket))) {
    throw new Error(
      `Bucket "${bucket}" already holds objects but carries no ownership marker. Refusing to ` +
        `write on behalf of organization "${organizationId}": the existing objects cannot be ` +
        'attributed. Inspect the bucket and either remove it or add ' +
        `"${OWNER_MARKER_KEY}" naming its owner.`,
    )
  }

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: OWNER_MARKER_KEY,
      Body: organizationId,
      ContentType: 'text/plain',
    }),
  )
}

/** The organization named by the bucket's marker, or null when there is none. */
async function readOwnerMarker(client: S3Client, bucket: string): Promise<string | null> {
  try {
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: OWNER_MARKER_KEY }),
    )
    // A zero-byte marker, or a response the SDK gave no body, is
    // indistinguishable from no marker for every decision that follows — and
    // treating it as "unowned" is the safe reading, because the empty-bucket path
    // can then repair it while a non-empty bucket is still refused.
    const body = await response?.Body?.transformToString()
    return body?.trim() || null
  } catch (error) {
    if (isNoSuchKey(error)) return null
    throw error
  }
}

/** Does the bucket hold anything other than the marker? */
async function isBucketEmpty(client: S3Client, bucket: string): Promise<boolean> {
  const listed = await client.send(
    // MaxKeys 2, not 1: the marker itself may be the single key returned, and
    // "holds only its own marker" is empty for this decision.
    new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 2 }),
  )
  const keys = (listed?.Contents ?? []).map((object) => object.Key)
  return keys.filter((key) => key !== OWNER_MARKER_KEY).length === 0
}

/**
 * Does this error mean "no such bucket"?
 *
 * HeadBucket carries no response body, so the SDK cannot give it a modelled
 * error name — it surfaces as a bare `NotFound` or as the HTTP status alone.
 * Both are checked, because which one you get depends on the SDK version.
 */
function isNotFound(error: unknown): boolean {
  if (error instanceof S3ServiceException) {
    if (error.name === 'NotFound' || error.name === 'NoSuchBucket') return true
    return error.$metadata?.httpStatusCode === 404
  }
  return false
}

function isAlreadyExists(error: unknown): boolean {
  return (
    error instanceof S3ServiceException &&
    (error.name === 'BucketAlreadyExists' || error.name === 'BucketAlreadyOwnedByYou')
  )
}

/**
 * Does this error mean the marker object is absent?
 *
 * Narrow on purpose, and narrower than {@link isNotFound}: a missing marker sends
 * this function down the "claim it if empty" path, so treating an AccessDenied or
 * a misrouted endpoint's bare 404 as "no marker" would overwrite the ownership
 * record of a bucket this deployment could not actually read.
 */
function isNoSuchKey(error: unknown): boolean {
  return error instanceof S3ServiceException && error.name === 'NoSuchKey'
}
