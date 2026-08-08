import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3'
import { bucketName as sharedBucketName } from '@/lib/s3'
import * as naming from './tenant-bucket.js'

/**
 * Which bucket an organization's objects live in (ADR-0043), and how one gets
 * created.
 *
 * The naming algorithm itself is `./tenant-bucket.js` — CommonJS, because the
 * purger must derive the same name and cannot import TypeScript. This module is
 * its typed face plus the two things that need runtime state: reading the
 * deployment's configuration, and provisioning.
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
 * - **Erasure becomes atomic.** Deleting a tenant is `DeleteBucket`, not a
 *   paginated list-and-delete that can fail halfway and leave objects behind
 *   after the rows that pointed at them are gone. With SeaweedFS's `postgres2`
 *   filer store, that drop is a `DROP TABLE` on the metadata side too.
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

export const DEFAULT_TENANT_BUCKET_PREFIX: string = naming.DEFAULT_TENANT_BUCKET_PREFIX
export const assertValidBucketName: (name: string) => string = naming.assertValidBucketName

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

/** The bucket name for an organization, whether or not the flag is on. */
export function tenantBucketName(organizationId: string): string {
  return naming.tenantBucketName(organizationId, tenantPrefix())
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
 * not miss any — tenant erasure, usage reconciliation.
 *
 * Both, ALWAYS, and deliberately not gated on the feature flag: see the
 * three-state argument on `bucketsForOrganization` in `./tenant-bucket.js`. The
 * dangerous state is "the flag was on and has since been turned off", where a
 * gated sweep skips the tenant bucket and reports success.
 *
 * The purger — the process that actually erases a tenant — calls the CommonJS
 * function directly, because it cannot import TypeScript. This is the same
 * function, re-exported, so the two cannot disagree.
 */
export function bucketsForOrganization(organizationId: string): string[] {
  return naming.bucketsForOrganization(organizationId, sharedBucketName, tenantPrefix())
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
