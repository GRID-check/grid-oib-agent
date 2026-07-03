# CX Research 01 — Entry, Auth, Onboarding, Project Lifecycle

Scope: GRID frontend (`frontends/ui`), traced from actual source. GRID is an OIB/RIS
building-compliance copilot for Austrian architects; the unit of work is a "project"
(building project). Auth is WorkOS AuthKit, toggled by `REQUIRE_AUTH`. The app is
mid-migration from a global top-nav (`AppShell` + `GlobalTopNav`) to a project-centric
sidebar shell (`src/components/shell/*`).

---

## 0. Architectural finding that frames everything below

There are **two competing navigation shells alive in the app at once**:

1. **Old / global shell**: `AppShell` (`src/features/layout/components/AppShell.tsx:13`) →
   `GlobalTopNav` (`src/features/layout/components/GlobalTopNav.tsx:28`). Used by
   `src/app/projects/page.tsx:24` (the projects list). Has a pill nav ("Chat" / "Projects"),
   a legacy `ProjectSelector` dropdown (`src/components/projects/project-selector.tsx:27`),
   and a popover-based user/theme menu.
2. **New / project shell**: `AppSidebar` (`src/components/shell/app-sidebar.tsx:50`) →
   `ProjectSwitcher` + `SidebarUserMenu`. Used by `src/app/projects/[id]/layout.tsx:32`,
   i.e. every page *inside* a project (Overview/Chat/Files/Research/Members).

**Consequence for the user**: clicking "Create project" → redirect into `/projects/[id]`
swaps the entire chrome. The top pill nav, the docs link, the "Sign In"/avatar popover
all disappear and are replaced by a left rail with different iconography and menu
structure. There is no shared header, no shared logo treatment (`GridLogo` in the old
shell vs. plain uppercase "Grid" text link in the new one), and the theme picker exists
in *both* places independently (`AppearanceThemeControl` in `GlobalTopNav.tsx:134` vs.
`THEME_OPTIONS` in `sidebar-user-menu.tsx:34`). This is the single biggest structural
inconsistency in the entry/onboarding/lifecycle cluster and should be resolved before
any visual polish pass, since polishing either shell independently just deepens the
split.

---

## 1. `/` — Home (`src/app/page.tsx`)

### Entry points & branches

| State | Condition | Behavior |
|---|---|---|
| Loading | `isLoading` true (WorkOS session resolving) | `MainLayout` renders with `isAuthenticated=false` default while redirect effect is still pending (file:line `page.tsx:19-26`) — see gap below |
| Authenticated | `isAuthenticated && !isLoading` | `useEffect` fires `router.replace('/projects')` (`page.tsx:22-26`), component returns `null` while navigating (`page.tsx:28-30`) |
| Anonymous, auth required | `isAuthenticated` false, `authRequired` true | Renders `MainLayout` with a sign-in affordance (`onSignIn` wired to `signIn` from `useAuth`) |
| Anonymous, auth disabled (`REQUIRE_AUTH=false`) | `useAuth()` short-circuits (`use-auth.ts:73-87`) and always returns `isAuthenticated: true` with a `DEFAULT_USER` | Home page believes user is "authenticated" and redirects straight to `/projects` even though no real session exists |

### Step-by-step (authed path)
1. `HomePage` (`page.tsx:40`) wraps `HomeContent` in `Suspense` (needed only because `MainLayout`/children use `useSearchParams` transitively).
2. `HomeContent` (`page.tsx:18`) calls `useAuth()` (`src/adapters/auth/use-auth.ts:39`), which wraps WorkOS AuthKit's `useAuth`/`useAccessToken`.
3. Effect redirects to `/projects` once both `isAuthenticated` and not `isLoading`.
4. Because the redirect is client-side (`'use client'` at `page.tsx:11`) there is a visible flash: the anonymous `MainLayout` (full chat welcome screen) can paint for one frame before the redirect fires, since `isAuthenticated` starts `false` during the WorkOS token fetch. There is no top-level loading skeleton or spinner gating this — contrast with `auth/error` which explicitly shows a `Spinner` while `authRequired` is being resolved.

### Anonymous behavior
- Renders `MainLayout` (`src/features/layout/components/MainLayout.tsx`) directly — the full chat/research experience, unauthenticated. `ChatArea` renders a `WelcomeState` (`ChatArea.tsx:131,338`) that only guards CTA behind `isAuthenticated` at the point of *sending* a message, not before. So an anonymous user gets the entire product chrome (research panel, data sources, chat composer) before ever being told this is a login-gated, per-project tool.

### States
| State | Visual | File |
|---|---|---|
| Loading (session resolving) | No dedicated skeleton; anonymous `MainLayout` may flash | `page.tsx:18-30` |
| Authenticated | blank (`null`) while redirecting | `page.tsx:28-30` |
| Anonymous + auth required | Full `MainLayout`, `WelcomeState` prompts sign-in only on send | `MainLayout.tsx:171`, `ChatArea.tsx:131` |
| Auth disabled | Same as "authenticated", instant redirect | `use-auth.ts:73-87` |

### CX gaps
- No first-run marketing/positioning surface for a brand-new visitor — home is just the chat app in disguise. For a compliance copilot with a real value prop (OIB/RIS corpus, project files, member workspace), landing straight into an empty chat composer undersells it.
- The authenticated redirect has no loading state — a logged-in user should see an immediate branded loading screen ("Grid" wordmark + spinner) rather than a flash of anonymous chat UI, then blank, then `/projects`.
- No distinction communicated between "anonymous session" and "signed in, no org yet" and "signed in, has org" at the entry point — that logic only lives deep in `requireAuthorizedSession()`.

---

## 2. `/auth/error` (`src/app/auth/error/page.tsx`)

### Branches
| Condition | Behavior |
|---|---|
| `authRequired` false | Redirect to `/` after mount (`auth/error/page.tsx:40-44`), shows `Spinner` labeled "Redirecting..." meanwhile |
| `authRequired` true, known error code (`Configuration`, `AccessDenied`, `Verification`) | Maps to friendly copy via `errorMessages` (`page.tsx:22-27`) |
| `authRequired` true, unknown/missing `error` query param | Falls back to `Default` message: "An error occurred during authentication." |

### UX
- Centered `Card` on `bg-muted`, `AlertTriangle` destructive `Alert`, two buttons: "Try Again" and "Go Home" — both just `window.location.href = '/'` (`page.tsx:56,60`), i.e. identical behavior with two labels. This is a dead-end disguised as a choice: neither button retries the specific auth action that failed (e.g. re-invoking WorkOS sign-in), they both just reload `/`.
- No link to support/docs, no error code shown to the user for support tickets, no distinction for the architect persona (e.g. "contact your workspace admin" for `AccessDenied`, which is plausible in a multi-seat B2B org context).

### CX gaps / premium opportunities
- Collapse "Try Again" vs "Go Home" into one primary action, or make "Try Again" actually re-trigger `signIn()` from `useAuth`.
- Show the raw `error` code in a monospace caption for support correlation (architects will screenshot this and email IT).
- `AccessDenied` in a B2B compliance tool likely means "your org admin hasn't granted you project access" — worth a differentiated message with a mailto/support CTA rather than the generic default.

---

## 3. `/onboarding/organization` (`src/app/onboarding/organization/page.tsx`)

### Entry
Reached exclusively via server-side redirect from `requireAuthorizedSession()` (`src/lib/auth/require-auth.ts:18-26`): any authenticated user whose session has no `organizationId` is redirected here from **every** protected route (`/projects`, `/projects/[id]/*`). This is the only gate for "has-org vs no-org."

### Step-by-step
1. `useAppForm` (TanStack Form wrapper, `page.tsx:33-56`) with Zod schema requiring non-empty trimmed `name` (`page.tsx:25-27`).
2. On submit: `POST /api/organizations` with `{ name }` (`page.tsx:40-44`).
3. Success → `router.replace('/')` (`page.tsx:51`) — which re-enters the home page logic (§1), re-resolves auth, and (assuming the new org now has an `organizationId`) redirects again to `/projects`. That's two client-side redirects (`/onboarding/organization` → `/` → `/projects`) to land the user in their new workspace, each a network+render round trip.
4. Failure → inline `Alert` with `error` state (`page.tsx:104-109`), form remains filled, user can retry.

### States
| State | Visual |
|---|---|
| Empty/initial | Empty text field, autofocus (`page.tsx:126`) |
| Validating | Zod `onChange` validator, presumably inline field error (rendered inside `field.TextField`, not shown in this file) |
| Submitting | `form.SubmitButton` presumably shows its own busy state (component not inspected in this file) |
| Error | Destructive `Alert` "Organization setup failed" + message (`page.tsx:104-109`) |
| Success | No success state shown at all — page immediately navigates away (`page.tsx:51`) |

### Visual state (current)
This is the most visually developed page in the cluster: split hero layout, `StarfieldAnimation` decorative canvas (`page.tsx:60-62`), large serif-adjacent display headline, a 3-icon feature strip (Lock/Users/Folder), and a card with a checklist of what will happen ("Create WorkOS organization," "Attach current user as admin," "Refresh session and enter Grid," `page.tsx:137-144`). It reads as the one screen someone clearly designed with intent.

### CX gaps / premium opportunities
- **No success/transition state.** After a multi-step backend operation (create org → assign admin → refresh session), the user is silently yanked through two redirects. A brief success confirmation (checkmarks animating through the "what will happen" list, then a fade to `/projects`) would make the multi-step nature of org creation feel deliberate rather than like a random double-navigation.
- **Redirect indirection**: go straight to `/projects` (or wherever the new session should land) instead of bouncing through `/` — removes a full page load and the risk of the home-page flash described in §1.
- **No named default/skip path.** Every authenticated user must create an org before doing anything — there's no "join an existing organization" flow visible (no invite-code field, no "your teammate already created one" messaging), which is a real gap for a multi-seat B2B tool where the common case is often *joining* not *founding*.
- **No back door.** If an architect got here by mistake (e.g. shared workspace, wrong account), there is no sign-out or "use a different account" link on this screen — they're stuck unless they know to find sign-out elsewhere.
- The checklist ("Create WorkOS organization" etc.) is written in system/implementation language, not user language — "WorkOS" is an internal auth vendor name leaking into end-user copy for Austrian architects who have no reason to know what WorkOS is.

---

## 4. `/projects` — Projects list (`src/app/projects/page.tsx`)

### Entry & data
1. `requireAuthorizedSession()` gate (`page.tsx:14`) — redirects to onboarding if no org (see §3), or to WorkOS sign-in further upstream if no session (inside `requireGridSession`, not fully traced here).
2. Server component queries all projects for `session.organizationId`, ordered by `createdAt` ascending (`page.tsx:17-21`).
3. Wrapped in the **old shell** `AppShell` (`page.tsx:24`) — see §0 architecture note.

### Layout
- Header: eyebrow label "Architecture project OS," H1 "Run every building project from one calm workspace," descriptive paragraph, and a stat card showing `{rows.length}` "active" projects + a static "OIB / corpus" tile (`page.tsx:26-49`).
- Two-column body: sticky `CreateProjectForm` card on the left (`page.tsx:52-67`), project grid or empty state on the right (`page.tsx:69-88`).

### States
| State | Condition | Visual |
|---|---|---|
| Empty | `rows.length === 0` | Dashed-border panel, `FolderOpen` icon, "No project has been staged yet" + guidance pointing at the form on the left (`page.tsx:70-81`) |
| Populated | `rows.length > 0` | Responsive grid of `ProjectCard` (1 col → 2 col at `xl`) (`page.tsx:83-87`) |
| Loading | none — this is a server component; Next's default route-level `loading.tsx` is not present anywhere in `src/app` (confirmed via glob) | Whatever Next's default blank/streaming behavior is; no branded skeleton |
| Error (DB/query failure) | none — no `error.tsx` anywhere in `src/app` (confirmed via glob); an exception here renders Next's default error boundary | Ungraceful |

### CX gaps / premium opportunities
- **No `loading.tsx` or `error.tsx` anywhere in the route tree.** For a server component doing a DB query, any transient DB latency or failure surfaces as either a blank flash or Next.js's default unstyled error page — a hard floor under an otherwise polished visual language.
- The "stat card" (active count + static "OIB corpus" tile) is decorative filler — "OIB" as a stat tile communicates nothing actionable to a first-time user and reads as a placeholder that never got finished.
- Create-form and empty-state are co-located and redundant: the empty state literally says "Create the first workspace on the left," which is good microcopy discipline, but the create form itself has no visual distinction for "this is your very first project" vs. the 50th — no onboarding checklist, no suggested naming pattern beyond placeholder text, no project templates (e.g. "New building," "Renovation review," "OIB fire safety audit" preset kinds), despite the domain clearly having recognizable project archetypes.
- `ProjectCard` (`src/components/projects/project-card.tsx:16`) shows raw internal `project.collectionName` (e.g. `proj_<uuid>`) as user-facing text (`project-card.tsx:36`) — an internal identifier leaking into the UI, monospace or not.
- No sorting/filtering/search once project count grows — `orderBy(asc(projects.createdAt))` (`page.tsx:21`) is a fixed, oldest-first order with no way to change it in the UI at all.
- No project archiving/deletion path visible anywhere in this cluster.

---

## 5. `CreateProjectForm` + `createProject` server action

### Files
- `src/components/projects/create-project-form.tsx:20`
- `src/app/projects/actions.ts:18`

### Step-by-step
1. TanStack Form (`useAppForm`) with Zod validation (1–255 chars, trimmed) (`create-project-form.tsx:12-18,23-26`).
2. `onSubmit` builds a `FormData` and calls the server action directly as a function (not via `<form action=...>`), passing `{}` as `_prevState` (`create-project-form.tsx:26-34`) — this bypasses `useActionState`/progressive enhancement; the form will not work without JS.
3. Server action `createProject` (`actions.ts:18`):
   - Re-validates session + org (`requireAuthorizedSession()`, `actions.ts:19`).
   - Re-validates name server-side (redundant but correct defense-in-depth) (`actions.ts:21-24`).
   - Inserts the `projects` row with a generated `collectionName: proj_<uuid>` (`actions.ts:34-40`).
   - Creates a WorkOS **authorization resource** for the project (`actions.ts:45-50`), then updates the row with `workosResourceId` (`actions.ts:52-55`), then assigns the creator the `project-admin` role on that resource (`actions.ts:57-62`).
   - **Three sequential network calls to WorkOS/DB with no compensating transaction.** If the role-assignment call (`actions.ts:57-62`) fails after the project row and WorkOS resource already exist, the caught error (`actions.ts:63-66`) returns `{ error: message }` to the client, but the project row is **not rolled back** — it silently exists in the DB, visible in the list, but the creator has no explicit role grant on it (falls back to whatever default org-level permission applies). This is a real correctness/CX risk: a failed "create project" can leave an orphaned, permission-ambiguous project in the list with no user-facing indication anything went wrong for that row specifically.
   - Success: `revalidatePath('/projects')` then `redirect(/projects/${projectId})` (`actions.ts:69-70`) — straight into the new shell (see §0).

### States
| State | Handling |
|---|---|
| Empty | autofocused text input, placeholder "OIB fire safety review" (`create-project-form.tsx:52`) — good, domain-relevant placeholder |
| Validating | Zod onChange, disables field while `isSubmitting` via `form.Subscribe` (`create-project-form.tsx:46-59`) |
| Submitting | field disabled; submit button presumably shows spinner (component not in this file) |
| Server error | Raw `error.message` from a thrown DB/WorkOS exception surfaced directly in an `Alert` (`create-project-form.tsx:31-33,66-70`) — i.e. **internal exception text (e.g. WorkOS SDK error strings) can be shown verbatim to the architect end user** (`actions.ts:64-66` passes `error.message` straight through). No sanitization/mapping to friendly copy. |
| Success | Immediate navigation away — no toast/confirmation, no "Project X created" moment |

### CX gaps / premium opportunities
- Raw exception messages surfacing in the UI is a real production risk (could leak backend/vendor details) and definitely reads as unfinished/un-premium.
- No optimistic UI — the button + redirect is the only feedback; a spinner-only wait with no skeleton of "what's coming" (e.g. a preview of the new project shell fading in) feels abrupt.
- No undo/soft-delete story if a project is created by mistake (typo in name, wrong workspace) — no rename affordance found anywhere in this cluster either.
- Given the domain (real building compliance projects with legal/regulatory stakes), a "what happens when I create a project" microcopy line exists (`create-project-form.tsx:62-64`, "Create a focused workspace for documents, retrieval, members, and chat context") but it's generic — no mention of OIB/RIS specifically, no template/starting-point choice (e.g. select a building type or compliance scope up front, which would materially improve the assistant's first answers).

---

## 6. `ProjectCard` and `ProjectSelector` (legacy, old shell)

### `ProjectCard` (`src/components/projects/project-card.tsx:16`)
- Folder icon, "Project" badge, name, `collectionName` (internal ID leak, see §4), created date, 4 link-buttons (Overview/Files/Ask Grid/Members) using plain `<a>` tags via `Button asChild` (`project-card.tsx:45-68`) — full page navigations, not `next/link`, so each click triggers a full document reload rather than a client-side transition into the new sidebar shell. This will visibly "flash" the whole page (including the sidebar mounting) every time, worse than an SPA-style transition.
- No status/health signal on the card (e.g. document count, unread chat activity, last activity timestamp beyond creation date) — every card looks equally "fresh" regardless of real recency or work done.

### `ProjectSelector` (`src/components/projects/project-selector.tsx:27`)
- Client component, fetches `/api/projects` and `/api/user/preferences` in parallel on mount (`project-selector.tsx:39-42`), stores `active_project_id` as a **user preference**, not URL state.
- Returns `null` while loading or if there are zero projects (`project-selector.tsx:98-100`) — so during the parallel fetch, the top nav silently has a gap where the selector will appear; no skeleton/placeholder width reserved, causing layout shift when it pops in.
- On selection, it POSTs the preference then does `router.push(currentPathname); router.refresh()` (`project-selector.tsx:91-92`) — pushing the *same* pathname is a no-op for the URL but triggers a full server refetch; this is a confusing action for a "selector" since it doesn't navigate anywhere by itself unless something downstream reads the preference to change rendered content.
- This component now appears to be **superseded** by `ProjectSwitcher` in the new shell (§0) — it's only reachable via `GlobalTopNav`, which itself is only used on `/projects` (the list page), where "select a project to view" is a strange affordance to have next to the list of projects you could just click into directly. Likely dead weight mid-migration.

---

## 7. New shell: `AppSidebar`, `ProjectSwitcher`, `SidebarUserMenu`

### `AppSidebar` (`src/components/shell/app-sidebar.tsx:50`)
- Fixed 240px (`w-60`) left rail, full viewport height, `bg-surface-sunken`.
- Sections: wordmark link to `/projects` (`app-sidebar.tsx:66-71`), `ProjectSwitcher` (`:76`), 5-item nav (Overview/Chat/Files/Research/Members) driven by `NAV_ITEMS` (`:35-41`) with active-state matched via `pathname.startsWith`/`===` (`:54-57`), and a footer `SidebarUserMenu` (`:107`).
- No collapse/expand affordance — `ProjectSwitcher` accepts a `collapsed` prop (`project-switcher.tsx:28`) and has fully-built collapsed-state markup (`:41,48-53`), but `AppSidebar` never passes `collapsed` — **dead code / half-shipped feature**: the sidebar cannot currently be collapsed even though the components support it.
- No mobile/responsive behavior at all: at `w-60` fixed with `flex h-screen`, there is no visible breakpoint logic, no hamburger/drawer fallback — on a narrow viewport this rail will just consume fixed width regardless of screen size, no responsive class present in `app-sidebar.tsx`.
- No "Research" project data check — `Research` nav item always renders (`NAV_ITEMS` includes `FlaskConical` "Research" unconditionally, `app-sidebar.tsx:39`), whether or not the project has done any deep research yet — no badge/count/empty-affordance differentiating a project with 0 vs N research runs.

### `ProjectSwitcher` (`src/components/shell/project-switcher.tsx:31`)
- Dropdown listing all org projects with a checkmark on the active one (`:57-66`), plus static "All projects" and "New project" entries at the bottom (`:68-75`).
- "New project" navigates to `/projects?new=1` (`:72-74`) — but `src/app/projects/page.tsx` **never reads a `new` search param** (confirmed by reading the full file, §4) — so this deep-link is inert. Clicking "New project" from inside a project just lands on the plain `/projects` list; the create form is not auto-focused/opened/scrolled-to as the `?new=1` naming implies. Another half-wired feature.
- Uses full project list fetched server-side once per project-layout render (`layout.tsx:24-28`), not live/searchable — fine at small scale, but no search/filter for orgs with many projects, and no keyboard-fast-switch (e.g. cmd+K) which would be an obvious "Apple-level" touch for a multi-project tool used daily.

### `SidebarUserMenu` (`src/components/shell/sidebar-user-menu.tsx:40`)
- Compact avatar + name row, opens dropdown with identity, theme radio (same three options as `GlobalTopNav`'s but re-implemented independently, see §0), and conditional sign-out (`:84-92`, only if `authRequired`).
- No "Documentation" link here (unlike `GlobalTopNav`'s `DocumentationSection`, `GlobalTopNav.tsx:174-190`) — so the docs entry point that exists in the old shell disappears entirely once a user is inside a project, i.e. **the majority of the user's time in-app has no help/docs affordance**.
- No organization name/switcher here at all — for a multi-org WorkOS setup (the org onboarding flow implies orgs are a real concept), there is no way to see or switch organization from inside the app; `organizationId` is shown as a raw ID string in the *old* shell's dropdown (`GlobalTopNav.tsx:204-206`, "Org: {organizationId}") but not in the new one, and neither renders an actual org *name*.

---

## 8. Permission / edge-case dead ends

- `requireProjectAccess` (`src/lib/authz/projects.ts:13`) throws a bare `new Error("Not found")` for both "project doesn't belong to this org" (`:31-33`) and "not authorized" (`:44-46`) — deliberately vague for security, but with **no `error.tsx` anywhere in the app** (confirmed empty glob for `src/app/**/error.tsx` and `**/not-found.tsx`), this exception will render Next.js's raw default error screen in production (a generic 500, not a styled "you don't have access to this project" page). This is the single worst dead end in the whole cluster: a permission-denied or shared-bad-link scenario produces an unbranded crash screen instead of a graceful "request access" or "back to projects" moment.
- `ProjectPage` (`src/app/projects/[id]/page.tsx:14`) calls `notFound()` if `getProjectOverviewData` returns nothing (`:22-24`) — this *does* have graceful handling via Next's `notFound()`, but again there's no custom `not-found.tsx`, so it's Next's default "404 | This page could not be found" — plain text, no Grid branding, no "back to projects" link.
- Auth session expiry mid-session: no explicit handling traced in this cluster; `requireGridSession`/`requireAuthorizedSession` presumably redirect at the next server request, but there's no client-side "your session expired, please sign in again" toast — a user mid-chat who loses auth would only discover it on next navigation/refresh.

---

## State matrix summary (cross-flow)

| Flow | Loading state | Empty state | Error state | Success state |
|---|---|---|---|---|
| Home `/` | none (flash risk) | n/a | n/a | silent redirect |
| Auth error | `Spinner` (redirect case only) | n/a | styled `Alert` | n/a |
| Org onboarding | form's own (not inspected) | n/a | styled inline `Alert` | **none — silent double redirect** |
| Projects list | **none (`loading.tsx` missing)** | designed dashed empty state | **none (`error.tsx` missing)** | n/a (list itself) |
| Create project | field-level disable | n/a | **raw exception text shown to user** | **none — instant redirect** |
| Project access denied | n/a | n/a | **Next.js default error page** | n/a |
| Project not found | n/a | n/a | **Next.js default 404** | n/a |

---

## Top 5 CX opportunities (for the summary)

1. **Unify the two navigation shells.** `AppShell`/`GlobalTopNav` (used only by `/projects`) and `AppSidebar` (used by everything under `/projects/[id]`) are different products stitched together — different logo treatment, different theme picker implementation, docs link present in one and missing in the other, `ProjectSelector` vs `ProjectSwitcher` duplicating the same job. This is the highest-leverage fix: put the projects list inside the sidebar shell too (or vice versa) before investing further in either.
2. **Add `loading.tsx`/`error.tsx` at the app and `[id]` levels, and a styled 403/404 for `requireProjectAccess` failures.** Right now permission-denied and not-found states fall through to Next's default unbranded pages, and the projects list has no loading skeleton — these are the actual first impressions a real user will hit (bad invite link, expired session, revoked access) and today they look like the app crashed.
3. **Stop leaking internals to end users**: raw server exception text in `CreateProjectForm`'s error `Alert` (`actions.ts:64-66` → `create-project-form.tsx:66-70`), the internal `collectionName` (`proj_<uuid>`) shown on every `ProjectCard`, and "WorkOS" vendor name in onboarding copy (`onboarding/organization/page.tsx:137-144`) all read as unfinished/backend-leaking rather than a polished B2B product for architects.
4. **Finish the half-shipped features already scaffolded**: `ProjectSwitcher`'s `collapsed` mode is fully built but never wired up in `AppSidebar`; `/projects?new=1` is referenced by the switcher's "New project" item but never read by the projects page. These are cheap, already-designed wins — wiring them up (sidebar collapse + auto-opening/focusing the create form on `?new=1`) closes visible gaps with near-zero new design work.
5. **Design the org-onboarding→first-project handoff as one continuous moment, and make the projects list a real first-run experience.** Org creation currently silently double-redirects (`/onboarding/organization` → `/` → `/projects`) with no success state, and the very next screen a brand-new org sees is a generic empty-state plus a bare "OIB / corpus" stat tile that communicates nothing. This is the moment to introduce project templates/starting points relevant to Austrian OIB/RIS work (e.g. "New building," "Renovation review," "Fire safety audit"), a proper "your org is ready" confirmation, and a project-count/health-signal-rich empty state — turning the coldest part of the funnel into the most premium-feeling one.
