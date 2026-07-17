# Projects

Projects group related documents and chat conversations under a shared context. A project has its own document collection, and conversations created within a project are automatically scoped to query only that project's documents.

## The projects home

The **Projects** page (`/app/projects`) is the app's home. It shows every project in your organization as a card grid (three columns on desktop, collapsing responsively). Each card is split into a raised header — project name, an **Active** status chip, and the project summary from the brief — and a footer with the **last activity** time (relative, e.g. "2 hours ago", from the most recent brief update) plus a gear icon that jumps straight to that project's settings page. Clicking anywhere else on the card opens the project, resuming the section you last used.

The header row carries the page title, a search field that filters the grid by project name as you type, and the **New project** button.

When the organization-wide Archiv is enabled for your org, a full-width **Archiv** entry card appears below the grid and opens `/app/archiv` — the office's shared, org-wide knowledge.

Organization admins additionally see a **Recently deleted** section at the bottom, from which soft-deleted projects can be restored during the grace period.

Source: `frontends/ui/src/app/app/projects/page.tsx`, `frontends/ui/src/components/projects/`

## Creating a project

Click **New project** (or follow `/app/projects?new=1`, which opens the dialog automatically). Enter a name — optionally starting from a template — and create the project in your current WorkOS organization. The creator is automatically assigned the `project-admin` role.

If no projects exist yet, the page shows a centered empty state with a **Create your first project** action.

Source: `frontends/ui/src/components/projects/create-project-dialog.tsx`

## Project page layout

Opening a project (`/app/projects/{id}`) lands you in **Chat** — the project root redirects there. The left sidebar navigates the project's sections:

| Section | Route | Purpose |
|-----|-------|---------|
| **Chat** | `/app/projects/{id}/chat` | Project-scoped conversations (the landing surface) |
| **Files** | `/app/projects/{id}/files` | List, upload, and manage files |
| **Workflows** | `/app/projects/{id}/workflows` | Scheduled deep research (feature-flagged) |
| **Archiv** | `/app/archiv` | The org-wide office archive (feature-flagged) |
| **History** | `/app/projects/{id}/history` | All conversations and deep-research runs; rows reopen in chat |
| **Settings** | `/app/projects/{id}/settings` | Project parameters, members, memory, insights, danger zone (pinned at the bottom of the sidebar) |

The former **Overview** and **Members** pages were consolidated into **Settings**; their old routes redirect there (the root redirects to Chat). The legacy **Research** page redirects to **History**. The wordmark at the top of the sidebar links back to **All projects** (`/app/projects`).

Source: `frontends/ui/src/components/shell/app-sidebar.tsx`, `frontends/ui/src/app/app/projects/[id]/layout.tsx`

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

The **Members** section of the project **Settings** page (`/app/projects/{id}/settings`) lists all organization members who have been assigned a project-level role via WorkOS FGA. Available roles:

| Role | Permission slug | Capabilities |
|------|----------------|--------------|
| Viewer | `project:view` | View the project and its documents |
| Editor | `project:edit` | Upload documents to the project |
| Admin | `project:manage` | Manage members, edit project name, delete project |

Members can be added or removed by any user with the `project:manage` permission. Organization admins bypass per-project checks entirely.

Source: `frontends/ui/src/lib/authz/projects.ts:7`, `frontends/ui/src/app/api/projects/[id]/members/route.ts:32`

## Navigating between projects

Go to `/app/projects` (the wordmark in the sidebar links there). The projects home shows all projects in your organization as a card grid; clicking a card opens the project in the section you last used, and each card's gear icon opens that project's settings directly.

On desktop, project sections (Chat, Files, Workflows, Archiv, History, Settings) are reached via the left sidebar rail; on small screens the rail is replaced by a slim top bar whose menu button opens the same navigation as a drawer.

The user's active project ID is stored in user preferences (upserted via `POST /api/user/preferences`).
