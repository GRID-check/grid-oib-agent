# Project OS UI Overhaul Design

> **Status:** Approved for implementation by product owner.  
> **Scope:** Reframe Grid from a chat-first AI UI into a project-centered operating system for architects, with project overview, normalized folders, premium file management, previews, and project-scoped chat.  
> **Audience:** engineers implementing the UI/data/API overhaul.  
> **Date:** 2026-07-02.

---

## 1. Goal

Grid should feel like an Apple-like operating system for architecture projects. Chat remains an important feature, but the primary product object is the project: its files, facts, context, collaborators, conversations, and regulatory work.

The current UI is chat-first and has fragmented chrome. Projects do not have a meaningful overview page, the file experience is a basic table, and previews for PDFs/images are missing. This overhaul creates a calm project home, a real file workspace, and a unified shell that makes files and collaboration first-class selling points.

---

## 2. Decisions

| Decision | Rationale |
|---|---|
| Project-first hierarchy | The product is an architect project OS; chat is a project feature, not the app frame. |
| Apple-like architectural studio design language | Calm, premium, spacious UI fits architecture workflows better than a dense command center. |
| Overview-first project landing | Users should see project health, context, recent work, files, and next actions before choosing a mode. |
| Setup wizard remains separate | The mandatory project setup wizard is owned by the project-context intake work; this spec consumes its output. |
| Normalized folder model | Folders are first-class data, not inferred-only strings or UI-only metadata. |
| MinIO keys reflect folder hierarchy | Storage should match the user's mental model of project folders. |
| Uppy for upload intake | Avoid rebuilding multi-file upload, progress, retry, and folder-upload primitives from scratch. |
| Tree library for folder navigation | Avoid rebuilding accessible tree keyboard, selection, and drag/drop behavior from scratch. |
| Custom Grid preview/details UI | The premium file workspace is product-specific and should not look like a generic uploader dashboard. |
| Project-wide retrieval in v1 | Folder location organizes files; the AI retrieval boundary remains the whole project collection for simplicity. |

---

## 3. Application Structure

Routes should express the project-first product model:

| Route | Purpose |
|---|---|
| `/projects` | Authenticated product home and project list/create surface. |
| `/projects/{id}` | Project overview home. |
| `/projects/{id}/files` | Project file manager. |
| `/projects/{id}/chat` | Project-scoped assistant. |
| `/projects/{id}/members` | Project collaboration/admin. |

The global home page should route authenticated users toward projects. The UI should use one calm global top bar and one shared project shell. Project screens should not each reinvent app chrome.

The project shell includes:

- Project identity: name and compact metadata.
- Project navigation: Overview, Files, Ask Grid, Members.
- Clear return path to all projects.
- Shared action placement for upload, ask, invite, and setup completion when relevant.

The README should be rewritten to position Grid as a project-centered operating system for architects, not primarily an AI-Q chat gateway.

---

## 4. Project Overview

The project overview is the post-setup home base for a building project. It should be calm, useful, and scannable.

The overview shows:

- **Project identity header:** project name, project metadata if available, and primary actions for Ask Grid, Upload Files, and Invite.
- **Project context summary:** persisted `profile_display` and `profile_highlights` from the project-context intake work when available.
- **Setup/completeness prompt:** if setup is incomplete or profile data is missing, show a prominent but elegant prompt to complete project setup. Do not duplicate the wizard.
- **Recent activity:** latest uploads, ingestion failures, recent conversations, and notable project updates.
- **File snapshot:** counts by file type/status plus recent files with quick preview/open affordances.
- **Grid assistant entry:** continue the latest project chat or start a new project-scoped question without making chat dominate the page.
- **Collaboration snapshot:** members/shared access surfaced lightly because file management and sharing with colleagues are part of the product value.

The overview must not call AI on page load. It renders stored project, profile, document, conversation, and membership data.

---

## 5. Files, Folders, Uploads, And Preview

The file manager is a first-class workspace, not a document table.

### 5.1 Layout

Use a three-pane layout:

- **Left:** folder tree using `react-complex-tree` unless implementation research finds a blocking incompatibility.
- **Center:** file browser with grid/list toggle, search, filters, sort, ingestion status, and empty-folder states.
- **Right:** preview/details pane for the selected file.
- **Top:** action bar with Upload, New Folder, view controls, and future share/copy-link actions.

The first implementation may default to the hybrid layout on desktop and collapse into stacked navigation/browser/preview surfaces on mobile.

### 5.2 Storage Model

Folders are real project paths backed by normalized relational data. MinIO object keys reflect the folder hierarchy.

Example object key:

```text
org/{organizationId}/project/{projectId}/Plans/Fire Safety/{documentId}-evacuation-plan.pdf
```

Folder location organizes files, but ingestion remains project-scoped. Documents continue to embed into the project collection unless a later design adds folder-scoped retrieval.

### 5.3 Upload Model

Use Uppy for upload intake:

- Multi-file upload.
- Folder/nested file selection where browser support allows it.
- Upload progress.
- Retry and error states.
- File restrictions.
- Post-upload ingestion status display.

Uppy should not visually define the whole product. Wrap or theme it so upload feels native to Grid.

### 5.4 Preview Model

V1 supports inline previews for PDFs and images. Other files show metadata, download, ingestion status, and a future preview placeholder.

Preview should use an authorized preview route or inline presigned URL with `Content-Disposition: inline`. The existing attachment-only download behavior should remain available for explicit downloads.

### 5.5 Folder Operations

The target file workspace supports:

- Create folder.
- Upload into selected folder.
- Preserve folder paths for nested uploads.
- Select files/folders.
- Rename/move files and folders if feasible in the implementation phase.

If move/rename creates too much risk for the first implementation pass, defer it after create/upload/tree/preview while keeping the data model compatible with moves.

---

## 6. Chat And Assistant Workspace

Chat becomes a project feature inside the shared shell.

The chat page should:

- Render under `/projects/{id}/chat` inside the same project shell.
- Remove duplicate app bars and conflicting chrome.
- Clearly show the assistant is scoped to the current project.
- Keep source/research panels available but visually secondary.
- Preserve existing WebSocket/chat behavior where possible.

Project context behavior:

- Chat requests remain scoped by `projectId` and `collectionName`.
- When the project-context intake work is available, include the durable `profile_prompt_view` with project-scoped chat requests.
- Retrieval remains scoped to the whole project collection in v1.
- Suggested prompts on the overview can deep-link into chat based on project state, missing context, files, or recent activity.

---

## 7. Data Model

Use normal form for folders and documents. Avoid making folder strings the authoritative model.

### 7.1 Projects

The UI should be compatible with the project-context intake design. When available, the overview consumes these project fields:

- `profile`
- `profile_version`
- `profile_prompt_view`
- `profile_display`
- `profile_highlights`
- `profile_updated_at`

This spec does not edit or replace the separate project-context intake design.

### 7.2 Project Folders

Add a `project_folders` table if it does not already exist.

Recommended columns:

- `id uuid primary key`
- `organization_id text not null`
- `project_id uuid not null references projects(id)`
- `parent_id uuid null references project_folders(id)`
- `name text not null`
- `path text not null`
- `created_by text not null`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`

Constraints and indexes:

- Unique `(project_id, parent_id, name)`.
- Index `(project_id, parent_id)`.
- Index `(project_id, path)`.
- Server-side validation prevents empty names, path traversal, reserved names, duplicate slashes, and cross-project parent references.

`path` is a cache derived from the hierarchy for UI and MinIO convenience. The relational parent chain is authoritative.

### 7.3 Documents

Extend `documents` with folder linkage while preserving existing ingestion fields:

- `folder_id uuid null references project_folders(id)`
- existing `filename`
- existing `minio_key`
- existing `collection_name`
- existing `file_size`, `content_type`, `status`, `error_message`, and `metadata`

Documents are stored in MinIO under keys derived from organization, project, folder hierarchy, document id, and filename. Use a document id in the object key to avoid collisions when files share names.

Root-level documents may use `folder_id = null` or a generated root folder row. The implementation should pick one convention and use it consistently across API, UI, and tests.

---

## 8. APIs

Add or adapt BFF routes around project-first screens.

Project routes:

- `GET /api/projects/:id` returns project metadata needed by shell and overview.
- `GET /api/projects/:id/overview` aggregates project, profile display, document stats, recent files, recent conversations, and members for the overview page.

Folder routes:

- `GET /api/projects/:id/folders` returns normalized folder tree plus enough file counts for navigation.
- `POST /api/projects/:id/folders` creates a folder.
- `PATCH /api/projects/:id/folders/:folderId` is reserved for rename/move. Implement only after create/upload/tree/preview are stable.

Document routes:

- `GET /api/documents?projectId=...` returns path-aware document rows.
- Upload endpoint accepts `projectId` and optional `folderId`. Server-side code derives paths and MinIO keys from the referenced folder.
- `GET /api/documents/:id/preview` returns authorized inline preview access for PDFs/images.
- Existing download route remains explicit download behavior.

Authorization and validation:

- Every project, folder, document, preview, upload, move, and download route authorizes by organization and project membership.
- Folder ids must belong to the same project as the document/upload.
- Server derives MinIO keys; clients never submit final object keys.
- Server normalizes filenames and paths before storage.

---

## 9. Visual System

The visual language is Apple-like architectural studio with premium document-workspace polish.

Principles:

- Calm and spacious rather than dense.
- Minimal chrome and one clear hierarchy.
- Files and project context are visually central.
- Chat is integrated, not isolated.
- Use larger preview surfaces, soft cards, restrained status badges, refined empty states, and clear whitespace.
- Preserve existing design-system primitives where useful, but do not let inherited component defaults create a generic dashboard feel.
- Mobile should remain usable: project navigation collapses, file panes stack, and previews open as focused panels/sheets.

---

## 10. Testing

Backend/BFF tests:

- Folder name/path normalization.
- Folder creation authorization.
- Cross-project folder/document rejection.
- Upload into folder derives the expected MinIO key.
- Preview route authorizes access and uses inline disposition.
- Overview aggregation handles missing profile data.

Frontend tests:

- Project overview states: setup incomplete, no files, files present, ingestion error.
- File manager states: empty folder, selected PDF, selected image, processing file, failed file.
- Upload UI sends selected folder information.
- Chat page renders inside project shell and sets project scope.

Quality checks:

- `npm run lint`
- `npm run type-check`
- Relevant `npm run test` or targeted Vitest suites.

---

## 11. Rollout Plan

Implement in small phases so each phase can be reviewed and verified independently:

1. **Project shell and overview:** route structure, shared shell, overview page, README repositioning.
2. **Normalized folders:** schema migration, folder services/routes, document folder linkage, path/key normalization.
3. **Upload overhaul:** Uppy integration, upload into selected folder, progress/error states, ingestion status continuity.
4. **File manager:** tree navigation, grid/list browser, preview/details pane, PDF/image preview route.
5. **Chat integration:** render chat inside project shell and tune visual hierarchy.
6. **Polish and collaboration affordances:** sharing placeholders, member snapshot, mobile behavior, empty states, motion/detail.

---

## 12. Non-Goals For V1

- Folder-scoped retrieval.
- Per-folder permissions or inheritance.
- Full Office document previews.
- Real-time collaborative editing.
- Arbitrary AI-generated overview UI.
- Replacing the mandatory setup wizard owned by the project-context intake work.
