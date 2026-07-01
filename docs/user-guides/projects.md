# Projects

Projects group related documents and chat conversations under a shared context. A project has its own document collection, and conversations created within a project are automatically scoped to query only that project's documents.

## Creating a project

On the **Projects** page (`/projects`), enter a name in the inline form and click **Create**. The project is created in your current WorkOS organization. The creator is automatically assigned the `project-admin` role.

If no projects exist yet, the page shows a centered creation form with the message "No projects yet. Create one to get started."

Source: `frontends/ui/src/app/projects/page.tsx:12`

## Project page layout

Each project has a dedicated page at `/projects/{id}` with three tabs in the header:

| Tab | Route | Purpose |
|-----|-------|---------|
| **Documents** | `/projects/{id}` | List, upload, and manage files |
| **Chat** | `/projects/{id}/chat` | Project-scoped conversations |
| **Members** | `/projects/{id}/members` | Manage project-level role assignments |

A link back to **All Projects** (`/projects`) is always visible in the header.

Source: `frontends/ui/src/app/projects/[id]/layout.tsx:12`

## Project-scoped chat

When you start a chat from a project's Chat tab, the conversation is tagged with the project's ID. The `buildCollectionScopeFromRequest()` function includes the project's collection (`proj_{uuid}`) in the `X-Grid-Collection-Scope` header. This limits knowledge retrieval to documents uploaded to that project.

Source: `docs/technical-reference/chat-flow.md`, `frontends/ui/src/app/api/chat/route.ts:55`

## Document management

Upload documents via the **Documents** tab. The upload flow:

1. File is uploaded to MinIO (S3-compatible object storage).
2. A `documents` row is created in PostgreSQL with status `uploaded`.
3. A presigned URL is generated and sent to `POST /v1/ingest` on the Python backend.
4. The backend downloads the file and submits it to the knowledge ingestor.
5. Document status transitions: `uploaded` → `pending` → `processed` / `failed`.

Documents are listed with their filename, content type, file size, status, and creation date.

Source: `frontends/ui/src/app/api/documents/upload/route.ts:20`, `frontends/ui/src/app/projects/[id]/page.tsx:24`

## Members and permissions

The **Members** tab lists all organization members who have been assigned a project-level role via WorkOS FGA. Available roles:

| Role | Permission slug | Capabilities |
|------|----------------|--------------|
| Viewer | `project:view` | View the project and its documents |
| Editor | `project:edit` | Upload documents to the project |
| Admin | `project:manage` | Manage members, edit project name, delete project |

Members can be added or removed by any user with the `project:manage` permission. Organization admins bypass per-project checks entirely.

Source: `frontends/ui/src/lib/authz/projects.ts:7`, `frontends/ui/src/app/api/projects/[id]/members/route.ts:32`

## Navigating between projects

Use the **Projects** link in the main navigation or go to `/projects`. The projects page shows all projects in your organization as a card grid. Click a project card to view its documents. Use the **All Projects** link in any project's header to return to the list.

The user's active project ID is stored in user preferences (upserted via `POST /api/user/preferences`).
