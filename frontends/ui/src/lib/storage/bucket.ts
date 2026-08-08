import {
  CreateBucketCommand,
  HeadBucketCommand,
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
 * 12 hex = 48 bits. At 100,000 organizations the birthday bound puts a
 * collision at roughly 1 in 30,000 — and a collision here is not a cosmetic
 * problem, it is cross-tenant data access, so the number is chosen with that in
 * mind rather than for tidiness. 8 hex (32 bits) would be about even odds at
 * the same scale, which is why it is not 8.
 */
const HASH_CHARS = 12

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
 * 2. **Injective.** Two organizations must never collide, or one tenant reads
 *    another's documents. Slugging into the S3 alphabet is lossy (`Org_1` and
 *    `org-1` both reduce to `org-1`), so a truncated SHA-256 of the ORIGINAL id
 *    is appended unconditionally — unconditionally rather than only when the
 *    slug is lossy, because "is this id lossy?" is one more thing to get wrong
 *    and 12 hex characters cost nothing.
 * 3. **Recognisable.** An operator looking at `grid-org-org-01h8…-3f9a12c4b7e0`
 *    can see which tenant it belongs to, which a bare hash would not give them.
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
 * Every bucket an organization's objects could be in, for operations that must
 * not miss any — usage reconciliation, and any future organization-level
 * erasure.
 *
 * Both, ALWAYS, and deliberately not gated on the feature flag. Three states
 * have to be correct and only one of them is "the flag is on": before it the
 * tenant bucket does not exist, and a sweep over a bucket that does not exist
 * is a no-op because it holds no objects; during, objects are in both; after it
 * is turned off again, objects are STILL in both — and that is the state where
 * gating would skip the tenant bucket and report success.
 *
 * Note what does NOT use this: the deletion pipeline. `purge-project.js` reads
 * the buckets its documents actually recorded, which is both more complete
 * (it finds buckets written under a previous prefix) and impossible to get
 * wrong by disagreeing with this function.
 */
export function bucketsForOrganization(organizationId: string): string[] {
  return [sharedBucketName, tenantBucketName(organizationId)]
}

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
 * Make sure the organization's bucket exists, and return it.
 *
 * Idempotent, and safe to race: two uploads for a new organization can both
 * miss the cache, both HeadBucket 404, and both CreateBucket — the loser gets
 * `BucketAlreadyExists` / `BucketAlreadyOwnedByYou`, which is success.
 *
 * `client` is the bucket-lifecycle credential, NOT the one the request path
 * uses for objects. SeaweedFS's `Admin:<bucket>` authorises CreateBucket and
 * DeleteBucket together — it cannot express one without the other — so the only
 * way to keep DeleteBucket off the upload path is to keep it on a different
 * credential (see `deploy/pulumi/src/data/seaweedfs-identities.ts`).
 */
export async function ensureTenantBucket(
  client: S3Client,
  organizationId: string,
): Promise<string> {
  const bucket = bucketForWrite(organizationId)
  // The shared bucket is created by the deployment, not at runtime.
  if (bucket === sharedBucketName || known.has(bucket)) return bucket

  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }))
    known.add(bucket)
    return bucket
  } catch (error) {
    if (!isNotFound(error)) throw error
  }

  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }))
  } catch (error) {
    // Lost the race. The bucket exists, which is all this function promised.
    if (!isAlreadyExists(error)) throw error
  }
  known.add(bucket)
  return bucket
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
