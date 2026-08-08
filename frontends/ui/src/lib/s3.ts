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

export function buildStorageKey(
  organizationId: string,
  projectId: string,
  documentId: string,
  filename: string,
  folderPath?: string | null,
): string {
  const folder = folderPath ? `${folderPath}/` : ''
  return `org/${organizationId}/project/${projectId}/${folder}doc/${documentId}/${filename}`
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
  return `org/${organizationId}/archiv/doc/${documentId}/${filename}`
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
 * A key with no `/` cannot have a filename segment to replace. Rather than
 * fabricate a bucket-root `_thumb.jpg` — a real write target — it returns null
 * and the callers treat that as "no thumbnail". Unreachable from
 * `buildStorageKey` output; reachable from a hand-edited or legacy row.
 */
export function buildThumbnailStorageKey(storageKey: string): string | null {
  const idx = storageKey.lastIndexOf('/')
  return idx > 0 ? `${storageKey.slice(0, idx)}/_thumb.jpg` : null
}
