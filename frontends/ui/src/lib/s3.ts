// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { S3Client } from "@aws-sdk/client-s3";

export const s3Client = new S3Client({
  endpoint: process.env.MINIO_ENDPOINT,
  region: "us-east-1",
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY || "",
    secretAccessKey: process.env.MINIO_SECRET_KEY || "",
  },
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
