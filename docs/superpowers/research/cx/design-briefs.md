# Per-Journey Design Briefs

Consolidated from the four CX investigations (cx-01..04). Every redesign follows `grid-design-language.md` and reuses the shared `EmptyState` (`@/components/ui/empty-state`), `StatusScreen`, Badge/Alert/sonner. Fix the functional bugs AND raise the visual craft — both, per journey.

Shared foundation already built: EmptyState, StatusScreen + app/error.tsx + app/not-found.tsx, theme persistence, Badge `info` variant, the sidebar shell (AppSidebar/ProjectSwitcher/SidebarUserMenu).

---

## Journey 1 — Entry & org shell (`/`, `/projects`, `/onboarding`, project create/select, shell)

**Fixes**
- `/projects` and `/onboarding` still use the old `AppShell`/`GlobalTopNav`. Replace with a lightweight **org-level top frame** (new component in `components/shell`, e.g. `OrgTopbar`: Grid logo, optional "Projects" heading, user menu + theme reusing `SidebarUserMenu`). Stop importing `AppShell` from features/layout. This ends the "two competing shells" problem. Leave features/layout's AppShell/GlobalTopNav orphaned (a later cleanup removes them).
- Create-project error alert leaks raw backend exception text (`actions.ts`) — show a friendly message, log the raw.
- Project cards show the internal `collectionName` (`proj_<uuid>`) — remove it from the card face.
- Onboarding copy names "WorkOS" to end users — reword to product language ("your organization").
- Wire `/projects?new=1` to auto-open the create dialog (the ProjectSwitcher "New project" item already links there).
- `ProjectSwitcher` has a built-but-unused `collapsed` prop — either use it (collapsible sidebar) or drop it; don't ship dead props.

**Premium**
- `/projects` list: a calm, confident workspace index — project cards with name, a one-line brief/summary, doc count + last-activity, status; crafted `EmptyState` for zero projects that introduces GRID and invites the first project (mention OIB/RIS grounding). Consider OIB/RIS **project templates** at creation (e.g. "Neubau Wohnbau", "Betriebsbau Brandschutz") as a first-run accelerator.
- Onboarding: a real "workspace ready" success beat before dropping into an empty projects list.
- Create-project as a shadcn `Dialog` with the TanStack form, not a bare inline form.

## Journey 2 — Workspace: Overview + Intake (`/projects/[id]`, `/intake`)

**Fixes (some are real bugs)**
- **Intake re-entry is broken**: `intake/page.tsx` redirects away when a profile already exists, so Overview's "Edit brief" links are dead ends. Allow re-entry in edit mode, prefilled from the existing profile.
- Intake option values leak German under English labels (`Wohnen`, `Neubau`, `< 10 Jahre`, …) — localize consistently (UI English; keep domain terms only where they're the real term, with clear labels).
- `buildProfileFromAnswers` never populates `profile.unknowns` and partially reimplements the JSON-pointer engine in `prompt-view.ts` — reconcile so the Brief's "what Grid still doesn't know" is accurate.
- Overview Brief card can render blank (empty summary/keyFacts) with no fallback — always show a useful state.

**Premium**
- Overview = the architect's cockpit: Project Brief as an authoritative fact sheet (already reworked — refine), meaningful stats, recent files, and a signal from Research/Members (e.g. "2 research runs", member avatars). Give a reason to return.
- Intake wizard = a guided, delightful moment, not a form dump: a real stepper with progress, smooth stage transitions, inline validation, and a **review/confirm** screen before finish (reuse the human-readable diff idea from `ProjectProfilePatchCard`). Autosave indicator stays.

## Journey 3 — Files (`/projects/[id]/files`, features/documents)

**Fixes**
- Upload/validation/network errors are computed in `use-file-upload.ts` but never rendered — surface them (inline + toast), wire the existing retry + progress-percentage code.
- Delete two dead components describing a superseded architecture: `project-file-explorer.tsx`, `project-upload-zone.tsx` (confirm no live imports first).
- Color-semantics bug: status `uploaded` shows green in one place, yellow in another — unify on the token map (ready/uploaded=success, ingesting/pending=info, failed=destructive).

**Premium**
- A calm document workspace, not a table dump: folder tree + file list + preview that feels like a considered three-pane workspace; clear per-file status with the right Badge; a crafted `EmptyState` inviting the first upload (why it matters: grounds Grid's answers). Upload target (project corpus vs private session) should be obvious and reassuring.

## Journey 4 — Chat surface (features/layout, features/chat, features/grid-cards, chat route)

This is the core value surface and the biggest job. Read cx-03 fully.

**Fixes**
- `CitationCard` drops the captured excerpt and shows only a bare domain; a richer `SourceCard` (title + snippet) already exists unused — wire it in / unify.
- Research panel hardcodes chat to 40%, auto-opens on job start, and disables chat input for the whole run — rebalance so the panel informs without displacing chat; let users collapse it; don't fully lock input.
- Inconsistent badge vocab across tabs ("N running" vs "N active" vs counts) and a raw `Job ID: …` string leak in user copy — normalize.
- Delete confirmations never name the item — name it.
- Hardcoded color leaks: `ReportTab.tsx`, `TasksTab.tsx` (yellow-/blue- + manual dark:), `FileSourceCard.tsx` (text-orange-400) — replace with tokens/Badge variants.
- Toast infra is mounted but unused and some failures are swallowed — use `sonner` for transient failures (send error, cancel failure, etc.).

**Premium**
- **LegalBasisCard is the hero** — the product's proof-of-work. Make it an authoritative citation: quiet distinct card, thin left accent (`border-l-2 border-l-primary/40`), law/Richtlinie + §/article in a header (`font-mono` refs), the cited excerpt as a real blockquote at a readable measure, plain-language summary, and (if resolvable) a link to the source OIB document. It should read like a legal citation, not a chat bubble.
- Deep-research progress: legible over noisy — a calm task checklist as the primary signal; thinking/tools/files as secondary. Watching it should feel like a competent analyst working.
- Message stream, thinking steps, and cards should have a consistent, quiet rhythm with subtle entrance motion.

## Journey 5 — Research runs & Members (`/research`, `/members`)

**Fixes**
- Research "View report" links to `?job=<id>` which nothing reads — make it real: either deep-link the chat research panel to that job (preferred) or open the report. Coordinate with Journey 4's job-load flow.
- Members page requires `project:manage`; combined with the missing boundary it hard-crashes for editors/viewers. Add a read-only fallback (show members, hide management controls) and have the sidebar hide/disable the Members nav item when the user lacks access (pass role/permission from the layout to AppSidebar).
- Members-load failure sets error state that's never rendered — surface it (Alert + toast).

**Premium**
- Research runs: a clean run history — status, when, duration, a strong "View report" affordance; crafted empty state pointing to Chat. 
- Members: calm roster with avatars, role controls (admin only), pending invites; invite as a considered form (TanStack). Read-only viewers see a dignified roster, not a crash.
