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
});

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
