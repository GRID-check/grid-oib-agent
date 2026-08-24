# Projects

Projects group related documents and chat conversations under a shared context. A project has its own document collection, and conversations created within a project are automatically scoped to query only that project's documents.

## The projects home

The **Projects** page (`/app/projects`) is the app's home, and it is ordered by what you were doing rather than by when projects were created.

**Pick up where you left off** — the top of the page carries up to three project cards: the projects *you* last worked in, most recent first. "Worked in" means a message you wrote in one of the project's conversations, so a colleague's busy week never reorders your page. These cards show **You were last here** with your own timestamp. If you have not worked in any project yet, the section is headed **Your projects** instead and simply shows the three most recently updated ones, with the neutral **Last activity** label — the page never claims a "continue" that did not happen.

**More projects** — everything else follows as a dense list, most recent first. Each row carries the project's initials, its name and brief, the document count and the timestamp, plus the same settings gear. A project with no brief yet simply has no second line. Rows lift onto the card surface as you point at them; on narrow screens the counts and the initials drop away and the timestamp stays, because that is what you choose a row by. Fewer than four projects and there is no list at all — the cards are the whole page.

The list carries no status chip. Every project you can see is **Active** — the data model has no other state — so on a list it would be the same chip on every row, carrying nothing. It stays on the cards, and returns to the list the day a project can genuinely be something else.

Each card is split into a raised header — project name, an **Active** status chip, and the project summary from the brief — and a footer with the activity time (relative, e.g. "2 hours ago") plus a gear icon that jumps straight to that project's settings page. Clicking anywhere else on a card or row opens the project, resuming the section you last used.

The header row carries the page title, a search field, and the **New project** button. Searching collapses both sections into a single **Matches** list — with a query on screen, "continue where you left off" is not the question being asked.

When the organization-wide Archiv is enabled for your org, a full-width **Archiv** entry card appears below the grid and opens `/app/archiv` — the office's shared, org-wide knowledge.

Organization admins additionally see a **Recently deleted** section at the bottom, from which soft-deleted projects can be restored during the grace period.

Source: `frontends/ui/src/app/app/projects/page.tsx`, `frontends/ui/src/components/projects/`

## Creating a project

Click **New project** (or follow `/app/projects?new=1`, which opens the dialog automatically). Enter a name — optionally starting from a template — and create the project in your current WorkOS organization. The creator is automatically assigned the `project-admin` role.

If no projects exist yet, the page shows a centered empty state with a **Create your first project** action.

Source: `frontends/ui/src/components/projects/create-project-dialog.tsx`

## Project page layout

Opening a project (`/app/projects/{id}`) lands you in **Ask Piloti** — the project root redirects there. The left sidebar navigates the project's sections:

| Section | Route | Purpose |
|-----|-------|---------|
| **Ask Piloti** | `/app/projects/{id}/chat` | Project-scoped conversations (the landing surface) |
| **Files** | `/app/projects/{id}/files` | List, upload, and manage files |
| **History** | `/app/projects/{id}/history` | All conversations and deep-research runs; rows reopen in chat |
| **Jobs** | `/app/projects/{id}/jobs` | This project's scheduled prompts, and their run history (feature-flagged) |
| **Skills** | `/app/projects/{id}/skills` | The organization's skill toolbox (feature-flagged) |
| **Archiv** | `/app/archiv` | The org-wide office archive (feature-flagged) |
| **Inbox** | `/app/inbox` | Mentions, shares, and operational notices (feature-flagged) |
| **Settings** | `/app/projects/{id}/settings` | Project parameters, members, memory, insights, danger zone (pinned at the bottom of the sidebar) |

Every section except **Ask Piloti** shares one page header: a `{project} / {section}` breadcrumb, the section title, a one-line subtitle, and optional actions on the right. Ask Piloti is the exception — it is a full-bleed conversation surface with its own toolbar.

The former **Overview** and **Members** pages were consolidated into **Settings**; their old routes redirect there (the root redirects to Ask Piloti). The legacy **Research** page redirects to **History**. The wordmark at the top of the sidebar links back to **All projects** (`/app/projects`).

Source: `frontends/ui/src/components/shell/app-sidebar.tsx`, `frontends/ui/src/app/app/projects/[id]/layout.tsx`

## Project brief and intake

The **project brief** is the architect-owned context Piloti works from — location (country, Bundesland), the type of undertaking, per-building geometry and use, technical systems and project context. You capture it in the **intake wizard** (`/app/projects/{id}/intake`), which follows the Projekt-Wizard specification: eight modules **A–H** (Projektbasis, Grundstück & Widmung, Bauwerke, Nutzungen, Technik & Energie, Verfahren & Sonderrecht, Projektkontext, Zusammenfassung), a mostly-optional adaptive questionnaire that ends on module H's review step. The first question in Module A is now the **country (Land)** — Österreich (AT), Deutschland (DE), Schweiz (CH), or Anderes Land — followed by the Bundesland only when the country is Austria. For projects outside Austria, the Bundesland question is replaced by a free-text Land/Region field. This ensures the jurisdiction signal (`country=<cc>` in the prompt context) travels all the way to Piloti, so answers correctly reflect the applicable legal framework. When you save, the wizard confirms the write with a toast — *"Projektprofil gespeichert — N Angaben erfasst"* — reporting how many facts were captured, then returns you to the project.

The wizard implements four scopes: a project may contain one grundstück and **one or more Bauwerke** (added as duplicable cards in module C), and each building's selected uses (module D) expand into **use-zones** with their own key figures. Numeric questions carry one of three **answer modes** — *Wert* (confirmed), *Schätzung* (estimated) or *noch offen* — and yes/no questions add a third *noch offen* value. These modes are not cosmetic: a confirmed answer becomes a fact, an estimate becomes an unconfirmed assumption, and an open answer becomes an unknown, so the mode travels all the way to Piloti (the prompt context lists confirmed facts, assumptions and unknowns separately). Every question shows a *"Warum fragen wir das?"* legal rationale, and the modules marked as system derivations (Gebäudeklasse, UVP-Relevanz) collect the inputs those classifications need. Gebäudeklasse is not auto-computed yet: it is confirmed in the brief when known, and otherwise asked in chat before an answer that hangs on it.

On the project overview the brief renders as a grouped fact sheet with an AI-written prose summary. When a save has just reset the prose, the summary regenerates automatically with a visible *"Piloti schreibt die Projekt-Zusammenfassung…"* state. If that automatic generation cannot complete — for example when no language model is configured — the card shows a calm inline notice (*"Zusammenfassung derzeit nicht verfügbar"*, with the hint *"KI-Dienst nicht konfiguriert — bitte Administrator kontaktieren"* in that specific case) alongside a button to retry, rather than leaving the summary silently blank.

Changing the location in the intake wizard takes effect immediately for new chats: the profile save clears both the cached project-context prompt view and the cached Bundesland used for jurisdiction-dependent RIS logic, so a saved location change is never served stale.

Source: `frontends/ui/src/features/projects/components/project-intake-wizard.tsx`, `frontends/ui/src/features/projects/components/project-brief.tsx`, `frontends/ui/src/lib/project-profile/`

## Project-scoped chat

When you start a chat from a project's "Ask Piloti" (chat) tab, the conversation is tagged with the project's ID. The `buildCollectionScopeFromRequest()` function includes the project's collection (`proj_{uuid}`) in the `X-Grid-Collection-Scope` header. This limits knowledge retrieval to documents uploaded to that project.

Source: `docs/technical-reference/chat-flow.md`, `frontends/ui/src/app/api/chat/route.ts:55`

## Document management

Upload documents via the **Documents** tab. The upload flow:

1. File is uploaded to SeaweedFS (S3-compatible object storage).
2. A `documents` row is created in PostgreSQL with status `uploaded`.
3. A presigned URL is generated and sent to `POST /v1/ingest` on the Python backend.
4. The backend downloads the file and submits it to the knowledge ingestor.
5. Document status transitions: `uploaded` → `pending` → `processed` / `failed`.

Documents are listed with their filename, content type, file size, status, and creation date.

Source: `frontends/ui/src/app/api/documents/upload/route.ts:20`, `frontends/ui/src/app/projects/[id]/page.tsx:24`

## Skills (feature-flagged)

The **Skills** tab (`/app/projects/{id}/skills`) is the organization's **skill
toolbox** (ADR-0046). A skill is a written procedure — a `SKILL.md` with a
name, a description and instructions — that the agent can be told to follow.
The page only exists when the skills feature is enabled for your organization;
otherwise the route 404s. It replaces the former Workflows tab.

The toolbox is organization-wide, even though you reach it from a project: it
lists every skill available to your organization — the ones Piloti ships plus
the ones your organization wrote. Each card shows where the skill came from,
which agents may use it, its description, and a preview of its verbatim
instructions. A shipped skill can be **cloned** into your organization and then
edited; a skill your organization authored can be edited or deleted. Without
`org:skills:manage` the page is read-only — everyone can see what exists,
because that is also what the agent sees.

A skill says nothing about *when* it runs or *what comes out*. It declares who
may use it, and that is all. Running one on a timer is what the **Jobs** tab is
for; running one in a conversation is what typing `/` at the start of a chat
message is for — see [Chat](chat.md).

Source: `frontends/ui/src/features/skills/`, service in
`frontends/ui/src/lib/skills/`

## Jobs (feature-flagged)

The **Jobs** tab (`/app/projects/{id}/jobs`) is where a prompt is put on a
timer. **A job is a prompt** — the question you would have typed into a new
chat — that runs on demand or on a schedule. A skill may be **attached** on
top, exactly as typing `/name` before that message would attach it, but a job
does not need one: "check the current OIB-RL 6 requirements for this project
every Monday" is a complete job with no skill involved.

Managing jobs needs `project:skills:manage`; anyone with `project:view` can
read them and their history. Each job has:

- a **prompt** (required),
- an optional **skill**, chosen from the toolbox. Choosing one copies it into
  the job at save time, so editing the skill afterwards never silently changes
  what an already-scheduled job sends,
- an **output**: a **chat** (a conversation you can open and keep typing into)
  or a **deep-research report**. This is your choice on the job, not something
  the skill decides. It also decides which skills can be attached, since the
  two agents can run different procedures,
- an optional **schedule**: 5-field cron in a timezone you pick.

The builder shows the form on the left and a live *what the agent receives*
preview on the right, so what you approve is exactly what gets submitted —
prompt first, then the attached skill's instructions when there is one.

**Where a chat job's answer lands.** A job with **chat** output writes its
question and answer into a real conversation in this project, titled with the
job's name and visible to everyone with project access — it appears alongside
the project's other conversations, and you can open it and keep talking. If a
run fails or is cancelled, the thread says so in one line instead of sitting
empty; the real status and error are in the job's run history. A
**deep-research** job produces a report instead, with no thread.

**Following a run.** Starting a run — with **Run now** or on its schedule —
produces a real research job, and the run history shows what that job is doing:
*Queued*, *Running*, *Completed*, *Failed* or *Cancelled*, refreshed while the
run is active. Each row links to the matching view: **View progress** opens the
research panel and follows the run live (its tasks tick off as it works, and the
panel's **Stop researching** button cancels it), **View report** opens a
finished run's report, and **View thinking** opens a failed run's trace. **Run
now** opens the history straight away and its confirmation offers *View
progress*, so a started run is never invisible. The same links appear on the
**History** page, which lists every research run in the project.

Schedules are validated server-side: 5-field cron, per-job IANA timezone, and a
minimum cadence of `GRID_SKILL_MIN_INTERVAL_MINUTES` (default 15 minutes). Any
job may be scheduled — an attached skill can no longer veto it, because whether
something should run on a timer is a property of the job. Every run — scheduled
or manual — is subject to the async-job admission caps; rejected occurrences
appear as *skipped* runs in the history.

Source: `frontends/ui/src/features/jobs/`, service in
`frontends/ui/src/lib/jobs/`

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

On desktop, project sections (Chat, Files, History, Jobs, Skills, Archiv, Settings) are reached via the left sidebar rail; on small screens the rail is replaced by a slim top bar whose menu button opens the same navigation as a drawer.

**Resizing the rail.** Drag the rail's outer edge to set its width, anywhere between 200px and 420px; drag it in past the minimum and it folds to the 64px icon rail, drag back out and it returns to the width it had. A click on that edge still folds and unfolds it, as does the control in the rail's brand row. The edge is also a keyboard splitter: Tab to it, then ← / → resize by 16px (with Shift, 64px), Home and End go to the bounds, one more ← at the minimum folds it, and Enter or Space toggles. Both the width and the folded state are per-browser, kept in `localStorage` (`grid.sidebar.width`, `grid.sidebar.collapsed`), so they follow you between sections and sessions but not between devices.

The user's active project ID is stored in user preferences (upserted via `POST /api/user/preferences`).
