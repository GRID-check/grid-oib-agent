import { S3Client } from "@aws-sdk/client-s3";

const credentials = {
  accessKeyId: process.env.SEAWEED_ACCESS_KEY || "",
  secretAccessKey: process.env.SEAWEED_SECRET_KEY || "",
};

/**
 * Client for SERVER-SIDE object operations (put/get/head) that run inside the
 * Docker network. Uses the internal endpoint (e.g. http://seaweedfs:8333).
 */
export const s3Client = new S3Client({
  endpoint: process.env.SEAWEED_ENDPOINT,
  region: "us-east-1",
  credentials,
  forcePathStyle: true,
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

/**
 * Client used ONLY to SIGN presigned URLs handed to the browser.
 *
 * A presigned URL bakes in the signing client's endpoint host. The browser
 * cannot resolve the Docker-internal `seaweedfs` hostname, so presigned URLs
 * must be signed against a browser-reachable endpoint (SEAWEED_PUBLIC_ENDPOINT,
 * e.g. http://localhost:8333 in dev or a public HTTPS endpoint in prod). Falls
 * back to SEAWEED_ENDPOINT when no public endpoint is configured (single-host
 * setups).
 *
 * This is the fix for broken PDF preview/download: both were signed with the
 * internal endpoint and produced URLs the browser could never fetch.
 */
export const signingS3Client = new S3Client({
  endpoint: process.env.SEAWEED_PUBLIC_ENDPOINT || process.env.SEAWEED_ENDPOINT,
  region: "us-east-1",
  credentials,
  forcePathStyle: true,
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

/**
 * Client used ONLY to create a tenant bucket (ADR-0043).
 *
 * A second credential, not a second client on the same one, and the reason is
 * a limitation of SeaweedFS's IAM rather than belt-and-braces: bucket lifecycle
 * is a single `Admin:<bucket>` action that authorises CreateBucket and
 * DeleteBucket together. There is no way to grant one without the other. So the
 * only way to keep "drop a tenant's entire bucket" out of reach of the upload
 * path is to keep it on a credential the upload path does not hold — this one,
 * scoped `Admin:<tenantPrefix>*` and nothing else. It cannot touch
 * `grid-documents` and it cannot touch `grid-pg-backups`.
 *
 * Falls back to the ordinary credential when unset, which is what a deployment
 * with per-org buckets turned off has: nothing calls it there.
 */
export const bucketAdminS3Client = new S3Client({
  endpoint: process.env.SEAWEED_ENDPOINT,
  region: "us-east-1",
  credentials: {
    accessKeyId: process.env.SEAWEED_TENANT_ADMIN_ACCESS_KEY || credentials.accessKeyId,
    secretAccessKey: process.env.SEAWEED_TENANT_ADMIN_SECRET_KEY || credentials.secretAccessKey,
  },
  forcePathStyle: true,
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

/**
 * The bucket every object lived in before ADR-0043, and still the default.
 *
 * Per-organization buckets are resolved through `@/lib/storage/bucket` — this
 * constant is the one a NULL `documents.storage_bucket` means, so its value is
 * a compatibility contract, not just a default.
 */
export const bucketName = process.env.SEAWEED_BUCKET || "grid-documents";

/**
 * One safe segment of an object key, from a name a person chose.
 *
 * The upload's own filename and the folder names above it are the only parts
 * of a key that are not machine-generated ids, and both went in verbatim. A
 * part named
 * `../../../../org/<other-org>/project/<p>/doc/<d>/model.ifc` passes the
 * upload-type check — that only looks at the substring after the last dot —
 * and lands in `Key` unchanged. Per-org buckets are off by default, so the
 * `org/<id>/` prefix is the ONLY separation between tenants in the shared
 * bucket, and the key is persisted and reused afterwards: on read, on the
 * derived-key builder, and on the recursive prefix delete in
 * `lib/bim/service.ts`, which lists and deletes everything under whatever
 * prefix the traversed key implies. On a filer-backed gateway that resolves
 * `..` — SeaweedFS stores keys as filer paths — that is a cross-tenant write
 * and a cross-tenant delete.
 *
 * Separators are flattened rather than rejected because a name is not a
 * mistake the uploader can necessarily see, and a file called `A/B.ifc` should
 * store, not fail. A segment of nothing but dots is `.` or `..` itself, which
 * has no flattening to do and is prefixed instead.
 */
export function storageKeySegment(raw: string): string {
  const flattened = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[/\\]/g, '_')
  const guarded = /^\.+$/.test(flattened) ? `_${flattened}` : flattened
  return guarded.trim().slice(0, 255).trim() || 'unnamed'
}

export function buildStorageKey(
  organizationId: string,
  projectId: string,
  documentId: string,
  filename: string,
  folderPath?: string | null,
): string {
  // The folder path arrives already joined, and each name in it is as
  // person-chosen as the filename — so it is sanitized per segment rather than
  // as one string, which would flatten the separators the path needs.
  const folder = folderPath
    ? `${folderPath.split('/').filter(Boolean).map(storageKeySegment).join('/')}/`
    : ''
  return `org/${organizationId}/project/${projectId}/${folder}doc/${documentId}/${storageKeySegment(filename)}`
}

/**
 * Storage key for an org-wide Archiv document. Mirrors {@link buildStorageKey}
 * but scopes under the organization instead of a project (Archiv documents
 * belong to the org, not any single project) — so the same bucket layout
 * convention holds.
 */
export function buildArchivStorageKey(
  organizationId: string,
  documentId: string,
  filename: string,
): string {
  return `org/${organizationId}/archiv/doc/${documentId}/${storageKeySegment(filename)}`
}

/**
 * Storage key for a file attached privately to one chat (ADR-0047 Phase 2).
 *
 * Third sibling of the two above and the same shape for the same reason: the
 * key states the owner, so an object can be found from its prefix alone when a
 * row is missing, and a prefix sweep can erase exactly one owner's bytes.
 * `org/<org>/session/<conversationId>/doc/<documentId>/<filename>` — the
 * conversation segment is what makes discarding one chat a single prefix
 * delete rather than a per-row loop.
 *
 * The conversation id is passed through `storageKeySegment` like every other
 * user-influenced segment. Ids the app mints are already `s_<uuid>` and survive
 * it unchanged; sanitising anyway means a hand-crafted id cannot climb out of
 * the organization's prefix.
 */
export function buildSessionStorageKey(
  organizationId: string,
  conversationId: string,
  documentId: string,
  filename: string,
): string {
  return `org/${organizationId}/session/${storageKeySegment(conversationId)}/doc/${documentId}/${storageKeySegment(filename)}`
}

/**
 * The preview thumbnail that sits beside a document, replacing the filename
 * segment of its key with `_thumb.jpg`.
 *
 * Lives here with the other two builders rather than privately in
 * `documents/service.ts`, because both delete paths and both read paths need
 * it and the derivation had already been re-implemented — differently — in a
 * spec (`image-tenant-scope.spec.ts` used `${key}.thumb.jpg`, which production
 * has never produced). One definition, one place, one behaviour to test.
 *
 * A key with no filename segment to replace has no thumbnail, and there are two
 * such shapes, not one: no `/` at all, and a TRAILING `/`. Both used to be
 * handled differently — `a/b/` has its last slash at a positive index, so the
 * old check passed it and produced `a/b/_thumb.jpg`, a real write target derived
 * from a row that names no file. Rather than fabricate a key for a malformed
 * row, both return null and the callers treat that as "no thumbnail".
 * Unreachable from `buildStorageKey` output; reachable from a hand-edited or
 * legacy row.
 */
export function buildThumbnailStorageKey(storageKey: string): string | null {
  const idx = storageKey.lastIndexOf('/')
  if (idx <= 0 || idx === storageKey.length - 1) return null
  return `${storageKey.slice(0, idx)}/_thumb.jpg`
}
