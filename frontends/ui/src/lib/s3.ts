import { S3Client } from "@aws-sdk/client-s3";

const credentials = {
  accessKeyId: process.env.MINIO_ACCESS_KEY || "",
  secretAccessKey: process.env.MINIO_SECRET_KEY || "",
};

/**
 * Client for SERVER-SIDE object operations (put/get/head) that run inside the
 * Docker network. Uses the internal endpoint (e.g. http://minio:9000).
 */
export const s3Client = new S3Client({
  endpoint: process.env.MINIO_ENDPOINT,
  region: "us-east-1",
  credentials,
  forcePathStyle: true,
});

/**
 * Client used ONLY to SIGN presigned URLs handed to the browser.
 *
 * A presigned URL bakes in the signing client's endpoint host. The browser
 * cannot resolve the Docker-internal `minio` hostname, so presigned URLs must
 * be signed against a browser-reachable endpoint (MINIO_PUBLIC_ENDPOINT, e.g.
 * http://localhost:9000 in dev or a public HTTPS endpoint in prod). Falls back
 * to MINIO_ENDPOINT when no public endpoint is configured (single-host setups).
 *
 * This is the fix for broken PDF preview/download: both were signed with the
 * internal endpoint and produced URLs the browser could never fetch.
 */
export const signingS3Client = new S3Client({
  endpoint: process.env.MINIO_PUBLIC_ENDPOINT || process.env.MINIO_ENDPOINT,
  region: "us-east-1",
  credentials,
  forcePathStyle: true,
});

export const bucketName = process.env.MINIO_BUCKET || "grid-documents";

export function buildMinioKey(
  organizationId: string,
  projectId: string,
  documentId: string,
  filename: string,
  folderPath?: string | null,
): string {
  const folder = folderPath ? `${folderPath}/` : ''
  return `org/${organizationId}/project/${projectId}/${folder}doc/${documentId}/${filename}`
}
