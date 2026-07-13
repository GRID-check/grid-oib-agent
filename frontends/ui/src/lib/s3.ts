import { S3Client } from "@aws-sdk/client-s3";

// New vendor-neutral S3_* config with a fallback to the legacy MINIO_* names so
// existing deployments keep working until their env is migrated.
const credentials = {
  accessKeyId: (process.env.S3_ACCESS_KEY ?? process.env.MINIO_ACCESS_KEY) || "",
  secretAccessKey: (process.env.S3_SECRET_KEY ?? process.env.MINIO_SECRET_KEY) || "",
};

/**
 * Client for SERVER-SIDE object operations (put/get/head) that run inside the
 * Docker network. Uses the internal endpoint (e.g. http://object-store:9000).
 */
export const s3Client = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? process.env.MINIO_ENDPOINT,
  region: "us-east-1",
  credentials,
  forcePathStyle: true,
});

/**
 * Client used ONLY to SIGN presigned URLs handed to the browser.
 *
 * A presigned URL bakes in the signing client's endpoint host. The browser
 * cannot resolve the Docker-internal `object-store` hostname, so presigned URLs
 * must be signed against a browser-reachable endpoint (S3_PUBLIC_ENDPOINT, e.g.
 * http://localhost:9000 in dev or a public HTTPS endpoint in prod). Falls back
 * to S3_ENDPOINT when no public endpoint is configured (single-host setups).
 * Legacy MINIO_* names are honored as a fallback for un-migrated configs.
 *
 * This is the fix for broken PDF preview/download: both were signed with the
 * internal endpoint and produced URLs the browser could never fetch.
 */
export const signingS3Client = new S3Client({
  endpoint:
    process.env.S3_PUBLIC_ENDPOINT ??
    process.env.MINIO_PUBLIC_ENDPOINT ??
    process.env.S3_ENDPOINT ??
    process.env.MINIO_ENDPOINT,
  region: "us-east-1",
  credentials,
  forcePathStyle: true,
});

export const bucketName =
  (process.env.S3_BUCKET ?? process.env.MINIO_BUCKET) || "grid-documents";

export function buildObjectKey(
  organizationId: string,
  projectId: string,
  documentId: string,
  filename: string,
  folderPath?: string | null,
): string {
  const folder = folderPath ? `${folderPath}/` : ''
  return `org/${organizationId}/project/${projectId}/${folder}doc/${documentId}/${filename}`
}
