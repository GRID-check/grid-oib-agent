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
 * every bucket carries an ownership claim that is verified before it is used, so
 * a collision (or two deployments sharing one SeaweedFS) fails closed and loudly
 * instead of silently sharing a tenant's objects.
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
 *    {@link HASH_CHARS}); the ownership claim in {@link ensureTenantBucket}
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
 * Where a tenant bucket records who owns it.
 *
 * This is what turns the bucket boundary from ASSUMED into VERIFIED. The bucket
 * name is a slug plus a truncated hash, so no hash width makes the mapping
 * provably injective, and a shared SeaweedFS makes name reuse possible for
 * reasons that have nothing to do with hashing. Without a marker, either case
 * ends with two organizations reading and writing one bucket and nothing
 * anywhere saying so.
 *
 * ## Why this is a PREFIX and not one object
 *
 * The first version of this was a single mutable key holding the owner's id. It
 * detected nothing in the case it was written for. Two organizations resolving to
 * one bucket both find it absent, both `PutObject` the marker with their own id,
 * and last-write-wins: the marker ends up naming one of them, and the other has
 * already read its own value back and cached the bucket as its own. Two tenants
 * then share a container, with a marker that says the boundary was verified. A
 * re-read after writing narrows the window but cannot close it — interleave the
 * two puts and reads and both parties still see themselves.
 *
 * A mutual-exclusion answer does not fit either. The obvious one, an advisory
 * lock in Postgres (as `insertDocumentWithinQuota` uses), serialises this
 * deployment against itself and does nothing about the other half of the threat:
 * two deployments sharing one SeaweedFS have two different databases. The other,
 * a conditional `PutObject` with `If-None-Match: *`, would be exactly right if
 * the store honoured it — and SeaweedFS 3.80 does not reject a PUT on a
 * conditional header it does not implement, so the fix would silently be a no-op
 * against the only store we run.
 *
 * So the claim is made unforgeable instead of exclusive: each organization writes
 * its OWN key, `<prefix><sha256(orgId)>`, whose body is its id. Nothing ever
 * overwrites anything, because no two organizations address the same key, and a
 * repeat claim by the same organization writes the identical bytes. The invariant
 * moves from "the marker names me" to "there is exactly one claim, and it is
 * mine" — which is a LIST, and which both parties to a race evaluate the same way
 * whatever the interleaving, because neither can erase the other's evidence.
 *
 * The consequence is deliberate: a collision quarantines the bucket for BOTH
 * organizations rather than handing it to whoever raced faster. Neither has a
 * better claim, and only an operator can decide (change the tenant prefix, or
 * migrate the objects). See {@link assertBucketOwnership}.
 *
 * Leading dot so it sorts and reads as metadata, and so a prefix sweep over
 * `org/<id>/…` never touches it. The trailing slash matters: it keeps the claims
 * in their own namespace, and it is why a claim can never collide with the flat
 * key this replaced.
 */
const OWNER_CLAIM_PREFIX = '.grid-bucket-owner/'

/** The key one organization claims a bucket with. Deterministic, and its own. */
function ownerClaimKey(organizationId: string): string {
  return `${OWNER_CLAIM_PREFIX}${createHash('sha256').update(organizationId).digest('hex')}`
}

/**
 * Make sure the organization's bucket exists AND belongs to it, then return it.
 *
 * Idempotent, and safe to race: two uploads for a new organization can both miss
 * the cache, both HeadBucket 404, and both CreateBucket — the loser gets
 * `BucketAlreadyExists` / `BucketAlreadyOwnedByYou`, which is success.
 *
 * ## The four states, and why each behaves as it does
 *
 * 1. **Absent** — create it, then claim it. In that order: a claim in a bucket
 *    that does not exist is not a thing, and a bucket without a claim is
 *    recoverable (state 4).
 * 2. **Present, claimed by this organization** — the ordinary path. Re-claiming
 *    writes the same key with the same body, so it is a no-op with a round trip.
 * 3. **Present, claimed by a DIFFERENT organization** — refuse, loudly, for both
 *    parties. This is the case the marker exists for: a hash collision, or two
 *    deployments sharing one SeaweedFS with the same tenant prefix. Writing here
 *    would mix two tenants' documents in one container, and reading would serve
 *    one tenant's bytes to the other. Failing the upload is the only safe answer,
 *    and it is a failure an operator can actually diagnose.
 * 4. **Present, unclaimed** — claim it if it is EMPTY. An empty bucket cannot be
 *    holding another tenant's data, and this is exactly the state left behind when
 *    a previous attempt created the bucket and died before claiming it. A
 *    NON-empty unclaimed bucket is refused: it holds objects this deployment
 *    cannot account for.
 *
 * State 3 is reached by a LIST rather than by reading one mutable object, which is
 * what makes it hold under concurrency — see {@link OWNER_CLAIM_PREFIX} for the
 * race that a single marker could not detect.
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
      // bucket exists, so fall through and verify ownership like any other
      // existing bucket — the winner may not have claimed it yet.
      if (!isAlreadyExists(error)) throw error
      exists = true
    }
  }

  await assertBucketOwnership(client, bucket, organizationId, { created: !exists })
  known.add(bucket)
  return bucket
}

/**
 * Establish — or, when it is already there, simply confirm — this organization's
 * sole claim on the bucket.
 *
 * Two paths, and the interesting one is the second.
 *
 * **Already claimed by us.** One LIST, no write, done. This is what every upload
 * after the first sees on a cold cache, so it is the cost that matters.
 *
 * **Not yet claimed.** Write our claim, and only THEN judge the result. That order
 * is the opposite of what reads naturally and it is the whole point: writing our
 * own key cannot damage anyone (see {@link OWNER_CLAIM_PREFIX}), and doing it
 * before the deciding LIST is what guarantees a racing claimant's list contains
 * ours. Two parties therefore cannot both come away believing they verified sole
 * ownership — for both to succeed, each one's LIST would have to precede the
 * other's PUT, and each one's own PUT precedes its own LIST, which closes the
 * cycle: `A.put < A.list < B.put < B.list < A.put`. At most one proceeds, and if
 * the timing is unlucky, neither does. Both are safe; a shared container is not.
 *
 * `created` says this call just made the bucket, so it can hold neither a claim
 * nor a stranger's objects and both checks are skipped — round trips, not
 * semantics.
 */
async function assertBucketOwnership(
  client: S3Client,
  bucket: string,
  organizationId: string,
  { created }: { created: boolean },
): Promise<void> {
  const ours = ownerClaimKey(organizationId)

  if (!created) {
    const existing = await listOwnerClaims(client, bucket)
    // Conclusive at MaxKeys 2: a second claim would have come back in the same
    // page, so one claim means one claim.
    if (existing.length === 1 && existing[0] === ours) return
    const foreign = existing.find((key) => key !== ours)
    if (foreign !== undefined) await refuseForeignClaim(client, bucket, organizationId, foreign)

    // Unclaimed. Checked before anything is written: objects nobody can attribute
    // are what this marker exists to keep us away from, and leaving our claim in
    // such a bucket would make the next attempt think they were accounted for.
    await assertNotOccupiedByStrangers(client, bucket, organizationId)
  }

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: ours,
      Body: organizationId,
      ContentType: 'text/plain',
    }),
  )

  const foreign = (await listOwnerClaims(client, bucket)).find((key) => key !== ours)
  if (foreign !== undefined) await refuseForeignClaim(client, bucket, organizationId, foreign)
}

/**
 * Refuse the bucket to BOTH organizations, naming them.
 *
 * Deliberately symmetric: whoever raced faster does not thereby acquire a better
 * title to the container, and the objects already in it (if any) belong to
 * whichever tenant wrote them. Only an operator can resolve that, so the message
 * carries what they need to do it.
 */
async function refuseForeignClaim(
  client: S3Client,
  bucket: string,
  organizationId: string,
  foreignKey: string,
): Promise<never> {
  const other = await readClaimOwner(client, bucket, foreignKey)
  throw new Error(
    `Bucket "${bucket}" is already claimed by organization "${other ?? 'unknown'}", so it ` +
      `cannot also hold organization "${organizationId}". Refusing to write, for BOTH ` +
      'organizations: this is either a bucket-name collision or two deployments sharing one ' +
      'object store with the same tenant prefix, and neither party has the better claim. ' +
      'Change SEAWEED_TENANT_BUCKET_PREFIX for one deployment, or migrate the objects and ' +
      `remove the stale key under "${OWNER_CLAIM_PREFIX}".`,
  )
}

/**
 * Refuse a pre-existing bucket that holds objects nobody has claimed.
 *
 * Split out from the claim so the two failure modes stay distinct: this one is
 * "objects here are not accounted for", the other is "two organizations want the
 * same container". An unclaimed EMPTY bucket is fine to claim — that is precisely
 * the state a provision that died between CreateBucket and the claim leaves
 * behind, and repairing it is why the emptiness test exists at all.
 *
 * The claim check is repeated here rather than trusted from the caller, because
 * this is a fresh listing: a racing claimant may have appeared in between, and if
 * it did, this is not the failure to report — the deciding LIST after our own
 * claim will report the conflict instead, with both organizations named.
 */
async function assertNotOccupiedByStrangers(
  client: S3Client,
  bucket: string,
  organizationId: string,
): Promise<void> {
  const listed = await client.send(
    // Three keys: enough to see a claim, a stranger's object, and that there is
    // more than one of them. A full listing would be a paginated sweep of a
    // tenant's whole bucket on every cold upload.
    new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 3 }),
  )
  const keys = (listed?.Contents ?? []).map((object) => object.Key ?? '')
  const claimed = keys.some((key) => key.startsWith(OWNER_CLAIM_PREFIX))
  const occupied = keys.some((key) => key !== '' && !key.startsWith(OWNER_CLAIM_PREFIX))

  if (!claimed && occupied) {
    throw new Error(
      `Bucket "${bucket}" already holds objects but carries no ownership claim. Refusing to ` +
        `write on behalf of organization "${organizationId}": the existing objects cannot be ` +
        `attributed. Inspect the bucket and either remove it or add a key under ` +
        `"${OWNER_CLAIM_PREFIX}" naming its owner.`,
    )
  }
}

/** Every ownership claim on the bucket. */
async function listOwnerClaims(client: S3Client, bucket: string): Promise<string[]> {
  const listed = await client.send(
    // MaxKeys 2 is all any decision needs: ours, plus evidence of one other.
    new ListObjectsV2Command({ Bucket: bucket, Prefix: OWNER_CLAIM_PREFIX, MaxKeys: 2 }),
  )
  return (listed?.Contents ?? []).map((object) => object.Key ?? '').filter((key) => key !== '')
}

/**
 * The organization named by one claim, for the error message.
 *
 * Best-effort on purpose: the claim key is a hash, so the id is only recoverable
 * from the body, and a claim we cannot read still proves the conflict. Returning
 * null downgrades the message, never the decision.
 */
async function readClaimOwner(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<string | null> {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    const body = await response?.Body?.transformToString()
    return body?.trim() || null
  } catch (error) {
    if (isNoSuchKey(error)) return null
    throw error
  }
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
 * Does this error mean the claim object is absent?
 *
 * Narrow on purpose, and narrower than {@link isNotFound}: this only ever softens
 * an ERROR MESSAGE (a conflicting claim that vanished between the list and the
 * read), never a decision. Treating an AccessDenied or a misrouted endpoint's bare
 * 404 as "gone" would hide a store this deployment cannot actually read.
 */
function isNoSuchKey(error: unknown): boolean {
  return error instanceof S3ServiceException && error.name === 'NoSuchKey'
}
