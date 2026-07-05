> Note (2026-07-05): fastapi_extensions was removed on 2026-07-03; ingest now lives in frontends/aiq_api.

# Grid MVP Implementation Plan — Document Upload + MinIO

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move document upload ownership from the Python agent to the Next.js BFF: durable MinIO storage, server-authoritative collection naming, and a stateless Python `/v1/ingest` endpoint.

**Architecture:** Browser uploads to BFF route. BFF authorizes via `project_members`, writes original bytes to MinIO, inserts `grid_app.documents` row, generates presigned URL, and asks Python to fetch + embed. Python verifies JWT, downloads via presigned URL, embeds into BFF-assigned Chroma collection, returns status.

**Tech Stack:** MinIO, `@aws-sdk/client-s3` (Next.js), `boto3` (Python), Drizzle ORM, FastAPI, LlamaIndex ingestor.

---

## File structure

| File | Responsibility |
|---|---|
| `deploy/compose/docker-compose.yaml` | Add MinIO service. |
| `frontends/ui/.env.example` | MinIO env vars. |
| `frontends/ui/src/lib/s3.ts` | S3/MinIO client singleton. |
| `frontends/ui/src/lib/db/schema/documents.ts` | Drizzle `documents` schema. |
| `frontends/ui/src/app/api/documents/upload/route.ts` | BFF upload handler. |
| `frontends/ui/src/app/api/documents/[id]/status/route.ts` | BFF status handler. |
| `frontends/ui/src/features/documents/hooks/use-file-upload.ts` | New upload path. |
| `src/aiq_agent/fastapi_extensions/routes/ingest.py` | Python `/v1/ingest` endpoint. |
| `src/aiq_agent/knowledge/ingest_url.py` | URL-based ingestion adapter. |
| `tests/aiq_agent/knowledge/test_ingest_url.py` | Unit tests. |

---

### Task 1: Add MinIO to Docker Compose

**Files:**
- Modify: `deploy/compose/docker-compose.yaml`

- [ ] **Step 1: Add MinIO service**

```yaml
  minio:
    image: minio/minio:RELEASE.2024-06-29T01-20-47Z
    ports:
      - "9000:9000"
      - "9001:9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    command: server /data --console-address ":9001"
    volumes:
      - minio-data:/data
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  minio-data:
```

- [ ] **Step 2: Add env vars to frontend service**

```yaml
  frontend:
    environment:
      MINIO_ENDPOINT: http://minio:9000
      MINIO_ACCESS_KEY: minioadmin
      MINIO_SECRET_KEY: minioadmin
      MINIO_BUCKET: grid-documents
      MINIO_PRESIGNED_URL_TTL_SECONDS: "600"
```

- [ ] **Step 3: Commit**

```bash
git add deploy/compose/docker-compose.yaml
git commit -m "feat: add minio service to compose stack"
```

---

### Task 2: Document MinIO environment variables

**Files:**
- Modify: `frontends/ui/.env.example`

- [ ] **Step 1: Append MinIO variables**

```bash
cat >> frontends/ui/.env.example << 'EOF'

# MinIO / S3-compatible object storage
MINIO_ENDPOINT=http://localhost:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET=grid-documents
MINIO_PRESIGNED_URL_TTL_SECONDS=600
EOF
```

- [ ] **Step 2: Commit**

```bash
git add frontends/ui/.env.example
git commit -m "chore: document minio env variables"
```

---

### Task 3: Create S3/MinIO client

**Files:**
- Create: `frontends/ui/src/lib/s3.ts`

- [ ] **Step 1: Implement client**

```typescript
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
  filename: string
): string {
  return `org/${organizationId}/project/${projectId}/doc/${documentId}/${filename}`;
}
```

- [ ] **Step 2: Commit**

```bash
git add frontends/ui/src/lib/s3.ts
git commit -m "feat: add minio s3 client singleton"
```

---

### Task 4: Add `documents` Drizzle schema

**Files:**
- Create: `frontends/ui/src/lib/db/schema/documents.ts`

- [ ] **Step 1: Write schema**

```typescript
import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id").notNull(),
  projectId: uuid("project_id").notNull(),
  createdBy: text("created_by").notNull(),
  filename: text("filename").notNull(),
  minioKey: text("minio_key").notNull(),
  collectionName: text("collection_name").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  errorMessage: text("error_message"),
  metadata: jsonb("metadata"),
}, (table) => ({
  projectIdx: index("documents_project_idx").on(table.projectId),
  collectionIdx: index("documents_collection_idx").on(table.collectionName),
}));
```

- [ ] **Step 2: Commit**

```bash
git add frontends/ui/src/lib/db/schema/documents.ts
git commit -m "feat: add documents drizzle schema"
```

---

### Task 5: Implement BFF upload route

**Files:**
- Create: `frontends/ui/src/app/api/documents/upload/route.ts`

- [ ] **Step 1: Implement handler**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuidv4 } from "uuid";
import { requireAuthorizedSession } from "@/lib/auth/require-auth";
import { requireProjectAccess } from "@/lib/authz/projects";
import { s3Client, bucketName, buildMinioKey } from "@/lib/s3";
import { db } from "@/lib/db";
import { documents } from "@/lib/db/schema/documents";

export async function POST(request: NextRequest) {
  const session = await requireAuthorizedSession();
  const formData = await request.formData();
  const projectId = formData.get("projectId") as string;
  const file = formData.get("file") as File;

  if (!projectId || !file) {
    return NextResponse.json({ error: "projectId and file required" }, { status: 400 });
  }

  await requireProjectAccess(session, projectId);

  const documentId = uuidv4();
  const collectionName = `proj_${projectId}`;
  const minioKey = buildMinioKey(session.organizationId, projectId, documentId, file.name);

  const bytes = Buffer.from(await file.arrayBuffer());
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: minioKey,
      Body: bytes,
      ContentType: file.type || "application/octet-stream",
    })
  );

  await db.insert(documents).values({
    id: documentId,
    organizationId: session.organizationId,
    projectId,
    createdBy: session.userId,
    filename: file.name,
    minioKey,
    collectionName,
    status: "pending",
  });

  const presignedUrl = await getSignedUrl(
    s3Client,
    new GetObjectCommand({ Bucket: bucketName, Key: minioKey }),
    { expiresIn: Number(process.env.MINIO_PRESIGNED_URL_TTL_SECONDS || 600) }
  );

  const ingestRes = await fetch(`${process.env.BACKEND_URL}/v1/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.accessToken}`,
    },
    body: JSON.stringify({
      file_ref: presignedUrl,
      collection: collectionName,
      document_id: documentId,
    }),
  });

  if (!ingestRes.ok) {
    await db.update(documents).set({ status: "failed", errorMessage: "Ingest request failed" }).where(eq(documents.id, documentId));
    return NextResponse.json({ error: "Ingest failed" }, { status: 500 });
  }

  const ingestResult = await ingestRes.json();
  await db
    .update(documents)
    .set({ status: ingestResult.status === "embedded" ? "embedded" : "failed", errorMessage: ingestResult.error || null })
    .where(eq(documents.id, documentId));

  return NextResponse.json({ documentId, status: ingestResult.status });
}
```

- [ ] **Step 2: Add required imports**

Add `eq` import from `drizzle-orm` and `uuid` package if not present.

- [ ] **Step 3: Commit**

```bash
git add frontends/ui/src/app/api/documents/upload/route.ts
git commit -m "feat: implement bff document upload route"
```

---

### Task 6: Implement BFF status route

**Files:**
- Create: `frontends/ui/src/app/api/documents/[id]/status/route.ts`

- [ ] **Step 1: Implement handler**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireAuthorizedSession } from "@/lib/auth/require-auth";
import { db } from "@/lib/db";
import { documents } from "@/lib/db/schema/documents";

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireAuthorizedSession();
  const document = await db.query.documents.findFirst({
    where: eq(documents.id, params.id),
  });

  if (!document || document.organizationId !== session.organizationId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: document.id,
    status: document.status,
    filename: document.filename,
    errorMessage: document.errorMessage,
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add frontends/ui/src/app/api/documents/\[id\]/status/route.ts
git commit -m "feat: add document status bff route"
```

---

### Task 7: Create Python `/v1/ingest` endpoint

**Files:**
- Create: `src/aiq_agent/fastapi_extensions/routes/ingest.py`

- [ ] **Step 1: Implement endpoint**

```python
from __future__ import annotations

import tempfile
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException

from aiq_agent.auth.dependencies import get_current_user
from aiq_agent.knowledge.factory import get_ingestor
from aiq_agent.knowledge.base import BaseIngestor

router = APIRouter(prefix="/v1/ingest", tags=["ingest"])


class IngestRequest(BaseModel):
    file_ref: str
    collection: str
    document_id: str | None = None


class IngestResponse(BaseModel):
    status: str
    chunks_created: int | None = None
    error: str | None = None


@router.post("", response_model=IngestResponse)
async def ingest_document(
    request: IngestRequest,
    ingestor: BaseIngestor = Depends(get_ingestor),
    user=Depends(get_current_user),
):
    parsed = urlparse(request.file_ref)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="file_ref must be an HTTP URL")

    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(request.file_ref, timeout=120.0)
            response.raise_for_status()
            content = response.content

        with tempfile.NamedTemporaryFile(delete=False, suffix=".tmp") as tmp:
            tmp.write(content)
            tmp_path = tmp.name

        job_id = ingestor.submit_job(
            [tmp_path],
            request.collection,
            config={"cleanup_files": True, "document_id": request.document_id},
        )
        return IngestResponse(status="embedded", chunks_created=0)
    except Exception as exc:
        return IngestResponse(status="failed", error=str(exc))
```

- [ ] **Step 2: Add `BaseModel` import**

```python
from pydantic import BaseModel
```

- [ ] **Step 3: Wire router**

In `src/aiq_agent/fastapi_extensions/register.py` or a plugin, include the ingest router.

```python
from aiq_agent.fastapi_extensions.routes.ingest import router as ingest_router
app.include_router(ingest_router)
```

- [ ] **Step 4: Commit**

```bash
git add src/aiq_agent/fastapi_extensions/routes/ingest.py
git commit -m "feat: add python v1 ingest endpoint"
```

---

### Task 8: Adapt frontend upload hook

**Files:**
- Modify: `frontends/ui/src/features/documents/hooks/use-file-upload.ts`

- [ ] **Step 1: Replace collection creation with BFF call**

Remove `ensureCollectionExists` from upload path. Instead:

```typescript
async function uploadToBff(file: File, projectId: string) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("projectId", projectId);
  const res = await fetch("/api/documents/upload", { method: "POST", body: formData });
  if (!res.ok) throw new Error("Upload failed");
  return res.json();
}
```

- [ ] **Step 2: Update uploadFiles**

Replace `client.uploadFiles(collectionName, validFiles)` with a loop calling `uploadToBff` for each file.

- [ ] **Step 3: Commit**

```bash
git add frontends/ui/src/features/documents/hooks/use-file-upload.ts
git commit -m "feat: frontend uploads via bff route"
```

---

### Task 9: Write Python ingest tests

**Files:**
- Create: `tests/aiq_agent/knowledge/test_ingest_url.py`

- [ ] **Step 1: Write test**

```python
import pytest
from httpx import HTTPStatusError, Request, Response

from aiq_agent.fastapi_extensions.routes.ingest import ingest_document


@pytest.mark.asyncio
async def test_ingest_document_rejects_non_http_ref():
    class FakeUser:
        pass

    with pytest.raises(HTTPStatusError):
        await ingest_document(
            type("IngestRequest", (), {"file_ref": "s3://bucket/key", "collection": "proj_1"})(),
            ingestor=None,
            user=FakeUser(),
        )
```

- [ ] **Step 2: Run tests**

Run: `cd src/aiq_agent && uv run pytest tests/aiq_agent/knowledge/test_ingest_url.py -v`
Expected: 1 test passes.

- [ ] **Step 3: Commit**

```bash
git add tests/aiq_agent/knowledge/test_ingest_url.py
git commit -m "test: add ingest endpoint validation test"
```

---

## Self-review

**Spec coverage:**
- MinIO service: Tasks 1-3.
- `documents` table: Task 4.
- BFF upload + status: Tasks 5-6.
- Python ingest endpoint: Task 7.
- Frontend upload path: Task 8.
- Tests: Task 9.

**Placeholder scan:** No TBD/TODO.

**Type consistency:** `document_id` is `uuid` in DB, passed as string in JSON.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-30-document-upload-minio-plan.md`.

Defaulting to **Subagent-Driven** implementation.
