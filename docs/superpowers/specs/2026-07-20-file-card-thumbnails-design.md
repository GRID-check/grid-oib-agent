# File Card Thumbnails — Design Spec

**Date:** 2026-07-20
**Status:** Draft

## Problem

File cards in the document grid show decorative SVG sketches (floor plan, document, photo icons) instead of actual previews of the uploaded file content. The preview panel already renders real file content (PDFs, images), but the cards never reflect what the file actually looks like.

## Solution

Generate low-resolution thumbnail images during the ingestion pipeline and display them on file cards. Thumbnails are created once per file at ingest time and served via a new BFF endpoint.

## Architecture

### 1. Backend: Thumbnail generation during ingestion

**File:** `sources/knowledge_layer/src/llamaindex/adapter.py`
**Method:** Extension of `_run_ingestion()` after successful text extraction.

- **PDFs:** Render page 0 via `pypdfium2` → PIL Image → `thumbnail()` max 200px wide → re-encode as JPEG Q80
- **Images:** PIL `Image.open()` → `thumbnail()` max 200px wide → re-encode as JPEG Q80
- Upload thumbnail to MinIO at a derived key (see §2)

**Libraries used (already in project):**
- `PIL/Pillow` — image loading, resize, re-encode
- `pypdfium2` — PDF page rasterization

### 2. Data: Storage strategy

**MinIO key convention:** Derive from the original document key by inserting `_thumb` segment:

```
Original:  org/{orgId}/project/{projectId}/doc/{documentId}/{filename}
Thumbnail: org/{orgId}/project/{projectId}/doc/{documentId}/_thumb.jpg
```

**No DB schema changes needed.** The thumbnail MinIO key is deterministically derivable from the document's existing fields: `{orgPrefix}/{projectPrefix}/doc/{documentId}/_thumb.jpg`. The BFF constructs the key on-the-fly using the same `buildMinioKey()` utility after loading the document row (which carries `organizationId`, `projectId`, and `id`).

### 3. BFF: API route

**Route:** `GET /api/documents/{id}/thumbnail`

**Handler:** `getDocumentThumbnail(session, documentId)` in `lib/documents/service.ts`

1. Load document via `getAccessibleDocument()` (gives us `projectId`, `organizationId`, `minioKey`)
2. Derive thumbnail MinIO key from the document's existing fields: the same path as the original but with `/_thumb.jpg` replacing the original filename segment
3. Presign `GetObjectCommand` for the thumbnail key (3600s TTL) — 404 if the key doesn't exist → frontend falls back to SVG sketch
4. Return `{ url: string | null }` — null signals "no thumbnail" without an error response

The route uses the existing `apiRoute` factory, `signingS3Client`, and `bucketName` from `@/lib/s3`.

### 4. Frontend: Card thumbnail display

**`FileItem` type** (`project-file-workspace.tsx`): Add optional `thumbnailUrl: string | null`.

**File list loading:** Thumbnail URLs are fetched lazily per card. Each `FileCard` calls `GET /api/documents/{id}/thumbnail` when it enters the viewport (IntersectionObserver) or on mount for visible cards. The response is cached in a per-file state map so switching away and back doesn't re-fetch.

**`FileCard` component** (`file-browser-pane.tsx`):
- If `thumbnailUrl` is set → render `<img src={thumbnailUrl}>` with `object-cover` spanning the header area
- If not → keep existing `DocumentKindThumbnail` SVG sketch as fallback

## Files changed

| File | Change |
|------|--------|
| `sources/knowledge_layer/src/llamaindex/adapter.py` | Add thumbnail generation + MinIO upload in `_run_ingestion` |
| *(No summary store changes — thumbnail key is deterministic)* |
| `frontends/ui/src/app/api/documents/[id]/thumbnail/route.ts` | New BFF route |
| `frontends/ui/src/lib/documents/service.ts` | New `getDocumentThumbnail()` service function |
| `frontends/ui/src/features/documents/components/project-file-workspace.tsx` | Add `thumbnailUrl` to `FileItem` |
| `frontends/ui/src/features/documents/components/file-browser-pane.tsx` | Render thumbnail in `FileCard` |
| `frontends/ui/src/features/documents/components/archiv-workspace.tsx` | Same thumbnail support for Archiv cards |
| `docs/architecture/backend-deep-dive.md` | Document thumbnail generation |

## Edge cases

- **Non-image/non-PDF files** (Word, text, CAD): No thumbnail generated → cards show existing SVG sketch (unchanged behaviour)
- **Ingestion failure**: Thumbnail step is skipped if ingestion fails → no thumbnail path stored → cards show SVG sketch
- **Missing thumbnail at read time**: File has `thumbnail_path` but MinIO object was deleted → presign fails → `getDocumentThumbnail` returns `{ url: null }` → frontend falls back to SVG sketch
- **Large PDFs (1000+ pages)**: Rendering page 0 is cheap (~50ms) — no risk
- **Thumbnail upload failure**: Non-fatal — log warning, skip, cards show SVG sketch


