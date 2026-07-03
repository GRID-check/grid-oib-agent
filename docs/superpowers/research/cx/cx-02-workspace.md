# CX Research 02 — Project Workspace (Overview / Intake / Files)

Scope: GRID frontend (`frontends/ui`), traced from actual source. GRID is an OIB/RIS
building-compliance copilot for Austrian architects; the unit of work is a "project"
(building project). This cluster covers the three workspace surfaces reachable from the
project sidebar shell (`src/components/shell/app-sidebar.tsx`): **Overview**, **Files**,
and the **Intake wizard** (reached from Overview, not itself a sidebar tab). Chat and
Research are covered elsewhere.

---

## 0. Architectural finding that frames everything below

The three surfaces are built on **three different rendering models** with no shared
loading/error vocabulary between them:

- **Overview** (`src/app/projects/[id]/page.tsx`) is a pure **server component** — all
  data (`getProjectOverviewData`) is fetched before render. There is no client loading
  skeleton and no client error boundary; failure states are Next.js-level (404/500), not
  designed UI.
- **Intake** (`src/features/projects/components/project-intake-wizard.tsx`) is a
  **client component** that fetches its own definition, has a bespoke `sessionStorage`
  autosave layer, and its own terminal (non-recoverable) error state.
- **Files** (`src/features/documents/components/project-file-workspace.tsx`) is a
  **client component** that fires two independent one-shot `fetch`es on mount with no
  polling/refetch after mutation, and swallows network errors into empty arrays.

A second cross-cutting finding: the intake wizard's own profile writer
(`buildProfileFromAnswers`) is a **hand-rolled, partial reimplementation** of the real
generic JSON-pointer patch engine (`applyProjectProfilePatch` in
`src/lib/project-profile/prompt-view.ts:89-166`) that chat-driven `ProjectProfilePatchCard`
edits use. The two code paths can leave the same `ProjectProfile` object in subtly
different shapes (see §2.5), and the intake wizard's writer never touches
`profile.unknowns`, even though `unknowns` is what Overview prominently displays as
"Grid still doesn't know: …".

---

## 1. Overview — `src/app/projects/[id]/page.tsx` + `project-overview.tsx`

### 1.1 Entry points & branches

- Route: `ProjectPage` (`page.tsx:14-27`) — `requireAuthorizedSession()` (15) →
  `requireProjectAccess(session, id, 'project:view')` (18) →
  `getProjectOverviewData(id, session.organizationId)` (20). `null` → `notFound()` (22-24).
  Otherwise renders `<ProjectOverview data={data} />` (26).
- JSON mirror: `GET /api/projects/[id]/overview` (`src/app/api/projects/[id]/overview/route.ts:9-32`)
  reuses the same query — exists for programmatic/agent consumption, not used by the page.
- Sidebar nav entry: `src/components/shell/app-sidebar.tsx:35-41` — Overview is the
  project root (`segment: null`), sits alongside Chat/Files/Research/Members, `LayoutDashboard` icon.

### 1.2 Step-by-step data flow

All in `src/lib/projects/overview-query.ts:17-79`, one function, no client fetch hook:

1. `db.select` on `projects` scoped by `id` + `organizationId` (23-33) →
   `{ id, name, collectionName, createdAt, profileDisplay }`.
2. No row → return `null` → `notFound()` (35-37).
3. Aggregate on `documents`: `count(*)`, `sum(fileSize)` scoped to project+org (39-45).
4. Recent documents: `id, filename, fileSize, contentType, status, createdAt`, `limit(5)`,
   `orderBy(desc(createdAt))` (47-59).
5. Assembled into `ProjectOverviewData` (61-78); `profileDisplay.keyFacts` defaults to `[]`.

Shape (`src/features/projects/types.ts:4-27`):
```
OverviewDocument { id, filename, fileSize, contentType, status, createdAt }
ProjectOverviewData {
  id, name, collectionName, createdAt,
  profileDisplay: { title?, summary?, keyFacts?: {label,value}[], missingInfo?: string[] } | null,
  documentCount, totalFileSize, recentDocuments: OverviewDocument[]
}
```

`profileDisplay` is built server-side by `buildProjectProfileDisplay`
(`src/lib/project-profile/prompt-view.ts:73-87`) whenever the profile is saved (intake or
patch). **`title` is hardcoded to `'Project profile'` and `summary` is hardcoded to `''`**
at build time (77-78) — the async AI-generated summary (§2.6) is the only thing that ever
fills `summary` in later, via a separate `generate-summary` call.

### 1.3 States

| State | Condition | file:line |
|---|---|---|
| Loading | none — server-rendered, no client skeleton exists | — |
| Error | Next.js 404 boundary only (project not found/no access) | `page.tsx:22-24` |
| Empty (no profile at all) | `!hasProfile` (no `title`/`summary`) | `project-overview.tsx:29-31, 84-94` |
| **Silent partial gap** | `hasProfile` true but `keyFacts.length === 0` | neither the Brief card (`L44`) nor the Setup Prompt (`L84`) renders — blank space between title and Quick Actions |
| Brief present | `hasProfile && keyFacts.length > 0` | `project-overview.tsx:44-81` |
| Brief + missing info | `missingInfo.length > 0` | `project-overview.tsx:65-78` |
| Files present | `documentCount > 0` | `project-overview.tsx:125` |
| Files empty | `!hasDocuments` | `project-overview.tsx:157-166` |

Test coverage (`project-overview.spec.tsx`) only exercises: project name render, no-profile
prompt, 5-document count, empty-file state, and 2 key-facts. **Untested**: `missingInfo`
rendering, `recentDocuments` list rendering, status-badge coloring, the silent-partial-gap
state above.

### 1.4 The "Project Brief" card

- Header "Project Brief" + "Edit brief" link → `/projects/${id}/intake` (`L50-55`) — **not
  inline-editable on Overview**; all edits route through the separate intake page.
- Body: `<dl>` grid of `keyFacts` label/value pairs, 2 cols mobile / 3 cols `sm:` (57-64).
- Footnote if `missingInfo` present: "Grid still doesn't know: {joined} — complete the
  brief" (65-78), also linking to `/intake`.
- **This card is not client-reactive.** `ProjectProfilePatchCard`
  (`src/features/grid-cards/components/ProjectProfilePatchCard.tsx`) — a chat-embedded
  card the agent renders when proposing a profile change — posts accepted patches straight
  to `/api/projects/${id}/profile/patches` and only updates its own local
  `pending|accepted|rejected` state. It has **no callback into Overview's cache/store**;
  Overview is a server component, so a user who accepts a patch in Chat will only see it
  reflected on Overview after a full navigation/reload.
- Patch card UX: shows a human-readable `<table>` diff of Field/Before/After per changed
  fact (`ProjectProfilePatchCard.tsx:86-105`) rather than raw JSON-pointer ops — a good
  choice. "Reject" is purely client-side (no server call, no audit trail); "Accept" POSTs
  and shows "Project context updated."

### 1.5 Stats shown

Exactly three tiles (`project-overview.tsx:107-122`), all sourced directly from the query
above: **Files** (`documentCount`), **Total size** (`formatFileSize(totalFileSize)`),
**Knowledge base** (`collectionName`, truncated). There is **no compliance-status stat, no
research-run count, and no member-count** anywhere on Overview — despite Research and
Members being sibling sidebar tabs, the workspace's home page gives the architect zero
signal about what's happening in those areas.

### 1.6 Recent Files

Header "Recent Files" + "View all" → `/files` (127-137). List rows show filename, size,
and a status `Badge` colored via `statusClasses()` (15-26): green
`uploaded|ready`, blue `pending|ingesting`, red `failed`, gray fallback showing
`status ?? 'unknown'`. Empty state: dashed border + "No files yet. Upload your first
document to get started." + button → `/files` (157-166). **Individual recent-file rows
are not clickable** — only the header "View all" link and the empty-state CTA route
anywhere.

### 1.7 CTAs

| Copy | Target | Location |
|---|---|---|
| "Set up project context" | `/intake` | no-profile empty state (L84-94) |
| "Ask Grid" | `/chat` | Quick Actions (always visible, L97-104) |
| "Upload Files" | `/files` | Quick Actions + files-empty-state (L97-104, 157-166) |
| "Edit brief" | `/intake` | Brief card header (L50-55) |
| "complete the brief" | `/intake` | missing-info footnote (L71-76) |
| "View all" | `/files` | Recent Files header (L131-136) |

### 1.8 Visual polish

- shadcn/ui primitives (`Badge`, `Button asChild+Link`), Tailwind, `cn()` — consistent with
  the rest of the app.
- **No icons or illustrations anywhere** in `project-overview.tsx` — a stark contrast with
  the sidebar (`lucide-react` icons everywhere). The page is plain cards/`<dl>`/`<div>`s:
  no charts, no avatars, no empty-state artwork.
- **Three different color-token vocabularies observed across two closely related
  components**: `project-overview.tsx`'s `statusClasses` uses
  `--background-color-feedback-success-subtle`-style custom properties, the rest of the
  page uses Tailwind semantic classes (`bg-card`, `text-muted-foreground`), and
  `ProjectProfilePatchCard` uses yet another scheme (`border-l-warning`, `text-subtle`,
  `bg-surface-raised-30`). This is a real design-system fragmentation, not just taste.
- The "profile summary" paragraph (L38-40) can **never render non-empty text** under
  current builder logic (`summary: ''` hardcoded until the async generate-summary call
  overwrites it) — effectively dead visual real estate most of the time.
- No TODO/FIXME found; the file is clean, just under-designed.

---

## 2. Intake Wizard — `intake/page.tsx` + `project-intake-wizard.tsx`

### 2.1 Entry points

- **New project creation never routes to intake.** `create-project-form.tsx` → server
  action `createProject` → `redirect('/projects/${id}')` — projects land on Overview,
  not intake. Intake is only ever reached by the user clicking "Set up project context"
  or "Edit brief"/"complete the brief" links from Overview.
- **Route guard bug**: `intake/page.tsx:16-34` queries `profilePromptView`; **if it's
  already truthy (intake was ever completed), the page immediately redirects to
  `/projects/${id}`** (29-31) — before the wizard component ever mounts. This directly
  contradicts Overview's own "Edit brief" link, which promises re-entry into intake once a
  profile exists. In the current code, once intake is completed once, it can never be
  re-opened through the UI — "Edit brief" silently bounces back to Overview.

### 2.2 Wizard architecture (`src/lib/project-profile/intake-definition.ts`)

`projectIntakeDefinitionV1`, `version: 1`, 5 stages (28-244):

1. **Core** (31-85): `project_name` → `hauptnutzung` (9 Austrian use categories) →
   conditional `anzahl_betten` (only if `hauptnutzung === 'beherbergung'`) → conditional
   `anzahl_einheiten` (only if `'wohnen'`) → conditional `sicherheitskategorie` (only if
   `hauptnutzung` is `beherbergung` OR `gesundheit`).
2. **Classification** (87-135): `widmung`, `gebaeudeklasse` (GK1–GK5), `bauweise`,
   conditional `hohe_gebaeude_details` (only if GK4/GK5).
3. **Building** (137-165): floor counts, `fluchtniveau` — no conditionals.
4. **Regulatory** (167-219): 4 booleans + `bestand_neubau`, conditional `bestandsalter`
   (only if `bestand_neubau === 'bestand'`).
5. **Goals & Output** (221-242): `primary_goal` (`writesTo: '/goals/primary_goal'`, the
   only question not writing to `/facts/...`), `output_format`.

Conditional engine lives in the wizard, not the schema: `evaluateCondition()`
(`project-intake-wizard.tsx:26-36`) supports only `{field, equals}` or `{field, oneOf}`
against already-collected `answers`; defaults to visible for anything else. No forward-
reference protection (works in practice because all conditions reference earlier fields).

### 2.3 Step-by-step interaction

- `visibleQuestions` = `useMemo` filter of the current stage's questions through
  `evaluateCondition` (116-123).
- Field types: `text`/`number` → `Input`; `boolean` → native radio Yes/No; `single_select`
  → shadcn `Select`; **`multi_select`** → checkbox list, `onCheckedChange` toggles
  membership in an array, defaults to `[]` if not already an array (329, 336-341).
- `canProceed` (129-137) is type-specific (non-empty trimmed text, defined number,
  non-empty array for multi-select, etc.) but **there is no inline per-field error
  message** — the only feedback is a disabled Next/Save button. No `aria-invalid`, no
  error summary.
- Navigation: `nextStage`/`prevStage` bump `currentStage` (163-171); Back disabled on
  stage 1; last stage swaps Next for "Save & Finish".
- Progress: `((currentStage+1)/stages.length)*100` fed into a thin (`h-1`) shadcn
  `Progress` bar + "Step X of N" + stage title (193-205). A "N questions" counter sits
  near Back/Next (227-229) — a nice touch, but it counts total questions in the stage, not
  answered-vs-total.

### 2.4 Autosave / sessionStorage

- Key: `` `intake-draft-${projectId}` `` (line 79), `sessionStorage` (tab-scoped).
- **Restore**: after fetching the definition, reads and `JSON.parse`s the key; restores
  `answers` and `currentStage` if present (81-97); parse errors swallowed silently.
- **Save**: 500ms-debounced effect on `[answers, currentStage]` change (99-107); quota
  errors swallowed silently.
- "Draft saved" toast auto-hides after 2000ms (109-114).
- **Refresh mid-wizard**: restores exactly where the user left off (same tab).
- **Completion**: `sessionStorage.removeItem` runs inside `handleSave`, after the PUT
  succeeds (150-152) — but unconditionally continues into the generate-summary call, so a
  failure there still clears the draft even though the user sees an error (see §2.6).
- **Abandonment**: no TTL, no versioning against `definition.version` — a stale draft
  with answer keys from an old schema would be partially restored with **no validation**
  that its keys still match current question IDs.

### 2.5 `buildProfileFromAnswers` / `writesTo` mapping

Lives entirely inside the wizard component (`project-intake-wizard.tsx:38-67`), **not
shared** with the real patch engine:

```ts
function buildProfileFromAnswers(answers, definition): ProjectProfile {
  const facts = {}, goals = {}
  const now = new Date().toISOString()
  for (const question of definition.stages.flatMap(s => s.questions)) {
    const answer = answers[question.id]
    if (answer === undefined || answer === null || answer === '') continue
    const normalizedValue = Array.isArray(answer) ? JSON.stringify(answer) : answer
    const writesTo = question.writesTo || ''
    if (writesTo.startsWith('/goals/')) goals[writesTo.replace('/goals/', '')] = normalizedValue
    else if (writesTo.startsWith('/facts/')) {
      const match = writesTo.match(/^\/facts\/([^/]+)/)
      if (match) facts[match[1]] = { value: normalizedValue, confidence: 'confirmed', source: 'onboarding', updatedAt: now }
    }
  }
  return { facts, goals, unknowns: [], assumptions: {} }
}
```

- Only a first-path-segment string-prefix check, not a real pointer walker.
- **multi_select answers are double-encoded**: an array like `['a','b']` is stored as the
  literal string `'["a","b"]'` inside `facts[key].value`, even though
  `ProjectPrimitiveValueSchema` natively supports `z.array(z.string())`.
- **`unknowns` is hardcoded to `[]`** — the wizard never populates it, despite Overview
  prominently surfacing `profile.unknowns` as "Grid still doesn't know: …".
- Skipped/unanswered questions are simply dropped; no collision detection if two questions
  ever shared a `writesTo` key (none currently do).
- Contrast with the real generic engine, `applyProjectProfilePatch`/`applyPatchOperation`
  (`src/lib/project-profile/prompt-view.ts:89-166`): proper `/`-split path walking, `~1`/`~0`
  unescaping, array-index and `-`-push support, prototype-pollution guards
  (`UNSAFE_POINTER_SEGMENTS`), and a `safePatchPath` regex restricting writes to
  `facts|goals|unknowns|assumptions`. **The wizard reimplements a cruder subset of this
  instead of reusing it** — a clear duplication/simplification opportunity.

### 2.6 Completion flow

`handleSave` (139-161):
1. Build `profile` via the writer above.
2. `PUT /api/projects/${id}/profile` — full-profile replace, optimistic concurrency via
   `profileVersion` (409 on conflict), server recomputes `profilePromptView` and
   `profileDisplay`.
3. Clear sessionStorage draft.
4. `POST /api/projects/${id}/generate-summary` — **awaited inside the same `try` block** —
   calls a separate backend service (`BACKEND_URL`/`v1/generate-summary`) with
   `profile_text`, merges the returned `summary` into `profileDisplay` (preserving
   `title`/`keyFacts`/`missingInfo`).
5. `router.push('/projects/${id}')` + `router.refresh()`.
6. On **any** failure in steps 2–4, the same generic `error = 'Failed to save project
   profile'` is shown — meaning **a summary-generation failure reports as a full save
   failure even though the profile itself was already durably persisted in step 2**. The
   user sees an error, stays on the wizard, and a retry re-PUTs (idempotent but can now
   hit a 409 conflict from the version bump that already happened), surfacing the same
   misleading generic message again.
7. **No review/confirm screen** before submit — no preview of the collected facts, no raw
   JSON, direct save-on-click.

### 2.7 All UI states

| State | Behavior | file:line |
|---|---|---|
| Loading (initial fetch) | Bare `<Skeleton className="h-4 w-48" />` only — not a form skeleton | `173-179` |
| Error (fetch or save) | Destructive `Alert`, **terminal dead end** — component returns early, no retry button, only a manual browser refresh recovers | `181-189` |
| In-progress (stage N) | Standard form + progress bar + optional "Draft saved" text | — |
| Validation | Disabled Next/Save button only, no field-level messaging | `129-137` |
| Submitting | Button label → "Saving...", disabled; no distinct indicator for the generate-summary sub-step | `232-233` |
| Success | No dedicated screen — direct `router.push` to Overview | `154-155` |
| Post-save failure | Generic error alert, wizard state retained, "retry" = re-click Save & Finish | `139-161` |

### 2.8 ProjectProfilePatchCard (downstream chat-driven edits)

One of three "Grid card" types rendered from chat responses
(`src/features/grid-cards/components/GridCards.tsx`). Shows `title`, `rationale`, and a
Field/Before/After diff table built from server-supplied `preview` (not raw patch JSON).
`pending|accepted|rejected` local state; Accept POSTs to the same
`/api/projects/${id}/profile/patches` engine described in §2.5 (real JSON-pointer patch,
optimistic concurrency, prompt-view/display rebuild); Reject is **client-only, no server
call, no audit trail**. Patched facts carry whatever `source`/`confidence` the agent chose
— unlike intake's `PUT`, which hardcodes `source: 'onboarding'`/`confidence: 'confirmed'`
for everything — so there's no server-side provenance enforcement distinguishing
architect-confirmed facts from agent-suggested ones once both have gone through the
generic patch path.

### 2.9 Visual polish

- Functionally reasonable (progress bar, step counter, stage title, Back/Next) but
  **visually flat** — no transition/animation between stages, DOM just re-renders
  instantly. Reads as a plain multi-step form, not a "typeform-like" delightful
  experience.
- No raw JSON ever shown to the user (good) — consistent with the patch card also hiding
  raw ops behind a human-readable diff.
- **Half-German/half-English terminology leakage** is the most visible rough edge: English
  question labels ("Zoning", "Building Class", "Construction Method", "Existing or New
  Building") paired with **untranslated German option values** (`Wohnen`, `Büro`,
  `Beherbergung`, `Bauland`, `Verkehrsfläche`, `Freiland`, `Offen`, `Gekuppelt`,
  `Geschlossen`, `Bestand`, `Neubau`, `Zu- und Umbau`, `'< 10 Jahre'`…`'> 50 Jahre'`). Not
  fully German, not fully English — domain (OIB/Bauordnung) vocabulary leaking directly
  into an otherwise-English form. For the target audience (Austrian architects) this reads
  as unfinished localization rather than an intentional bilingual design.
  (`intake-definition.ts:46-54, 94-100, 120-124, 198-203, 209-213`)
  - E.g. `bestandsalter` labels ("< 10 Jahre") mix language with the question's English
    label ("Existing Building Age") and its English condition partner.
- No console.log/TODO/FIXME found in any of the reviewed files — this is unfinished polish,
  not abandoned code.
- Progress bar has no per-stage stepper/dots and no way to jump back to a specific
  completed stage other than sequential Back clicks.

---

## 3. Files Workspace — `files/page.tsx` + `src/features/documents/components/*`

### 3.1 Entry points

`FilesPage` (`files/page.tsx:16`) — auth + `requireProjectAccess` + a Drizzle lookup of
`projects.name`/`collectionName`, 404s if not found (29). Renders
`<ProjectFileWorkspace projectId projectName collectionName />` (32) — a client component
owning all state.

On mount, two independent one-shot fetches (`project-file-workspace.tsx`):
- Folders: `GET /api/projects/${id}/folders` (52-56).
- Files: `GET /api/documents?projectId=...` (62-78), mapped into `FileItem[]`.

**Both effects depend only on `[projectId]`** — they never refetch after an upload,
folder creation, or status transition. There is no polling/refetch wired into the
workspace itself. `useProjectDocuments` is used only to obtain `uploadFiles`/`isUploading`
for the upload button; its `trackedFiles` (which would show per-file upload progress) are
**never rendered** anywhere on this page.

### 3.2 Layout

Fixed, non-resizable three-pane flex layout (`project-file-workspace.tsx:100-144`):
`FolderTreePane` (`w-60`, sidebar) — `FileBrowserPane` (`flex-1`, main) —
`FilePreviewPane` (`w-96`, conditional on `selectedFile`). No drag-resize splitters, no
`md:`/`lg:` responsive breakpoints anywhere — on narrow viewports the three fixed-width
panes will overflow rather than stack.

### 3.3 Step-by-step

- **Folders**: flat list fetched once, nested client-side by `parentId`
  (`folder-tree-pane.tsx:30-32`). Chevron icon (`ChevronDown`/`ChevronRight`,
  line 58) is **purely decorative** — it indicates "has children," it does not
  expand/collapse anything; all folders are always fully expanded. "+ New Folder" is
  inline-input → POST `/api/projects/${id}/folders` → appended to state on response.
- **File selection** (`file-browser-pane.tsx`): filtered by selected folder, then by a
  local case-insensitive search. Clicking a selected row toggles it off (closes preview).
  Icon logic: images → `ImageIcon`, exactly `application/pdf` → `FileText`, everything
  else (including the accepted `.docx`/`.txt`/`.md`) → generic `Paperclip`.
- **Preview** (`file-preview-pane.tsx`): `PREVIEW_TYPES` allowlist is PDF + images only —
  **docx/txt/md are never actually previewable** despite being accepted upload types;
  they always show "Preview not available." Download is a plain `<a href>` full
  navigation, not a fetch+blob flow.
- **Upload**: the component actually wired up is `ProjectUppyUpload`
  (`project-uppy-upload.tsx`) — **despite the name, it does not use the Uppy library at
  all**. It's a hidden native `<input type="file" multiple>` with **no `accept` filter**
  (so the OS picker doesn't pre-filter by type) behind a button that swaps to
  "Uploading...". No drag-and-drop, no per-file progress list.
  - A richer, drag-and-drop-capable component with per-file spinner/check/X icons,
    `FileUploadZone.tsx`, exists but is wired only into the **chat session** "Data
    Sources" flow, not the project Files page.
  - Two components are **fully dead code** (zero importers, confirmed by grep):
    `project-upload-zone.tsx` (`ProjectUploadZone`) and `project-file-explorer.tsx`
    (`ProjectFileExplorer`) — the latter's own empty-state copy ("Project uploads appear
    here after they are added from the chat Files sidebar") describes a different,
    superseded upload architecture, left in the tree unremoved.

### 3.4 Document status lifecycle

Three overlapping, **inconsistent** status vocabularies coexist:
- Canonical `DocumentFileStatus`: `uploading | ingesting | success | failed` (+ client-
  only `deleting`) — `src/adapters/api/documents-schemas.ts:18`, `types.ts:56`.
- Job-level `JobState`: `pending | processing | completed | failed`.
- Loose Postgres/API strings actually observed for project documents: `uploaded`,
  `pending`, `ingested`, `success`, `failed`, `ready`, `ingesting` — not the same closed
  enum, and **normalized differently in different components for the identical literal
  `'uploaded'`**: `file-browser-pane.tsx` colors it green (success), while the dead
  `project-file-explorer.tsx` colors it yellow (warning) — a real color-semantics bug if
  that component is ever revived.
- Rendering: `FileUploadZone` (session-only, not used here) has spinner/check/X icons but
  **no progress bar despite tracking `progress`/`uploadedBytes`**; the live Files page
  (`FileBrowserPane`/`FilePreviewPane`) only shows a plain colored text `Badge`, no icon,
  no spinner during ingestion, no progress bar anywhere.
- Polling: `UploadOrchestrator` (module singleton, `orchestrator.ts`), 5s interval, 420
  max attempts (~35 min ceiling), pure `setTimeout` recursion — no WebSocket. On terminal
  state it force-opens the **chat** "Data Sources" panel as a side effect, even for
  project-scoped uploads that have nothing to do with chat.

### 3.5 Project-scoped vs session-scoped uploads

Single hook `useFileUpload` (`use-file-upload.ts`) branches purely on whether `projectId`
is present (line 209):
- **Project-scoped** (persistent): `POST /api/documents/upload` → S3/MinIO object keyed by
  org/project/document/filename → `documents` DB row → best-effort backend ingest
  notification. Lives in the project's own vector collection (`proj_${projectId}`,
  `collection-scope.ts:23`). Meant to be durable — part of the building's compliance
  document set, independent of any one chat session.
- **Session-scoped** (ephemeral): straight to the backend collections API
  (`/api/v1/collections/${sessionCollection}/documents`, prefixed `s_...`), no DB row, no
  S3/MinIO persistence in this client path.
- **Why the split exists**: chat retrieval scope (`src/lib/collection-scope.ts:14-34`)
  layers org-wide base knowledge + the project's durable collection + (if any) the
  current session's throwaway collection — so a one-off scratch upload in a chat never
  pollutes the project's permanent compliance corpus, and gets garbage-collected via
  `discard-session-resources.ts` (`deleteCollection`, fire-and-forget, `console.warn`-only
  on failure) when an upload-only session is abandoned. **Project documents have no
  equivalent teardown path** in the reviewed files — they persist until an explicit
  delete API call.
- Sequential, not parallel: project uploads are `await`ed one-at-a-time in a `for` loop
  (211-240), not `Promise.all` — N files = N sequential round-trips, and a network failure
  partway through **marks even already-succeeded files as `'failed'` in local state**
  (285-290) — a false-failure bug.

### 3.6 All UI states

| State | Behavior | file:line |
|---|---|---|
| Empty (no files in folder) | Centered text only, "No files in this folder. Upload to get started." — no icon, no inline upload CTA | `file-browser-pane.tsx:50-56` |
| Loading — folders/files/preview | `Skeleton` bars, reasonable | `folder-tree-pane.tsx:83-89`, `file-browser-pane.tsx:39-46`, `file-preview-pane.tsx:57-63` |
| Populated | Flat divided list, icon+filename+size+badge; files are never tree-structured, only folders are | `file-browser-pane.tsx:78-101` |
| Uploading | Only signal is the top-bar button label → "Uploading..." + disabled; **no per-file progress anywhere on this page** | `project-uppy-upload.tsx:37` |
| Partial failure | Composed error string computed in the hook but **never rendered anywhere in the live component tree** — silent | `use-file-upload.ts:171-173` |
| Search empty | Inline `No files match "{search}"` | `file-browser-pane.tsx:73-77` |
| Network failure (folders/files fetch) | Silently caught to empty array — indistinguishable from a genuinely empty project, no retry, no message | `project-file-workspace.tsx:55, 77` |
| Preview fetch failure | `previewUrl` silently set to `null` → blank pane, not even a "not available" message | `file-preview-pane.tsx:37` |

### 3.7 Edge cases & failure modes

- **Duplicate-name detection is unreliable for project uploads**: it checks against
  `trackedFiles` (upload-session state), not against the actual folder listing the
  workspace fetched — files already sitting in the project from a prior page load can be
  silently re-duplicated.
- **File-count/size caps (10 files / 100MB) are computed against the same stale
  `trackedFiles` baseline**, not the real folder contents — effectively meaningless once
  a folder already has files from a previous session.
- **No `accept` filter** on the actual upload `<input>` (`ProjectUppyUpload`), unlike the
  unused `FileUploadZone` — OS file picker doesn't pre-filter by type at all.
- **Retry exists in code (`retryFile`) but is never wired into any component on this
  page** — a failed project upload has no retry UI whatsoever; if the original `File`
  object isn't in memory (e.g. after reload), retry is impossible even at the code level.
- Poll-timeout (~35 min) and "job not found" (404) both set store-level errors that are
  never surfaced on the Files page.

### 3.8 Visual polish

Overall: closer to a **raw file-manager retrofit onto shared design tokens** than a
deliberately calm workspace.
- **No empty-state illustration** anywhere live (ironically the *dead* `ProjectFileExplorer`
  has a dashed-border icon badge for its empty state — more polished than the code
  actually in use).
- **Chevron affordance mismatch** in the folder tree — implies expand/collapse, delivers
  neither (`folder-tree-pane.tsx:58`).
- **Errors are structurally invisible** — validation/upload errors are computed
  (`useProjectDocuments`'s `error`) but never rendered by `ProjectFileWorkspace`,
  `FolderTreePane`, `FileBrowserPane`, or `FilePreviewPane`. A user whose upload silently
  fails (oversized/wrong type/duplicate) gets **zero feedback**.
- `ProjectUppyUpload`'s name promises resumable/chunked/drag-drop upload UX it doesn't
  deliver — a naming/implementation trap for future maintainers.
- Dead code (`ProjectFileExplorer`, `ProjectUploadZone`) left in the tree, stylistically
  diverging from the live components and describing a superseded architecture.
- No i18n mismatches found within this specific slice (English-only, consistent).

---

## 4. How intake output reaches the agent, and how patches flow back

1. Intake's `PUT /api/projects/[id]/profile` persists `profile` (raw facts/goals),
   recomputes `profilePromptView` (a compact, agent-facing text projection — used to build
   the `X-Grid-Project-Context` header sent with chat/agent requests) and `profileDisplay`
   (the human-facing Overview projection), all via `src/lib/project-profile/prompt-view.ts`.
2. `POST /api/projects/[id]/generate-summary` (fired at the end of intake, §2.6) calls the
   Python backend to produce a narrative `summary`, merged into `profileDisplay` only —
   it does not touch `profilePromptView`/the agent-facing context.
3. In chat, the agent can propose changes via `ProjectProfilePatchCard`; accepting a patch
   goes through the same generic JSON-pointer engine (`applyProjectProfilePatch`) and
   triggers the same `profilePromptView`/`profileDisplay` rebuild + cache invalidation as
   intake's own PUT — so once a patch is accepted, the next agent turn's
   `X-Grid-Project-Context` reflects it immediately, even though the Overview page (a
   server component) won't visually reflect it until the user navigates back there.
4. Net effect: the "Project Brief" the architect sees on Overview and the
   `profilePromptView` text the agent sees are built from the **same underlying `profile`
   object** but by **two separate builder functions** with different fidelity — the
   agent-facing view is presumably more complete/structured, while the human-facing
   `profileDisplay` bottlenecks on the hardcoded `title`/empty `summary` until the async
   summary call lands (§1.2).

---

## Top 5 CX Opportunities in This Cluster

1. **Fix the broken intake re-entry loop.** `intake/page.tsx:29-31` redirects away from
   intake whenever a profile already exists, while Overview's "Edit brief"/"complete the
   brief" links explicitly promise re-entry. This is a functional bug, not a polish gap —
   architects currently cannot ever edit their Project Brief through the intake UI once
   it's been submitted once. Fixing this and turning intake into a genuine "edit mode"
   (pre-filled, resumable, not restricted to the original wizard order) is the single
   highest-leverage fix in this cluster.

2. **Make the Files page trustworthy by surfacing errors that already exist in state.**
   Upload validation errors, network failures on folder/file fetch, and preview failures
   are all computed today but rendered nowhere in the live component tree — a silent
   failure is the opposite of a "calm workspace" for compliance-critical documents. Wiring
   the existing `error` state into a visible banner/toast, plus a real per-file
   progress/retry affordance (the code for `retryFile`/`progress` already exists and is
   simply unused), would turn Files from a file-manager retrofit into a premium workspace
   with almost no new logic — just new rendering of state that's already tracked.

3. **Redesign the intake wizard as a guided, confidence-building moment, not a form dump.**
   Add stage transitions/motion, a stepper that shows which of the 5 stages are done vs.
   remaining (not just a percentage bar), inline field-level validation messages instead of
   a silently-disabled button, and — critically — a **review/confirm screen before Save &
   Finish** that shows the architect what GRID understood (using the same human-readable
   diff pattern already built for `ProjectProfilePatchCard`) before committing. This is the
   most natural "Apple-level" opportunity: intake is the architect's first deep interaction
   with the product's understanding of their building, and today it's indistinguishable
   from a generic multi-page settings form.

4. **Resolve the German/English terminology leakage in intake options** (`Wohnen`,
   `Beherbergung`, `Bauland`, `Bestand`/`Neubau`, age-bracket strings like `'< 10 Jahre'`)
   against English question labels. Either fully localize the wizard to German (matching
   the domain and audience) or translate the OIB/Bauordnung terms with a bilingual
   label/subtext pattern (`"Residential (Wohnen)"`) so it reads as an intentional,
   polished bilingual design rather than incomplete localization.

5. **Give Overview a reason to be visited more than once.** Today Overview shows three
   generic stats (file count, size, collection name), a Brief card that's often blank
   (hardcoded empty summary until an async job lands, or a silent gap when `keyFacts` is
   empty but a profile exists), and a Recent Files list with no compliance signal at all —
   despite Research and Members being sibling tabs, none of their state surfaces here.
   Turning Overview into a genuine orientation dashboard — real status color-coding (with
   one consistent token system instead of the three currently in play), a visible
   "profile completeness" indicator tied to `unknowns`, and at least a glance at
   Research/Members activity — would make it the natural home base the sidebar IA implies
   it should be, rather than a thin pass-through to the other tabs.
