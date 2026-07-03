# CX/UX Research 04 — Members, Settings (Theme), and Cross-Cutting UX Audit

Scope: `frontends/ui`. All findings are traced through actual code (imports followed, no
speculation). File:line references point at the state of the repo on 2026-07-03
(branch `develop`).

---

## 1. Members — entry points and branches

### 1.1 Entry

| Step | File:line | Detail |
|---|---|---|
| Sidebar nav item | `src/components/shell/app-sidebar.tsx:40` | `{ label: 'Members', segment: 'members', icon: Users }` — rendered for **every** signed-in user, regardless of role. No conditional hiding for non-admins. |
| Route | `src/app/projects/[id]/members/page.tsx:1-47` | Server component. |
| Session guard | `src/app/projects/[id]/members/page.tsx:17` → `requireAuthorizedSession()` (`src/lib/auth/require-auth.ts:18`) | Redirects to `/onboarding/organization` if the WorkOS session has no `organizationId`. |
| Permission guard | `src/app/projects/[id]/members/page.tsx:20` → `requireProjectAccess(session, id, 'project:manage')` | **Requires `project:manage`, not `project:view` or `project:edit`.** There is no partial/read-only view for editors or viewers — the page is admin-only, all-or-nothing. |
| Data | `page.tsx:22-23` | Reads only `projects.name` for the header; the actual roster comes from the client form via a separate fetch. |
| Render | `page.tsx:44` → `<ProjectMembersForm projectId={id} />` | Client component does all data loading/mutation. |

### 1.2 Non-admin branch — what actually happens

`requireProjectAccess` (`src/lib/authz/projects.ts:13-65`) throws a **plain `Error("Not found")`** (line 32, line 45) rather than calling Next's `notFound()`. There is **no `error.tsx` or `not-found.tsx` anywhere under `src/app`** (confirmed via full-tree search — zero matches for `error.tsx`, `not-found.tsx`, `global-error.tsx`). Consequences:

- A project-editor or project-viewer who clicks "Members" (visible to them in the sidebar per 1.1) hits an **unhandled server-component exception** rendered by Next.js's default error UI (dev overlay in dev; a bare framework 500 page in production) — not GRID's own chrome, not a styled "you don't have access" state.
- This is the single most user-visible gap in the whole audit: the nav invites a click that a majority of users (viewers/editors) cannot complete, and the failure is ungraceful.

### 1.3 API layer (`src/app/api/projects/[id]/members/route.ts`)

| Step | file:line | Detail |
|---|---|---|
| `GET` | `route.ts:44-109` | Also gated on `project:manage` (line 51) — consistent with the page gate, good. Cross-references WorkOS `listUsers`, `listOrganizationMemberships`, and 3x `listMembershipsForResourceByExternalId` (one per role) run in parallel via `Promise.all` (line 55-67), then reduced into a `role: null | 'project-viewer' | 'project-editor' | 'project-admin'` per member. |
| `POST` (assign/remove role) | `route.ts:111-175` | Same `project:manage` gate (line 118). Validates body with zod (`addMemberSchema`, line 30-36). Removes all existing role assignments for the membership then re-assigns the new one (or none, if `roleSlug === ''`) — effectively a "set role" operation, not additive. Errors caught and returned as JSON `{ error: message }` with the raw `error.message` from WorkOS leaking to the client (line 172) — could expose internal WorkOS error text to admins (low severity since admin-only, but not sanitized). |

### 1.4 Client form (`src/components/projects/project-members-form.tsx`)

| Step | file:line |
|---|---|
| Load roster | `:60-89` — `fetch` on mount, `isLoading` → skeleton, error caught into local `error` state |
| Search | `:44-46, 120-123` — client-side substring filter over name+email, backed by `useAppForm`/zod (over-engineered for a single text field, but consistent with the rest of the app's form library) |
| Role change | `:91-118` — optimistic-ish: sets `updatingId`, POSTs, updates local state on success, shows `Alert` on failure |
| Active count | `:125, 152-157` — `{activeCount}/{members.length}` badge |

### 1.5 States

| State | Implementation | Assessment |
|---|---|---|
| Loading | 3x `<Skeleton className="h-16" />` (`:127-135`) | Reasonable, matches row height. |
| Error (load) | Not surfaced as a distinct UI — `error` is set but the component still falls through to render the (empty) roster below; there's no `<Alert>` shown for the *load* failure, only for the *role-update* failure (`:177-182`). A failed initial load silently shows an empty member list with no message telling the admin why. **Bug-adjacent UX gap.** |
| Error (update) | `<Alert variant="destructive">` with title "Access update failed" (`:178-181`) — good, specific. |
| Empty (no roster) | Not handled — if `members` is empty the row list is simply blank (no dashed-border empty state at all, unlike the search-empty case). |
| Empty (search, no match) | Dashed-border card, heading + copy + "Clear search" button (`:237-252`) — the **best-crafted empty state found anywhere in the app** (heading, guidance, CTA). |
| Row hover | `hover:bg-accent/50 transition-colors` (`:190`) — subtle, on-brand. |
| Updating row | Text label "saving" next to the select while in flight (`:205-209`) — no spinner, easy to miss since it's plain uppercase micro-text at 10px equivalent. |

### 1.6 Edge cases

- Member with no WorkOS user record (`user` undefined) still renders using `organizationMembership.userId` as name/email fallback (`route.ts:99-103`) — defensive, good.
- Role sentinel `NO_ACCESS = 'none'` (`:42`) works around Radix `Select` disallowing empty string values — fine, but the mapping `value === NO_ACCESS ? '' : value` (`:213`) is easy to break if someone renames the sentinel without updating the call site; no test file found covering this component (`project-members-form.spec.tsx` does not exist — only `project-card.spec.tsx` exists in that directory).
- No pagination/virtualization — `listUsers`/`listOrganizationMemberships` are fetched without an explicit page-size parameter; on large orgs this page will silently truncate at whatever WorkOS SDK default is, with no "load more" affordance.
- No confirmation dialog before revoking a member's access (setting to "No project access") — a single-click destructive action with no undo, unlike typical admin patterns of a confirm step for removal.

### 1.7 Current UX summary

Functional and secure (permission checks are correctly enforced server-side in both the page and the API), but:
- Nav item is shown to users who cannot access the page → broken/ungraceful failure (no error boundary at all in the app).
- No read-only view for editors/viewers to see the roster (even non-actionable) — "members" is invisible to majority of users despite being in their nav.
- Load-failure state is silently swallowed.
- No empty state for a genuinely empty roster; no destructive-action confirmation.

### 1.8 Premium opportunities

1. Add `src/app/projects/[id]/error.tsx` (and ideally a root one) so any `requireProjectAccess` throw renders a branded "You don't have access" card instead of a framework crash page — the single highest-leverage members fix.
2. Only render the "Members" sidebar item when the user's role is admin (or show it but disabled/tooltip-explained) — avoids the dead-end click entirely.
3. Read-only roster view for editors/viewers (no role selects, just names+roles) so non-admins get parity/visibility.
4. Surface load failures with the same `<Alert>` pattern already built for update failures — a two-line fix.
5. Add a lightweight confirm (or "Undo" toast) before revoking access.
6. Bulk-invite via email (currently the flow only assigns roles to *existing* organization members — there's no "invite by email" input at all in this form, contrary to the task's assumption; inviting new people into the org happens elsewhere, likely via WorkOS's own invite flow, not in this screen). Worth calling out: **there is no in-app "invite by email" UI in `project-members-form.tsx`** — it only reassigns roles among org members already known to WorkOS.

---

## 2. Settings / Theme

There is no dedicated "Settings" page in the app (no `src/app/settings` route found). The only user-facing preference control is **theme**, folded into the sidebar user menu.

| Step | file:line |
|---|---|
| Control | `src/components/shell/sidebar-user-menu.tsx:34-38, 76-83` — dropdown with System/Light/Dark (`Monitor`/`Sun`/`Moon` icons from lucide), checkmark on active mode |
| State | `src/features/layout/store.ts:29` (`theme: 'system'` initial), `:82` (`setTheme`) — plain Zustand store, **no `persist` middleware** (only `devtools` is applied, `:39-41`). |
| Effect | `src/app/providers.tsx:41-76` (`useThemeEffect`) — toggles `.nv-light`/`.nv-dark` on `document.documentElement`; for `'system'` it also subscribes to `matchMedia('(prefers-color-scheme: dark)')` and live-updates on OS theme change (`:63-70`), cleaned up on unmount. Deferred one tick past mount (`mounted` state) to avoid SSR/hydration flash (`:44-47`). |
| Token wiring | `src/styles/tokens.css:27-152` — `:root` (light) and `.nv-dark` blocks define both the shadcn vocabulary (`--background`, `--primary`, …) and a legacy "KUI" vocabulary (`--text-color-*`, `--background-color-*`, `--border-color-*`), all in OKLCH. `.nv-dark` is bound to Tailwind's `dark:` variant via `@custom-variant` in `globals.css` (per the file's own header comment, `tokens.css:21-24`). |

**Finding — theme does not persist.** Because the layout store has no `persist` middleware and no `localStorage` read/write anywhere in `store.ts`, a user's explicit Light/Dark choice is **lost on every full page reload / new tab**, silently falling back to `'system'`. This will read as a bug ("I picked dark mode and it reset") even though it's a deliberate-looking but incomplete implementation. This is the top settings-related fix.

There is no other settings surface (no notification prefs, no account/profile page, no organization-level settings UI found under `src/app`) — "Settings" in this app is effectively just this one theme menu plus the Members/access-matrix page covered above.

---

## 3. Cross-cutting audit

### 3.1 Loading states

| Pattern | Where | Example |
|---|---|---|
| Skeleton | `src/components/ui/skeleton.tsx`; used in `project-members-form.tsx:127-135`, `research-runs-list.tsx`, `project-intake-wizard.tsx`, `file-preview-pane.tsx`, `folder-tree-pane.tsx`, `file-browser-pane.tsx` | Most "list/roster" surfaces use skeleton rows sized to match real content — good pattern where used. |
| Spinner | `src/components/ui/spinner.tsx`; used in `AgentResponse.tsx`, `FileUploadZone.tsx`, `FileSourcesTab.tsx` (explicit comment "always show the spinner — never flash 'No Files' during transitions," `FileSourcesTab.tsx:250`) | Thoughtful about avoiding flash-of-empty-state in that one spot, but inconsistent — most other lists use skeleton instead. |
| Plain text ("saving"/"loading…") | `project-members-form.tsx:205-209` (uppercase micro-copy, no spinner) | Weakest of the three loading idioms — easy to miss, no motion. |

**Consistency verdict:** three different idioms (skeleton / spinner / text) are each used correctly in isolation but there's no single rule for which surface gets which — a new contributor has no guidance on when to reach for which one.

### 3.2 Empty states

Surveyed ~20 empty-state strings across the app (`document-list.tsx:46`, `file-browser-pane.tsx:53,75`, `AgentsTab.tsx:78`, `DataConnectionsTab.tsx:89`, `DataSourcesPanel.tsx:268`, `FileSourcesTab.tsx:275`, `SessionsPanel.tsx:271`, `ThinkingTab.tsx:131-132`, `ThoughtTracesTab.tsx:54`, `ToolCallsTab.tsx:59`, `FilesTab.tsx:49`, `app/projects/page.tsx:75`, etc.). The overwhelming majority are **a single `<p className="text-sm text-muted-foreground">` line, no icon, no illustration, no CTA** — e.g. `ToolCallsTab.tsx:59`: `"No tool calls available."` Only two exceptions were found with real craft:

- `project-overview.tsx:157-166` — dashed border, message + "Upload Files" CTA button.
- `project-members-form.tsx:237-252` — heading + message + "Clear search" CTA.

**Consistency verdict:** empty states are bare by default; the two good examples are proof the pattern exists but isn't systematized into a shared `<EmptyState>` component (none was found — no file named `empty-state.tsx` anywhere).

### 3.3 Error states

- `sonner`'s `Toaster` is mounted globally in `src/app/providers.tsx:24,204` and wrapped in `src/components/ui/sonner.tsx`, but **`toast()`/`toast.error()`/`toast.success()` is never called anywhere in `src/`** (grepped for `from 'sonner'` → only the two setup files; grepped for `toast(`/`toast.error(` etc. → zero call sites). The toaster is dead infrastructure.
- All real error surfacing found instead uses inline `<Alert variant="destructive">` (9 files: `InputArea.tsx`, `research-runs-list.tsx`, `ExportFooter.tsx`, `FileSourcesTab.tsx`, `create-project-form.tsx`, `project-intake-wizard.tsx`, `project-members-form.tsx`, `app/auth/error/page.tsx`, `onboarding/organization/page.tsx`). This is at least a consistent single idiom for the surfaces that do show errors.
- But many async failures are only `console.error`'d with no user-visible state at all — e.g. the members-load failure noted in §1.5, and the WorkOS `POST` error message is passed through raw to the client (`route.ts:172-173`) rather than a friendly copy.
- **No app-wide error boundary** (§1.2) — any unhandled server-component throw (which is the pattern `requireProjectAccess` uses everywhere permission is checked, not just Members) falls through to Next's default error page across the *entire* app, not just Members.

### 3.4 Dark mode / hardcoded colors

Token system (`tokens.css`) is well-designed — OKLCH values, parallel light/dark blocks, and even feedback-severity tokens (`--text-color-feedback-warning`, `--background-color-feedback-warning-subtle`, `--border-color-feedback-warning`, etc., `tokens.css:66,81,90` and dark equivalents `:126,141,150`). Despite that, concrete hardcoded-color leaks were found that bypass the tokens and hand-roll `dark:` variants instead:

| File:line | Leak |
|---|---|
| `src/features/layout/components/FileSourceCard.tsx:239` | `expiryLabel.expired ? 'text-warning' : 'text-orange-400'` — mixes a token (`text-warning`) with a raw Tailwind color (`text-orange-400`) in the same ternary. |
| `src/features/layout/components/ReportTab.tsx:65-67` | `border-yellow-200 bg-yellow-50 ... dark:border-yellow-800 dark:bg-yellow-950`, `bg-yellow-500`, `text-yellow-700 dark:text-yellow-300` — a full hand-rolled warning banner duplicating what `--background-color-feedback-warning-subtle` / `--border-color-feedback-warning` already provide. |
| `src/features/layout/components/TasksTab.tsx:83-85` | Same pattern with `blue-50/950/500/700/300` for an "info" banner, duplicating `--background-color-feedback-info-subtle`. |

These three are the clearest offenders (raw Tailwind color + `dark:` variant pairs) found via targeted search; `kui-generated.css` also contains legacy raw color rules but that file is explicitly being phased out per the `tokens.css` header comment (`:16-19`), so it's known debt rather than a new leak.

### 3.5 Responsive / mobile

- `min-w-[768px]` is still present and load-bearing: `src/features/layout/components/MainLayout.tsx:153` — `<div className="flex min-h-0 min-w-[768px] flex-1 flex-col overflow-x-auto overflow-y-hidden">`. Below 768px the chat column simply gets a horizontal scrollbar (`overflow-x-auto`) rather than reflowing — i.e. the chat UI is not usable on a phone-width viewport, by design.
- The sidebar (`app-sidebar.tsx`) has **no responsive/mobile behavior at all** — no `Sheet`/drawer fallback, no `md:hidden`/`useMediaQuery`/`isMobile` logic found anywhere under `src/components/shell` (explicit grep came back empty). It's a fixed-width persistent rail assuming desktop.
- Net effect: GRID is a desktop-only tool today; this is presumably an accepted product decision (architects at a workstation), but it's worth stating plainly since it constrains anything "premium" done in isolation — no amount of responsive polish elsewhere matters while the shell itself doesn't flex.

### 3.6 Motion

- `transition-`/`duration-`/`ease-`/`animate-` utilities appear in 49 files (326 occurrences) — motion is present almost everywhere, not absent.
- A `useReducedMotion` hook exists and is wired into `MainLayout.tsx:21`, and `motion-reduce:animate-none` is applied to the pulse dots in `ReportTab.tsx:66` / `TasksTab.tsx:84` — accessibility-conscious pattern, good.
- Row hover (`project-members-form.tsx:190`), dropdown/menu transitions (shadcn defaults in `dropdown-menu.tsx`, `select.tsx`, `dialog.tsx`) are all standard shadcn easing — nothing jarring observed. No evidence of over-the-top entrance animation; if anything the app leans conservative/quiet, consistent with the "understated, premium, minimalist" design intent stated in `tokens.css:7-9`.

### 3.7 Accessibility

- `focus-visible`/`focus:ring`/`outline-none` patterns appear in 21 files — concentrated mostly in the shadcn primitives (`button.tsx`, `input.tsx`, `select.tsx`, `switch.tsx`, `checkbox.tsx`, `dialog.tsx`, `tabs.tsx`) plus a few app components (`sidebar-user-menu.tsx:53`, `app-sidebar.tsx`, `AppBar.tsx`). Baseline coverage looks reasonable since it rides on shadcn's built-in focus styling, but custom one-off interactive elements (e.g. the plain "saving" text label, or any `<div onClick>` patterns not audited exhaustively here) should be spot-checked further — this pass did not do a full aria-label/role inventory per interactive element, only searched for focus-ring presence.
- `aria-label` is used deliberately for icon-only or ambiguous controls: `project-members-form.tsx:169` (search input), `:218` (per-row role select), `sidebar-user-menu.tsx:55` (user menu trigger) — good practice, present where it matters.
- Heading hierarchy on Members page: `h1` (`page.tsx:35`) → `h2` (`project-members-form.tsx:146`) → `h3` (`:239`, empty state) — correctly nested, no skipped levels found in this flow.

### 3.8 Typography & spacing

- Type ramp is coherent within a screen (`text-2xl font-semibold tracking-tight` for page titles, e.g. `members/page.tsx:35`; `text-sm font-semibold` for section headers, e.g. `project-members-form.tsx:146`; `text-xs uppercase tracking-[0.24em]` for eyebrow/kicker labels, `members/page.tsx:32`) but the eyebrow tracking value (`0.24em`) is a one-off inline arbitrary value rather than a named utility/token — if another screen wants the same "kicker" treatment it has to be re-typed by hand (no shared `Kicker`/`Eyebrow` component found).
- Spacing rhythm (`gap-3`, `gap-4`, `gap-6`, `p-4`, `p-5`, `p-8`) is drawn from Tailwind's default scale consistently — no arbitrary pixel paddings observed in the files read for this report, which is good; the risk is more in ad hoc component-level judgment calls (`p-5` here, `p-4` there) than in raw hardcoded values.

### 3.9 Microcopy tone

- All UI copy read is English, professional, and free of leftover German or emoji (explicit search for common German UI words — `keine`, `bitte`, `löschen`, `Fehler`, `Einstellungen`, `hinzufügen`, `speichern` — and for emoji ranges returned zero matches across `src/**/*.tsx`).
- Tone is consistent and calm/direct across the surfaces read: "No files yet. Upload your first document to get started." (`project-overview.tsx:160`), "Add organization members to this project by assigning a project role. Set no access to remove them from this workspace." (`members/page.tsx:38-41`), "The report has expired and is no longer available." (`DeepResearchBanner.tsx:115`). No jarring register shifts found.

---

## 4. Prioritized systemic fixes (for a "raise the whole app to premium" pass)

| # | Fix | Why it's systemic |
|---|---|---|
| 1 | Add `error.tsx`/`not-found.tsx` boundaries (at minimum `src/app/error.tsx` + one under `src/app/projects/[id]`) | `requireProjectAccess`/`requireAuthorizedSession` throw plain `Error`s in *every* project route, not just Members — right now every permission denial or unexpected failure anywhere in the app surfaces Next's default crash page. |
| 2 | Build one shared `<EmptyState icon/title/description/action>` component and migrate the ~20 bare one-liners onto it | Empty states are the single most repeated pattern in the app and are currently ad hoc/bare everywhere except two screens. |
| 3 | Either wire up `toast()` for transient/global errors or remove the unused `<Toaster/>` | Dead infrastructure plus silent failures (e.g. members-load error, §1.5) mean some errors have no user-visible state at all. |
| 4 | Persist theme choice (add `persist` middleware / localStorage to the layout store) | A user's explicit Light/Dark pick is lost on every reload — reads as a bug, undermines trust in a "premium" product. |
| 5 | Replace the raw `yellow-*`/`blue-*`/`orange-400` Tailwind+`dark:` pairs (`ReportTab.tsx:65-67`, `TasksTab.tsx:83-85`, `FileSourceCard.tsx:239`) with the existing `--*-feedback-warning/info` tokens | Token system already supports this; leaving raw colors in place is pure inconsistency and a dark-mode maintenance risk. |
| 6 | Gate the "Members" sidebar entry (or the nav item generally) by the user's actual project role, and/or give editors/viewers a read-only roster | Currently every user sees a nav item that most of them cannot open; this is the most visible single symptom of the missing-error-boundary problem and worth fixing at the source (don't invite the dead-end click) in addition to fixing the crash itself. |

---

### Key files referenced
- `F:\GRID\grid-oib-agent\frontends\ui\src\app\projects\[id]\members\page.tsx`
- `F:\GRID\grid-oib-agent\frontends\ui\src\components\projects\project-members-form.tsx`
- `F:\GRID\grid-oib-agent\frontends\ui\src\app\api\projects\[id]\members\route.ts`
- `F:\GRID\grid-oib-agent\frontends\ui\src\lib\authz\projects.ts`
- `F:\GRID\grid-oib-agent\frontends\ui\src\lib\auth\require-auth.ts`
- `F:\GRID\grid-oib-agent\frontends\ui\src\components\shell\sidebar-user-menu.tsx`
- `F:\GRID\grid-oib-agent\frontends\ui\src\components\shell\app-sidebar.tsx`
- `F:\GRID\grid-oib-agent\frontends\ui\src\app\providers.tsx`
- `F:\GRID\grid-oib-agent\frontends\ui\src\features\layout\store.ts`
- `F:\GRID\grid-oib-agent\frontends\ui\src\styles\tokens.css`
- `F:\GRID\grid-oib-agent\frontends\ui\src\features\layout\components\MainLayout.tsx`
- `F:\GRID\grid-oib-agent\frontends\ui\src\features\layout\components\ReportTab.tsx`
- `F:\GRID\grid-oib-agent\frontends\ui\src\features\layout\components\TasksTab.tsx`
- `F:\GRID\grid-oib-agent\frontends\ui\src\features\layout\components\FileSourceCard.tsx`
