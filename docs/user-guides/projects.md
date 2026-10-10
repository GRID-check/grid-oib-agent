# Projects

Projects group related documents and chat conversations under a shared context. A project has its own document collection, and conversations created within a project are automatically scoped to query only that project's documents.

## The projects home

The **Projects** page (`/app/projects`) is the app's home, and it is ordered by what you were doing rather than by when projects were created.

**Pick up where you left off** — the top of the page carries up to three project cards: the projects *you* last worked in, most recent first. "Worked in" means a message you wrote in one of the project's conversations, so a colleague's busy week never reorders your page. These cards show **You were last here** with your own timestamp. If you have not worked in any project yet, the section is headed **Your projects** instead and simply shows the three most recently updated ones, with the neutral **Last activity** label — the page never claims a "continue" that did not happen.

**More projects** — everything else follows as a dense list, most recent first. Each row carries the project's initials, its name and brief, the document count and the timestamp, plus the same settings gear. A project with no brief yet simply has no second line. Rows lift onto the card surface as you point at them; on narrow screens the counts and the initials drop away and the timestamp stays, because that is what you choose a row by. Fewer than four projects and there is no list at all — the cards are the whole page.

A row carries a status chip only for a **Closed** project; an **Active** chip on every row would carry nothing. Once your office has a closed project, a filter above the list switches between **Active**, **Closed** and **All**, each with its count. The page opens on the active projects (or on all of them, when none is active).

Each card is split into a raised header — project name, an **Active** or **Closed** status chip, and the project summary from the brief — and a footer with the activity time (relative, e.g. "2 hours ago") plus a gear icon that jumps straight to that project's settings page. Clicking anywhere else on a card or row opens the project, resuming the section you last used.

The header row carries the page title, a search field, and the **New project** button. Searching collapses both sections into a single **Matches** list — with a query on screen, "continue where you left off" is not the question being asked.

When the Büroablage is enabled for your org, a full-width **Büroablage** entry card appears below the grid and opens `/app/archiv` — the office's shared, org-wide knowledge.

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
| **Büroablage** | `/app/archiv` | The office's org-wide shared files (feature-flagged) |
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

Source: `docs/technical-reference/chat-flow.md`, `frontends/ui/src/lib/collection-scope-request.ts`

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
chat — that runs on demand or on a schedule. Nothing else is required: "check
the current OIB-RL 6 requirements for this project every Monday" is a complete
job.

Managing jobs needs `project:skills:manage`; anyone with `project:view` can
read them and their history. Each job has:

- a **prompt** (required),
- an optional **schedule**: 5-field cron in a timezone you pick, or a single due
  date, or neither — then it runs only when you press **Run now**.

There is no output choice and no skill picker. Every task you create now
researches and files a report into the project; a task that should follow a
playbook names it in the prompt with `/name`, the same way you would in a chat,
and the model reads the name and decides. Tasks created before this keep the
output they were saved with and keep running as what they are.

The builder asks one thing per step — **Auftrag**, **Wann**, **Prüfen** — and
the last step states in one sentence what it is about to commit to, with the
exact text that will be fired folded underneath it.

**Where a run's answer lands.** A run writes itself into the thread that
commissioned it, as one message: its progress while it works, its report when it
finishes, and what it tried when it broke. A standing task owns one thread and
each firing appends to it. The report is also filed into the project as a
document, so it survives the thread. If a run fails or is cancelled, the message
says so; the status and the sanitized error are also in the task's run history.

**Following a run.** Starting a run — with **Run now** or on its schedule —
produces a real research job, and the run history shows what that job is doing:
*Queued*, *Running*, *Completed*, *Failed* or *Cancelled*, refreshed while the
run is active. Each row opens the thread the run writes itself into —
**View progress** while it is still working, **Open chat** once it is not. One
destination, because the run's progress, its report and, when it broke, what it
tried are one message in that thread. **Run now** opens the history straight
away and its confirmation offers *View progress*, so a started run is never
invisible. A run that names no conversation — a headless or CLI job — states its
status without a link, because there is no thread to open. The same links appear
on the chat history sheet, which lists every research run in the project.

Schedules are validated server-side: 5-field cron, per-job IANA timezone, and a
minimum cadence of `GRID_SKILL_MIN_INTERVAL_MINUTES` (default 15 minutes). Any
job may be scheduled — an attached skill can no longer veto it, because whether
something should run on a timer is a property of the job. Every run — scheduled
or manual — is subject to the async-job admission caps; rejected occurrences
appear as *skipped* runs in the history.

Source: `frontends/ui/src/features/jobs/`, service in
`frontends/ui/src/lib/jobs/`

## The Steckbrief

**Settings → Steckbrief** keeps the key facts that stay once a project is closed:

- **Address**: the project's address from the brief (edit it in the brief).
- **Period**: Beginn and Abschluss, as months. Closing the project fills in Abschluss with the current month if it is still empty.
- **People**: everyone who worked on the project, including former staff and external planners who have no Piloti account: name, function, company and from–to, optionally linked to their Piloti account. Piloti stores nothing else about them, no e-mail and no phone number, and does not use these details when it answers.

Whoever may edit the brief may change the period and the people. In a closed project the Steckbrief is read-only, but the project's admins can still remove a person: removing a person deletes every detail about them for good, which is how a request to erase someone's data is met.

## Closing a project

When the work on a project is done, close it: **Settings → Project status → Close project**. You need the project's admin role (`project:manage`).

Before it closes, Piloti offers to **clear out** („Ausmisten") what the finished project no longer needs: working copies, superseded versions, duplicates, temporary and lock files, and drafts Piloti wrote that were never published. It looks only at files you may edit, and only at their names, folders, types, tags, summaries and version state; it does not read the files again. Only files that passed the upload check reach the AI; a file held in quarantine is never proposed. The list is marked as an AI proposal, with a reason for each file, or says that only fixed rules made it when the AI check is unavailable. Every file starts selected; deselect what should stay. Nothing is removed until you confirm. What you confirm goes to the project's Papierkorb for 14 days, in a folder „Ausgemistet ‹date›" inside the folder it came from, and can be restored from there. Either all of it goes or none of it: if moving one fails, everything is put back and the project stays open. **Close without removing anything** skips this step.

Above the clear-out, the same dialog asks what this project should leave the office. Piloti offers a closed project's experience to every similar project later, so the dialog shows

- **How Piloti finds it again**: the Bundesland, Gebäudeklasse, Bauweise, uses and kind of work it compares projects by, and the period. A fact still *open* makes the project harder to find; **Add in the brief** opens the intake wizard. A fact the brief does not ask of this project, such as the construction of a retaining wall, says *does not apply* and is not missing. The building class is derived rather than entered in the brief, so it is shown but not counted.
- **What the office should keep**: the decisions and constraints the project memory holds. **Confirm** the ones that are right, and other projects cite them as confirmed by a person rather than as Piloti's reading. **Record a lesson** adds one in your words.

Confirming and recording need the right to edit the project memory (`project:memory:write`); without it the dialog shows what stays and you can still close. Nothing here is required: an incomplete profile is named, not enforced. After closing, the project memory is read-only, so this is the last moment to write to it.

A closed project

- is **read-only**: nobody can upload, move, rename or delete files or folders, change the brief or the project memory, start a deep research or a task. Piloti does not offer deep research in a closed project, because a research run files its report into the project; in a chat, **Clarify** on an open finding and **Update report** on a finished run are replaced by a note saying so. Scheduled tasks are skipped, and resume when the project is reopened. A research run that was already running when the project closed finishes, and its report stays in its conversation. Organization admins are bound by this too.
- keeps its **Papierkorb** restorable for 14 days: the project's admins can restore a folder from it without reopening the project.
- stays **searchable**, and you can still **ask about it in chat**.
- is **readable by everyone in your office**, members of the project or not, so finished work becomes reference for the whole office. Folders with their own access list stay exactly as restricted as before: someone who sees the project only because it is closed sees none of them, whatever role they hold, and the folders open to every member open to them.
- opens every page with a banner saying it is closed and since when. Its files say „‹Projekt› · abgeschlossen" wherever they appear: the preview, the chat's sources, the download log.

**Reopen project** in the same place makes it editable again, and visible only to its members. You can still delete a closed project. Closing and reopening are recorded in the audit log.

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

On desktop, project sections (Chat, Files, History, Jobs, Skills, Büroablage, Settings) are reached via the left sidebar rail; on small screens the rail is replaced by a slim top bar whose menu button opens the same navigation as a drawer.

**Resizing the rail.** Drag the rail's outer edge to set its width, anywhere between 200px and 420px; drag it in past the minimum and it folds to the 64px icon rail, drag back out and it returns to the width it had. A click on that edge still folds and unfolds it, as does the control in the rail's brand row. The edge is also a keyboard splitter: Tab to it, then ← / → resize by 16px (with Shift, 64px), Home and End go to the bounds, one more ← at the minimum folds it, and Enter or Space toggles. Both the width and the folded state are per-browser, kept in `localStorage` (`grid.sidebar.width`, `grid.sidebar.collapsed`), so they follow you between sections and sessions but not between devices.

The user's active project ID is stored in user preferences (upserted via `POST /api/user/preferences`).
