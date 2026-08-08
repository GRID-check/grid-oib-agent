/**
 * How an organization id becomes an S3 bucket name (ADR-0043).
 *
 * ## Why this file is CommonJS
 *
 * Same reason as `@/lib/limits/rules.js`: the purger is plain CommonJS
 * (`node purger/index.js`) and cannot import TypeScript, but it must derive the
 * exact same bucket name the BFF wrote to — it is the process that ERASES a
 * tenant, and a naming disagreement there means the delete sweeps a bucket that
 * does not exist and reports success. So the algorithm lives here, where both
 * can load it, and `./bucket.ts` is its typed face.
 *
 * ## The four properties, and why each one is load-bearing
 *
 * 1. **Deterministic.** No lookup table, no state. A bucket name must be
 *    derivable from an org id alone, because the purger has to reconstruct it
 *    after the rows that recorded it are gone.
 *
 * 2. **Injective.** Two organizations must never collide, or one tenant reads
 *    another's documents — the failure this whole change exists to prevent.
 *    Sanitising an id into the S3 alphabet is inherently lossy (`Org_1` and
 *    `org-1` both slug to `org-1`), so a truncated SHA-256 of the ORIGINAL id
 *    is appended unconditionally. Unconditionally, rather than only when the
 *    slug is lossy, because "is this id lossy?" is one more thing to get wrong
 *    and the 12 hex chars cost nothing.
 *
 * 3. **A legal S3 bucket name.** 3–63 characters, lowercase letters, digits and
 *    hyphens, first and last character alphanumeric, never formatted as an IP
 *    address. `assertValidBucketName` enforces this rather than trusting the
 *    construction, because the input is an external identifier.
 *
 * 4. **Recognisable.** An operator looking at `grid-org-org-01h8…-3f9a12c4b7e0`
 *    can see which tenant it belongs to. That is worth the extra characters:
 *    the alternative — a bare hash — makes every incident start with a lookup.
 *
 * ## Why the object KEY layout does not change
 *
 * Keys stay `org/<orgId>/project/<projectId>/…` even inside a per-org bucket,
 * where the leading segment is redundant. Two reasons: an object stays valid
 * under either layout, so moving between them is a bucket copy rather than a
 * rewrite; and the purger's prefix sweep, the thumbnail-sibling rule and every
 * existing test keep working unchanged. Only the bucket moves.
 */

const { createHash } = require('node:crypto')

/** Default prefix. Mirrored by `seaweedfsTenantBucketPrefix` in the Pulumi config. */
const DEFAULT_TENANT_BUCKET_PREFIX = 'grid-org-'

/**
 * Hex characters of SHA-256 kept as the uniqueness suffix.
 *
 * 12 hex = 48 bits. At 100,000 organizations the birthday bound puts a
 * collision at roughly 1 in 30,000 — and a collision is not a cosmetic problem
 * here, it is cross-tenant data access, so the number is chosen with that in
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
function slugify(organizationId) {
  return String(organizationId)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Throw unless `name` is a legal S3 bucket name.
 *
 * Called on the way out of `tenantBucketName`, on a value this module just
 * built. That is not redundant: the input is an organization id from an
 * external identity provider, so the only thing standing between a malformed
 * id and a bucket name is this function. Failing loudly at the call site beats
 * a CreateBucket that returns InvalidBucketName three layers down.
 */
function assertValidBucketName(name) {
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
  // time for one specific tenant, with an InvalidBucketName three layers down.
  // `xn--` is reachable through a configured prefix; `-s3alias` is not, because
  // every name ends in hex — checked anyway, since the suffix rule is the
  // cheaper half of matching a validator we do not control.
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
 * @param {string} organizationId
 * @param {string} [prefix] defaults to `grid-org-`
 * @returns {string}
 */
function tenantBucketName(organizationId, prefix = DEFAULT_TENANT_BUCKET_PREFIX) {
  if (!organizationId) {
    throw new Error('tenantBucketName requires a non-empty organization id.')
  }
  const hash = createHash('sha256').update(String(organizationId)).digest('hex').slice(0, HASH_CHARS)

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
  const name = slug ? `${prefix}${slug}-${hash}` : `${prefix}${hash}`
  return assertValidBucketName(name)
}

/**
 * Every bucket an organization's objects can be in, for operations that must
 * not miss any: tenant erasure, and usage reconciliation.
 *
 * Both, ALWAYS — deliberately not gated on whether per-organization buckets are
 * currently enabled. Three states have to work, and only one of them is "the
 * flag is on":
 *
 *   - flag never on  → the tenant bucket does not exist, and listing a bucket
 *     that does not exist is a no-op (`deleteStoragePrefix` treats NoSuchBucket
 *     as zero objects, which is what it is);
 *   - flag on        → objects in both, because an organization that predates
 *     the flip kept everything it already had;
 *   - flag turned OFF again → objects STILL in both, and this is the case that
 *     makes gating dangerous. A sweep that consulted the flag would skip the
 *     tenant bucket and report success, deleting the rows that name the objects
 *     while the objects remain. For an erasure request that is not a bug that
 *     surfaces later; it is the failure, silently.
 *
 * @param {string} organizationId
 * @param {string} sharedBucket the deployment's shared bucket
 * @param {string} [prefix]
 * @returns {string[]}
 */
function bucketsForOrganization(organizationId, sharedBucket, prefix = DEFAULT_TENANT_BUCKET_PREFIX) {
  return [sharedBucket, tenantBucketName(organizationId, prefix)]
}

module.exports = {
  DEFAULT_TENANT_BUCKET_PREFIX,
  bucketsForOrganization,
  HASH_CHARS,
  MAX_BUCKET_NAME,
  assertValidBucketName,
  slugify,
  tenantBucketName,
}
