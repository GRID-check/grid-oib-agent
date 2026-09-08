# Büro-Chat implementation plan (2026-09-08)

> **Status:** proposed, not started. Nothing below has landed.
> **Implements:** [ADR-0054](../docs/adr/0054-workspace-chat-mounts-projects-on-demand.md)
> — the Büro-Chat reads the office and mounts projects on demand.
> **Executes:** the requirements in
> [`workspace-chat-spec.md`](../docs/design/workspace-chat-spec.md) (its §16 phases
> and requirement ids are this plan's phases) and the surface in
> [`workspace-chat-ui.md`](../docs/design/workspace-chat-ui.md).
> **Flag:** `workspace-chat` (WorkOS, fails open while `GRID_ENFORCE_FEATURE_FLAGS`
> is off, exactly like `organization-archiv`). **New env var:**
> `GRID_WORKSPACE_MAX_MOUNTED_PROJECTS`, default `5`; its row, added in slice P1.1,
> goes under *Feature Flags & Limits* in
> [`environment-variables.md`](../docs/deployment/environment-variables.md):
>
> | Variable | Required | Default | Description |
> |---|---|---|---|
> | `GRID_WORKSPACE_MAX_MOUNTED_PROJECTS` | No | `5` | How many projects one workspace ("Büro") conversation may mount at once. Enforced in `POST /api/conversations/:id/mounts` and nowhere else; the agent is told the cap in the refusal and offers deep research instead. A measured number — raise it only after the latency check at the cap passes (ADR-0044, ADR-0054). |

## How to read this

Five phases, matching ADR-0054 and the decision brief §5. Each slice names the
files, the change, the tests, the docs and the one command that proves it.
**Slices are ordered so every one is green and shippable behind the flag** — none
leaves the tree with `task verify:fast` red or half a feature reachable.
Conventions no slice restates:

- **Migrations.** Next free number is `0081` (journal ends at `0080_own_key_tokens`).
  Edit `src/lib/db/schema/*.ts`, then `npx drizzle-kit generate` in `frontends/ui`;
  hand-edit the emitted SQL only for CHECKs, partial indexes and the
  `grid_secure_table` line drizzle cannot express (the sketches below omit its
  `--> statement-breakpoint` separators), never without its journal entry — an
  unlisted file is inert while every check passes
  (`tests/db/migrations-journal.test.ts`); a `*.down.sql` companion stays out of
  it. [`docs/database/migrations.md`](../docs/database/migrations.md).
- **RLS.** A new table joins the boundary in the migration that creates it, and
  that filename goes into `BOUNDARY_MIGRATIONS` in
  `frontends/ui/src/lib/db/rls-coverage.spec.ts`. A new `*.integration.spec.ts`
  must be added to the fixed list in `scripts/rls-test-db.sh:107-110` or it runs
  on nobody's machine but yours.
  [`docs/database/row-level-security.md`](../docs/database/row-level-security.md),
  [ADR-0041](../docs/adr/0041-row-level-security-for-tenant-isolation.md).
- **Routes** declare `authz` on the factory from `@/lib/api/handler`; internal ones
  use `internalApiRoute` and state their tenancy
  ([`frontends/ui/AGENTS.md`](../frontends/ui/AGENTS.md)). **Tests sit beside the
  code**; Python under `sources/` is run by no CI job —
  `PYTHONPATH=src pytest sources -q` is on you
  ([`sources/AGENTS.md`](../sources/AGENTS.md)). **Docs ship in the same commit** as
  the behaviour ([`documentation.md`](../docs/contributing/documentation.md)); a
  release note (`task release:note -- <slug>`) only for what a customer notices.
- **The two shelf twins have no shared schema** —
  `src/aiq_agent/common/source_kinds.py` and
  `frontends/ui/src/features/chat/lib/source-kinds.ts` change together or the
  chip renders unknown ([ADR-0047](../docs/adr/0047-document-shelf-travels-as-data.md)).

---

## Phase 1 — Büro-Chat Basis

**Goal:** a workspace conversation exists as a first-class row and answers pure
Baurecht questions at `/app/chat` with no project chosen. **Value:** kind A — an
architect opens Piloti, asks "Fluchtweglänge GK4?" and gets the same cited answer
they would get inside a project, from base corpus + Büroarchiv + organization
memory and no project corpus at all. **Spec:** `WS-1…WS-11, WS-14, WS-15, KH-3,
KH-5, AC-1, AC-2, AC-6, MG-1, MG-3, MG-4`.

### P1.1 — Flag, cap constant, documentation skeleton

- **Files:** `frontends/ui/src/lib/authz/feature-flags.ts`,
  `frontends/ui/src/lib/workspace/config.ts` **(NEW)**,
  `docs/deployment/environment-variables.md`, `docs/design/workspace-chat-spec.md`
  **(NEW, by the spec author)**, `docs/design/workspace-chat-ui.md` **(NEW, by the
  UI author)**.
- **Change:** add `workspaceChat: 'workspace-chat'` to `FEATURE_FLAGS`, matching
  `orgArchiv`'s fail-open shape. `config.ts` exports `maxMountedProjects(): number`
  reading `GRID_WORKSPACE_MAX_MOUNTED_PROJECTS`, default 5, clamped to `[1, 20]` —
  one reader, so the cap has one implementation from the first line.
- **Tests:** `workspace/config.spec.ts` — default, override, garbage, clamp.
- **Docs:** the env-var row above; the two design docs land here so every later
  slice has something to point at.
- **Release note:** no. **Verify:** `task fe:test` then `task verify:fast`.

### P1.2 — `conversations.scope` with the CHECK that makes it an invariant

- **Files:** `frontends/ui/src/lib/db/schema/conversations.ts`,
  `frontends/ui/drizzle/0081_conversation_scope.sql` **(NEW)** +
  `0081_conversation_scope.down.sql` **(NEW)**,
  `frontends/ui/src/lib/db/rls-coverage.spec.ts`.
- **Change:** mirror `documents.scope` (schema `documents.ts:92`, CHECK `:483`):

  ```sql
  ALTER TABLE "conversations" ADD COLUMN "scope" text DEFAULT 'project' NOT NULL;
  -- Legacy project-less rows are workspace rows already. RAISE NOTICE the ROW_COUNT
  -- so the backfill is a number in the deploy log, not an assumption.
  UPDATE conversations SET scope = 'workspace' WHERE project_id IS NULL;
  ALTER TABLE "conversations"
    ADD CONSTRAINT "conversations_scope_known" CHECK ("scope" IN ('project','workspace')),
    ADD CONSTRAINT "conversations_scope_matches_project"
      CHECK (("scope" = 'project') = ("project_id" IS NOT NULL));
  CREATE INDEX IF NOT EXISTS "conversations_org_scope_updated_idx"
    ON "conversations" ("organization_id", "scope", "updated_at" DESC);
  ```

  No `grid_secure_table` line: `conversations` is inside the boundary already
  (0031) and this is an `ALTER`. The composite unique `(id, organization_id)`
  stays — `conversation_mounts` references it in phase 3.
- **Tests:** `tenant-isolation.integration.spec.ts` (already in the
  `scripts/rls-test-db.sh` list) gains two rejections: `scope='workspace'` with a
  `project_id`, and `scope='project'` without one.
- **Docs:** `docs/database/schema.md` row for the column. **Release note:** no. **Verify:** `task db:test:rls`, then `task fe:types`.

### P1.3 — `org:chat`, and conversations that accept a workspace scope

- **Files:** `frontends/ui/src/lib/authz/{catalog.ts,permissions.ts}`,
  `frontends/ui/src/app/api/conversations/route.ts`,
  `frontends/ui/src/lib/conversations/{service,repository}.ts`.
- **Change:** add one org-tier permission beside `org:projects:create`
  (`catalog.ts:168`), held by the default Member role so every member has it:

  ```ts
  { slug: 'org:chat', name: 'Ask Piloti in the Büro',
    description: 'Open and use the organization-level chat (Büro), which reads the base corpus, the Archiv and organization memory. Withhold it to keep chat inside projects.',
    tier: 'org' },
  ```

  `createConversationSchema` gains `scope: z.enum(['project','workspace']).optional()`
  and a `superRefine` rejecting `scope==='workspace'` with a `projectId` — the
  CHECK's twin at the edge, so a bad request is a 400 rather than a 500.
  `createConversation` (`service.ts:276`) branches: with `scope='workspace'` it
  checks `org:chat` through `hasPermission` and inserts
  `projectId: null, scope: 'workspace'`; with a project it is unchanged.
  `listConversations` (`service.ts:186`) gains `scope?: 'workspace'`, narrowing
  the repository query to workspace rows; the visibility narrowing is unchanged.
  Workspace conversations stay `private` in phase 1 — a guard in
  `setConversationVisibility` refuses to widen one, naming phase 4
  ([ADR-0032](../docs/adr/0032-shareable-resource-model.md)).
- **Tests:** `frontends/ui/src/lib/conversations/service.spec.ts` — create
  without `org:chat` → `ForbiddenError`; with a project id → 400; list
  `scope='workspace'` never returns project rows; sharing → refused.
- **Docs:** `docs/api/bff-routes.md`; the catalog's own doc comment. **Release note:** no. **Verify:** `task fe:test` + `task fe:types`, and the
  check-only `task fe:provision:authz` pasted into the PR. **Ask before**
  `-- --apply` ([`AGENTS.md`](../AGENTS.md) one-way doors).

### P1.4 — `scope: 'workspace'` in the scope builder, with no active-project fallback

- **Files:** `frontends/ui/src/lib/{collection-scope-request,collection-scope}.ts`,
  `frontends/ui/src/app/api/auth/websocket-scope/route.ts`, `frontends/ui/server.js`.
- **Change:** `RequestContext` (`collection-scope-request.ts:18`) gains
  `scope?: 'project' | 'workspace'`. In `buildCollectionScopeFromRequest` (`:141`)
  the workspace branch runs **before** the `includeProject` logic and never
  consults `resolveActiveProjectId` (`:59`):

  ```ts
  // Explicit and total: a Büro turn has no project and MUST NOT acquire one from
  // a stale preference. The silent degrade at :177-188 is what this mode removes.
  if (context.scope === 'workspace') projectId = undefined
  ```

  The returned scope is `[base, archiv_<org>?, s_<conversation>?]` with shelves as
  today; `computeCollectionScope` and `ScopeContext` are untouched (project
  attribution arrives in P3.3). `websocket-scope/route.ts` reads `?scope=workspace`
  and skips `loadProjectPromptView`/`loadProjectBundesland` for it — the memory
  digest call at `:163` already serves a project-less caller and carries
  organization memory into a Büro turn. In `server.js`, forward the param at
  `:612` **and add `scope` to `scopeCacheKey` (`:480`)** — that cache is keyed on
  `(cookie, projectId, conversationId)` today, so without it a Büro upgrade can be
  served a project-scoped entry for the same cookie.
- **Tests:** `collection-scope-request.spec.ts` — workspace mode with a stale
  `active_project_id` yields no `proj_` entry and makes no FGA call; it still
  injects the Archiv under the flag; project mode is byte-identical to today. The
  server spec — two upgrades, same cookie, different scopes, different entries.
- **Docs:** [`collection-scoping.md`](../docs/technical-reference/collection-scoping.md)
  gains the workspace row; `docs/api/websocket-protocol.md` the param.
- **Release note:** no. **Verify:** `task fe:test` + `task verify:fast`.

### P1.5 — `/app/chat` renders the Büro; the sessions panel stops failing open

- **Files:** `frontends/ui/src/app/app/(shell)/chat/{page.tsx,workspace-chat-client.tsx}`
  (the client **NEW**), `frontends/ui/src/features/chat/store.ts`,
  `.../chat/stores/sessions-store.ts`, `.../chat/lib/project-scope.ts`,
  `frontends/ui/src/features/layout/components/MainLayout.tsx`.
- **Change:** `page.tsx` keeps its inbox-deep-link branch verbatim (`?session=` →
  resolve → redirect, `:25-39`) and otherwise renders `WorkspaceChatClient` under
  the flag, redirecting to `/app/projects` without it. That client is a sibling of
  `project-chat-client.tsx`: it sets `projectId = null` and `scope = 'workspace'`
  on the store and passes the same props minus `projectId`/`projectCollection`.
  **`ProjectChatClientProps.projectId` stays required** — siblings, not one client
  with an optional project. The store gains `scope` (default `'project'`) with
  `setScope`; `loadServerConversations` sends `scope=workspace` in that mode; and
  `conversationMatchesProject` grows an explicit workspace branch, losing its
  fail-open there:

  ```ts
  export function conversationMatchesScope(
    conversation: { projectId?: string | null; scope?: 'project' | 'workspace' | null },
    active: { projectId: string | null | undefined; scope: 'project' | 'workspace' },
  ): boolean {
    if (active.scope === 'workspace')
      return (conversation.scope ?? (conversation.projectId ? 'project' : 'workspace')) === 'workspace'
    return conversationMatchesProject(conversation, active.projectId)  // unchanged, still fail-open
  }
  ```

  Only the Büro gets the strict rule, so no existing history disappears.
- **Tests:** `project-scope.spec.ts` — a project row never shows in the Büro, a
  legacy row with no scope and no project does; `workspace-chat-client.spec.tsx` —
  store scope set, no `projectId` in the WS URL; `store.spec.ts` — `setScope`
  clears the project.
- **Docs:** [`docs/user-guides/chat.md`](../docs/user-guides/chat.md) gains the
  Büro section (German product copy).
- **Release note:** **yes**, `task release:note -- buero-chat-basis`. **Verify:**
  `task fe:test` + `task fe:types`, then the Compose stack for one real WS turn
  (static green is not runtime green,
  [`testing-and-verification.md`](../docs/contributing/testing-and-verification.md)).

### P1.6 — The doors: header, rail, palette, shortcut, empty state

- **Files:** `frontends/ui/src/components/shell/{org-header.tsx,project-sections.ts,command-palette.tsx,shortcuts.ts}`,
  `frontends/ui/src/i18n/dictionaries/{de,en}/{nav,chat}.ts`,
  `frontends/ui/src/app/dev/workspace-chat/page.tsx` **(NEW)**,
  `frontends/ui/visual/registry.mjs`.
- **Change:** "Piloti fragen" first in `OrgHeader` (MessageSquare, the project Ask
  icon); "Büro-Chat" in the rail's `org` group beside Archiv and Postfach; ⌘K entry
  "Piloti fragen (Büro)"; `g b`. Empty state is the `empty-state` atom with three
  example prompts, one each of kinds A/B/C — B and C are aspirational until phases
  2-3, so they are worded as questions, not promises. Every new string in both
  dictionaries (`key-coverage.spec.ts`).
- **Tests:** `org-header.spec.tsx`, `shortcuts.spec.ts`, the palette spec.
- **Docs:** `docs/design/click-dummy-overhaul-spec.md` §5 IA gains the row;
  committed PNGs from `task fe:screenshots` for the new `/dev/workspace-chat`
  target (`visual-coverage`).
- **Release note:** no (folded into P1.5's note). **Verify:** `task fe:test`, `task fe:screenshots`, `task verify:fast`.

**Phase 1 gate:** a member without `org:chat` gets 403 on create; a Büro turn's
scope header contains no `proj_` entry under any preference state (P1.4 spec);
one live Baurecht question answered in the Büro matches the project answer.
**Size: 4-5 engineer-days.**

---

## Phase 2 — Projektregister

**Goal:** the Büro knows which projects exist, can name them and can quote their
profile facts — without reading a single project document. **Value:** half of kind
B — "in welchen Projekten haben wir GK5 mit Holzbau?" is answered by name, with a
Steckbrief citation, and nothing is claimed about a project's content. **Spec:**
`PR-1…PR-17, KH-1, KH-2, AG-2, AG-7, AC-3…AC-5, MG-2`.

### P2.1 — The `project_register` table

- **Files:** `frontends/ui/src/lib/db/schema/{project-register.ts,index.ts}` (the
  schema **NEW**), `frontends/ui/drizzle/0082_project_register.sql` **(NEW)** +
  `.down.sql`, `frontends/ui/src/lib/db/rls-coverage.spec.ts`.
- **Change:** one row per project, embedding row-resident exactly as
  `project_memory` carries one (`project-memory.ts:100-102`, migration 0069 — no
  pgvector, no Chroma):

  ```sql
  CREATE TABLE IF NOT EXISTS "project_register" (
    "project_id"       uuid PRIMARY KEY,
    "organization_id"  text NOT NULL,
    "project_name"     text NOT NULL,
    "status"           text,                    -- from profile facts; NULL when unstated
    "bundesland"       text,
    "steckbrief"       text NOT NULL,           -- the ≤3000-char prompt block
    "document_count"   integer NOT NULL DEFAULT 0,
    "last_activity_at" timestamp with time zone,
    "embedding"        real[],
    "embedding_model"  text,
    "embedded_at"      timestamp with time zone,
    "stale_at"         timestamp with time zone, -- set by a writer, cleared by the build
    "built_at"         timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at"       timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "project_register_project_fk"
      FOREIGN KEY ("project_id","organization_id")
      REFERENCES "projects"("id","organization_id") ON DELETE CASCADE,
    CONSTRAINT "project_register_steckbrief_bounded"
      CHECK (char_length("steckbrief") <= 3000),
    CONSTRAINT "project_register_embedding_complete"
      CHECK (("embedding" IS NULL) = ("embedding_model" IS NULL)
         AND ("embedding" IS NULL) = ("embedded_at" IS NULL))
  );
  CREATE INDEX IF NOT EXISTS "project_register_stale_idx" ON "project_register"
    ("organization_id","stale_at") WHERE "stale_at" IS NOT NULL;
  CREATE INDEX IF NOT EXISTS "project_register_fts_idx" ON "project_register"
    USING gin (to_tsvector('german', "steckbrief"));
  SELECT grid_secure_table('project_register',
    'organization_id = grid_current_org() AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.organization_id = grid_current_org())');
  ```

  The composite FK is the belt-and-braces `tasks` uses (0075): a row cannot be
  planted under another tenant's project. The 3000-char CHECK is the budget as a
  database invariant rather than a convention the builder is trusted to keep.
  `status` is a column because the Steckbrief needs one, but **`projects` has no
  status column** — it is read out of `profile.facts` and may be NULL.
- **Tests:** `tenant-isolation.integration.spec.ts` gains cross-org insert and
  read refusals plus an over-budget insert rejection; `rls-coverage.spec.ts` picks
  the table up by name once the migration is in `BOUNDARY_MIGRATIONS`.
- **Docs:** `docs/database/schema.md`. **Release note:** no. **Verify:** `task db:test:rls`.

### P2.2 — The Steckbrief builder

- **Files:** `frontends/ui/src/lib/workspace/steckbrief{,.spec}.ts` **(NEW)**.
- **Change:** a pure function, no I/O, so the budget is testable:

  ```ts
  export function buildProjectSteckbrief(input: {
    project: Pick<Project, 'id' | 'name' | 'profile' | 'profilePromptView' | 'createdAt'>
    memoryHeadline: string | null   // top salient active rows, ≤600 chars
    documents: { filename: string; docClass: string | null; folderPath: string | null }[]
    lastActivityAt: Date | null
  }): { text: string; status: string | null; bundesland: string | null }
  ```

  Composition, truncating from the bottom so identity survives:
  `PROJECT_STECKBRIEF v1` header · name + id · status + Bundesland · the stored
  `profilePromptView` (built by `buildProjectPromptView`,
  `lib/project-profile/prompt-view.ts:149`, already cached and invalidated on save)
  · the memory headline · a document inventory capped at 20 lines
  (`filename · doc_class · folder`) with `… und N weitere` · last activity. Hard
  cap 3000 characters, asserted by the CHECK behind it.
  **The one-line document summary is deliberately absent** — summaries live only
  in the Python `DocumentMetadataStore` and the BFF cannot read them (*Correlated
  debt* §D4); `doc_class` + folder is what the BFF actually knows.
- **Tests:** budget under a pathological project (200 documents, 8 KB prompt
  view); truncation order; an empty profile still yields a usable Steckbrief.
- **Docs:** none yet (nothing reads it). **Release note:** no. **Verify:** `task fe:test`.

### P2.3 — Writers, `stale_at`, and the nightly reconcile

- **Files:** `frontends/ui/src/lib/workspace/{register-service,register-repository}.ts`
  **(NEW)**, `frontends/ui/src/lib/project-profile/profile-service.ts`,
  `frontends/ui/src/lib/projects/{memory-service,service}.ts`,
  `frontends/ui/src/lib/documents/service.ts` (ingest terminal state),
  `frontends/ui/src/app/api/internal/workspace/register/reconcile/route.ts`
  **(NEW)**, `frontends/ui/scheduler/index.js`.
- **Change:** the BFF is the single writer (ADR-0054).
  `rebuildProjectRegisterRow(projectId, orgId)` reads the four sources, calls the
  builder, embeds via the same `embedNote` path memory uses, and upserts.
  Invalidation points, each a one-line call: profile save
  (`profile-service.ts:215`, beside `invalidateProjectProfileCaches`), memory write
  (`createProjectMemoryItem`, debounced by writing `stale_at = now()` rather than
  rebuilding inline), document ingest terminal state, project rename. A purge needs
  nothing: the composite FK cascades. The reconcile route is `internalApiRoute`,
  token-guarded, cross-tenant and **bounded** — one batch (50 rows by `stale_at`)
  per call, the shape of `api/internal/collaboration/prune`; the scheduler worker,
  which already ticks and prunes, gains a stage that calls it, logged and never
  fatal on failure.
- **Tests:** `register-service.spec.ts` — each writer marks stale; the rebuild
  clears `stale_at`; the reconcile is bounded and idempotent.
  `scheduler/index.spec.mjs` — a failing reconcile does not stop the fire stage.
- **Docs:** `docs/api/bff-routes.md`; `docs/architecture/project-memory-design.md`
  (the memory write is now also a register writer). **Release note:** no.
  **Verify:** `task fe:test` + `task verify:fast`.

### P2.4 — Readable recall over the register

- **Files:** `frontends/ui/src/lib/workspace/register-service.ts`,
  `frontends/ui/src/lib/workspace/register-recall.integration.spec.ts` **(NEW)**,
  `scripts/rls-test-db.sh`.
- **Change:** `recallSteckbriefe(session, query, limit = 5)` — hybrid cosine
  (`grid_cosine_similarity`, the SQL function memory recall already uses) over
  `embedding` plus `to_tsvector('german', steckbrief)` lexical, fused, then
  **filtered to `listProjects(session)`** (`lib/projects/service.ts:63-85`), the
  one readability computation in the product. Filter after ranking, over-fetching
  3× the limit, so a member who may read three of forty projects gets three hits
  rather than none.
- **Tests:** the integration spec is the tenancy gate ADR-0054 demands — a member
  whose `checkResourcePermission` mock denies `project:view` on P never sees P in
  recall at any ranking position; an org admin (`org:projects:administer`) sees
  everything without an FGA call (mock shape as in `authz/decide.spec.ts:33-36`).
  **Add the file to `scripts/rls-test-db.sh`'s fixed list.**
- **Docs:** the spec's tenancy requirement gets its test path. **Release note:** no. **Verify:** `task db:test:rls`.

### P2.5 — The workspace digest endpoint, and `fetch_memory_digest` generalised

- **Files:** `frontends/ui/src/app/api/internal/workspace/digest/route.ts` **(NEW)**,
  `frontends/ui/src/lib/request-context.ts`, `frontends/ui/server.js`,
  `src/aiq_agent/project_context.py`, `src/aiq_agent/knowledge/workspace_digest.py`
  **(NEW)**, `src/aiq_agent/agents/chat_researcher/register.py`.
- **Change:** the endpoint mirrors `api/internal/memory/digest/route.ts`, returning
  both halves in one round trip:

  ```
  GET /api/internal/workspace/digest?organizationId&membershipId&q&limit
  → { digest: string | null, projects: [{ id, name, steckbrief, score }] }
  ```

  Readability needs a membership, not a user id (`checkResourcePermission` keys
  on `organizationMembershipId`), so **the signed envelope gains
  `organizationMembershipId`** — one field in `GridRequestContextInput`,
  `buildGridRequestContextEnvelopePayload` (`request-context.ts:291`), the pinned
  CommonJS duplicate in `server.js:44-61`, and its reader in `project_context.py`.
  (Fallback if envelope growth is contested: resolve the membership from
  `(userId, organizationId)` and cache it org-keyed — one WorkOS round trip on
  the turn's critical path, which is why it is the fallback.)
  `fetch_memory_digest` (`knowledge/project_memory.py:131`) keeps its signature
  and gains a sibling in the new module:

  ```python
  def fetch_workspace_digest(*, organization_id, membership_id, query, limit=5) -> WorkspaceDigest | None
  ```

  Same discipline as the memory digest — blocking, called through
  `asyncio.to_thread`, bounded by `_DIGEST_TIMEOUT_SECONDS`, **fail-open**: any
  transport or decode failure returns `None` and the turn proceeds with the frozen
  header digest. `chat_researcher/register.py:881-939` calls it in the same
  `_load_project_context` gather when the envelope has no project id and composes
  `WORKSPACE_CONTEXT v1` = organization memory digest + a "Passende Projekte"
  block of the returned Steckbriefe, each labelled with project name and id, into
  `state.project_context` — the field stays, only its content shape changes, so
  no state class moves.
- **Tests:** `route.spec.ts` — no membership → empty projects, digest still
  served; unknown org → `{digest: null, projects: []}`.
  `tests/aiq_agent/test_workspace_digest.py` **(NEW)** — timeout, 500, malformed
  JSON and an empty body all fail open; the block is built deterministically.
- **Docs:** `docs/api/bff-routes.md`, `docs/api/python-endpoints.md`,
  `docs/architecture/project-memory-design.md` (the seam is now shared).
- **Release note:** no. **Verify:** `task fe:test` and `PYTHONPATH=src .venv/bin/pytest tests/aiq_agent -q`.

### P2.6 — The fifth shelf, in both twins

- **Files:** `src/aiq_agent/common/source_kinds.py`,
  `frontends/ui/src/features/chat/lib/{source-kinds.ts,citations/*.ts}`,
  `frontends/ui/src/lib/collection-scope.ts`.
- **Change:** `Shelf.REGISTER = "register"` in the Python `StrEnum`
  (`source_kinds.py:189-204`) and `'register'` in the TS union, in `SHELVES`
  (`source-kinds.ts:104-107`, held in step by `satisfies`) and in every `switch`
  the `unhandledShelf` guard protects — `shelfLabel` returns **"Projektregister"**.
  `CollectionShelf` (`collection-scope.ts:16`) gains it too. A Steckbrief hit is
  source kind `projekt`, shelf `register`, locus "Steckbrief"; both twins still
  fail closed on an unknown value.
- **Tests:** `source-kinds.spec.ts` (label + `asShelf`); a Python test asserting
  `parse_shelf("register")` and that an unknown string is still `None`.
- **Docs:** `docs/technical-reference/collection-scoping.md` lists the shelves.
  **Release note:** no. **Verify:** `task fe:types` +
  `PYTHONPATH=src .venv/bin/pytest tests -q`.

### P2.7 — `find_projects`

- **Files:** `src/aiq_agent/agents/workspace/__init__.py` **(NEW)**,
  `src/aiq_agent/agents/workspace/register.py` **(NEW)**, `pyproject.toml`,
  `configs/config_oib_openrouter.yml`, `src/aiq_agent/project_context.py`,
  `tests/aiq_agent/test_tool_context_contract.py`.
- **Change:** a NAT function in the shape `remember` uses
  (`agents/project_memory/register.py:89-95`):

  ```python
  class WorkspaceFindProjectsConfig(FunctionBaseConfig, name="workspace_find_projects"):
      max_results: int = 5

  @register_function(config_type=WorkspaceFindProjectsConfig)
  async def workspace_find_projects(tool_config, builder):
      async def _find_projects(query: str) -> str:
          """Find projects in this office by what they are. Returns names, ids and profile facts — never document content."""
  ```

  It calls the same digest endpoint with a caller-supplied query, returns a
  bounded text block, and **returns errors as strings, never raises**. New entry
  point `aiq_workspace = "aiq_agent.agents.workspace.register"` in the root
  `pyproject.toml` (`:76-92`); `find_projects: { _type: workspace_find_projects }`
  under `functions:` and in `shallow_research_agent.tools`
  (`configs/config_oib_openrouter.yml:573-587`).
  `TOOL_CONTEXT_REQUIREMENTS` (`project_context.py:63`) gains
  `"workspace_find_projects": (ORGANIZATION_ID_HEADER,)` — a subset of
  `WORKER_IDENTITY_HEADERS` (`jobs/runner.py:119`), so the contract test passes
  for both entry paths.
- **Tests:** the contract test's three assertions cover the new type by
  construction; add one naming the tool so a later removal is loud.
  `tests/aiq_agent/test_workspace_tools.py` **(NEW)** — stubbed endpoint, refusal
  without an organization, bounded result.
- **Docs:** `docs/api/python-endpoints.md` tool table. **Release note:** no.
  **Verify:** `PYTHONPATH=src .venv/bin/pytest tests/aiq_agent -q`, `task be:lint`.

### P2.8 — The Büro prompt branch

- **Files:** `src/aiq_agent/agents/shallow_researcher/prompts/researcher.j2`,
  `src/aiq_agent/agents/shallow_researcher/agent.py` (template variable),
  `tests/benchmarks/test_turn_shapes_live.py`,
  `frontends/benchmarks/oib_retrieval/fixtures/oib_workspace_golden.json` **(NEW)**.
- **Change:** one branch beside the existing `{% if project_context %}` block
  (`researcher.j2:324-328`), not a second prompt:

  ```jinja
  {% if workspace_context %}
  ## Büro
  <workspace_context>{{ workspace_context }}</workspace_context>
  You are in the office, not in a project. Name the project for every claim that
  comes from one. A "Passende Projekte" entry is a Steckbrief: you may name the
  project and quote its facts, and you may NOT describe its documents' content from
  it. To read a project's files, mount it with `open_project` first; if you cannot
  (the cap, or no access), say so and offer deep research. Do not propose a
  `project_profile_patch` for a project that is not mounted.
  {% endif %}
  ```

  `<knowledge_shelves>` (`:238-247`) gains the fifth shelf in the same register:
  **Projektregister** — "which projects exist and what they are; never their file
  contents".
- **Tests:** two office shapes in the live turn-shapes eval — a question with
  nothing mounted must answer from the register **and say so**; a question naming
  a project must call `open_project` before claiming its content (asserted on the
  recorded trace, as the harness already does). Plus the 20-question Büro golden
  set in the retrieval fixture, scored for "right project in the top-3".
- **Docs:** [`docs/contributing/testing-and-verification.md`](../docs/contributing/testing-and-verification.md)
  §"The live turn-shape eval" gains the office shapes.
- **Release note:** **yes** — `task release:note -- projektregister`. **Verify:** `task be:eval:retrieval`, and
  `OPENROUTER_API_KEY=… task be:eval:turn-shapes`.

**Phase 2 gate:** register recall puts the right project in the top three ≥ 90% of
the golden set; the Baurecht set does not regress; the tenancy integration spec is
green. **Size: 8-10 engineer-days.**

---

## Phase 3 — Einblenden

**Goal:** a bounded number of project corpora join a Büro turn's scope, on the
agent's or the user's initiative, with attribution all the way to the chip.
**Value:** kinds B and C in full — "wie haben wir die Sprinkler-Steigleitung im
Projekt Seestadt gelöst?" is answered from Seestadt's documents, cited as
Seestadt's documents. **Spec:** `MT-1…MT-16, KH-6…KH-17, WS-12, WS-13,
AG-3…AG-6, AG-10…AG-12, DR-1…DR-3`.

### P3.1 — The `conversation_mounts` table

- **Files:** `frontends/ui/src/lib/db/schema/{conversation-mounts.ts,index.ts}`
  (the schema **NEW**), `frontends/ui/drizzle/0083_conversation_mounts.sql`
  **(NEW)** + `.down.sql`, `frontends/ui/src/lib/db/rls-coverage.spec.ts`.
- **Change:**

  ```sql
  CREATE TABLE IF NOT EXISTS "conversation_mounts" (
    "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "conversation_id"    text NOT NULL,
    "organization_id"    text NOT NULL,
    "project_id"         uuid NOT NULL,
    "mounted_by"         text NOT NULL,
    "mounted_by_user_id" text,
    "mounted_at"         timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "conversation_mounts_conversation_fk"
      FOREIGN KEY ("conversation_id","organization_id")
      REFERENCES "conversations"("id","organization_id") ON DELETE CASCADE,
    CONSTRAINT "conversation_mounts_project_fk"
      FOREIGN KEY ("project_id","organization_id")
      REFERENCES "projects"("id","organization_id") ON DELETE CASCADE,
    CONSTRAINT "conversation_mounts_actor_known" CHECK ("mounted_by" IN ('user','agent')),
    CONSTRAINT "conversation_mounts_user_is_named"
      CHECK (("mounted_by" = 'user') = ("mounted_by_user_id" IS NOT NULL))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "uniq_conversation_mounts"
    ON "conversation_mounts" ("conversation_id","project_id");
  CREATE INDEX IF NOT EXISTS "conversation_mounts_project_idx" ON "conversation_mounts" ("project_id");
  SELECT grid_secure_table('conversation_mounts',
    'organization_id = grid_current_org() AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.organization_id = grid_current_org())');
  ```

  Both FKs are composite, so a mount cannot tie a conversation to another tenant's
  project. **A project purge removes its mount rows and nothing else** — the
  conversation belongs to the organization
  ([ADR-0011](../docs/adr/0011-deletion-pipeline.md)), so the purge's "all
  conversation ids for the project" enumeration must not learn about mounts.
- **Tests:** `tenant-isolation.integration.spec.ts` — cross-org mount refused;
  purging a project leaves the conversation and drops the mount; the
  `mounted_by`/`mounted_by_user_id` biconditional rejects a half-filled row.
- **Docs:** `docs/database/schema.md`; one line in ADR-0011's doc saying mount
  rows are project-cascaded and conversations are not.
- **Release note:** no. **Verify:** `task db:test:rls`.

### P3.2 — The mounts endpoint, the cap, the grant

- **Files:** `frontends/ui/src/app/api/conversations/[id]/mounts/route.ts`
  **(NEW)**, `frontends/ui/src/app/api/internal/conversations/[id]/mounts/route.ts`
  **(NEW)**, `frontends/ui/src/lib/workspace/mounts-service.ts` **(NEW)**,
  `frontends/ui/src/lib/workspace/grant.ts` **(NEW)**.
- **Change:** one service, two thin adapters (session-authenticated and
  internal-token, the latter carrying `userId` + `membershipId` from the signed
  envelope so it authorizes **as the user**, never as the service).
  `mountProject(session, conversationId, projectId)`: (1)
  `requireResourceAccess(…, 'conversation', id, 'collaborator')`; (2)
  `requireProjectAccess(session, projectId, CHAT_PERMISSIONS)` — `project:chat`,
  the permission the project scope builder demands; (3) **the cap, here and
  nowhere else** — count existing mounts and above `maxMountedProjects()` throw
  `WorkspaceMountCapError` carrying the cap and the mounted names; (4) insert,
  idempotent on the unique index; (5) mint the grant.

  ```ts
  export interface MountGrant {
    collection: string   // proj_<uuid>, from projects.collection_name
    shelf: 'project'; projectId: string; projectName: string
    conversationId: string; organizationId: string
    exp: number          // epoch seconds, now + 15 min
  }
  // wire: { grant: base64url(JSON.stringify(grant)), sig: hex HMAC-SHA256 }, signed with
  // signGridRequestContextEnvelope(json, GRID_INTERNAL_API_TOKEN) — the SAME secret the
  // request-context envelope uses. No new trust boundary.
  ```

  The cap error is surfaced twice in one wording: a 409 with
  `code: 'WORKSPACE_MOUNT_CAP'` for the UI, and the tool's returned string for the
  agent (P3.4), naming the cap and offering deep research.
- **Tests:** `mounts-service.spec.ts` — no `project:chat` → 403; cap+1 → 409 with
  no row written; re-mounting is idempotent and consumes no cap; the grant
  verifies and expires. Plus the FGA integration test ADR-0054 names.
- **Docs:** `docs/api/bff-routes.md`. **Release note:** no (nothing reaches it yet). **Verify:** `task fe:test` + `task db:test:rls`.

### P3.3 — Persisted mounts in the scope, project identity on the entry

- **Files:** `frontends/ui/src/lib/collection-scope.ts`,
  `frontends/ui/src/lib/collection-scope-request.ts`,
  `frontends/ui/src/app/api/auth/websocket-scope/route.ts`,
  `src/aiq_agent/knowledge/scoping.py`, `sources/knowledge_layer/src/register.py`.
- **Change:** `ScopedCollection` gains `projectId?` and `projectName?` on both
  sides (`collection-scope.ts:27`, `scoping.py:39`). The workspace branch of
  `buildCollectionScopeFromRequest` loads the conversation's mounts,
  **re-authorizes each one** (`project:chat`, concurrently, failing closed per
  project — that is the revocation path: a revoked mount narrows the scope at this
  upgrade) and appends one `project` entry per survivor with its id and name.
  `_retrieve_collection` (`sources/knowledge_layer/src/register.py:1638-1685`)
  copies `project_id`/`project_name` onto each chunk's metadata beside
  `collection` and `shelf` — the last point where they are known for free.
- **Tests:** `collection-scope-request.spec.ts` — five mounts yield five entries
  with names; a mount whose FGA check fails is dropped, not fatal; the header
  stays under 8 KB at five mounts with 80-char names (the mitigation for the
  header risk below). `sources/knowledge_layer/tests/` — metadata carries the id.
- **Docs:** `docs/technical-reference/collection-scoping.md`,
  `docs/api/websocket-protocol.md`.
- **Release note:** no. **Verify:** `task fe:test`, then `PYTHONPATH=src pytest sources -q`
  (no CI job runs that; see `sources/AGENTS.md`).

### P3.4 — `open_project` and the turn-scoped mount registry

- **Files:** `src/aiq_agent/agents/workspace/register.py`,
  `src/aiq_agent/knowledge/{mounts.py (NEW),scoping.py}`,
  `src/aiq_agent/project_context.py`, `configs/config_oib_openrouter.yml`,
  `tests/aiq_agent/test_tool_context_contract.py`.
- **Change:** `mounts.py` holds a per-turn `ContextVar` registry, created and
  reset per turn like `cards/registry.py` (`src/aiq_agent/AGENTS.md`):

  ```python
  _TURN_MOUNTS: ContextVar[tuple[ScopedCollection, ...]] = ContextVar("grid_turn_mounts", default=())

  def register_mount_grant(grant_b64: str, sig: str) -> ScopedCollection | None:
      """Verify HMAC + expiry + conversation match, then add to this turn's mounts.
      Returns None on any failure — an unsigned, expired or foreign grant widens nothing."""
  ```

  `get_scoped_collections_from_context()` (`scoping.py:197`) unions
  `get_turn_mounts()` onto the envelope scope **after** parsing it, de-duplicated
  by name. Nothing in the fan-out changes: `_resolve_scoped_collections`
  (`sources/knowledge_layer/src/register.py:434`) already returns the header scope
  verbatim, and `_restrict_scope_to_turn` (`:523`) still subtracts what the
  composer did not ask for — a mount widens the ceiling, the turn's focus can
  still narrow it. `open_project(project_id)` calls the internal mounts twin,
  registers the grant, and returns "Projekt <name> ist jetzt eingeblendet" or the
  refusal string (no access / cap reached, with the cap and the deep-research
  offer). The conversation id comes from the NAT `Context`, as the knowledge layer
  reads it, so the requirement stays inside `WORKER_IDENTITY_HEADERS`:
  `"workspace_open_project": (ORGANIZATION_ID_HEADER, USER_ID_HEADER)`.
- **Tests:** `tests/aiq_agent/test_mount_grants.py` **(NEW)** — a good grant
  widens the scope; a tampered payload, a wrong signature, an expired `exp` and a
  grant for another conversation each widen nothing and are logged; the registry
  does not leak between two sequential turns in one process.
- **Docs:** `docs/technical-reference/collection-scoping.md` gains the in-turn
  widening section; `docs/api/python-endpoints.md` the tool. **Release note:** no.
  **Verify:** `PYTHONPATH=src .venv/bin/pytest tests -q`, `task be:lint`.

### P3.5 — `ScopeTree` on both surfaces

- **Files:** `frontends/ui/src/features/layout/components/{scope/ScopeTree.tsx,scope/ScopeChip.tsx,InputArea.tsx}`
  (the two scope components **NEW**),
  `frontends/ui/src/features/chat/stores/sessions-store.ts` (mount state),
  `frontends/ui/src/i18n/dictionaries/{de,en}/chat.ts`,
  `frontends/ui/src/app/dev/scope-tree/page.tsx` **(NEW)**,
  `frontends/ui/visual/registry.mjs`.
- **Change:** the composer's lock-chip popover (`InputArea.tsx:1823-1883`) becomes
  `ScopeChip` — variant `project` (lock), variant `workspace` (building icon,
  label **Büro**) — opening one indented tree: Basiswissen → Büroarchiv →
  Projektregister (Büro only) → Projekt(e) → Diese Unterhaltung. States reuse the
  Datenbasis vocabulary `on/off/unavailable/always`
  (`source-basis/source-basis-model.ts`); that picker stays the tool/source toggle
  and is **linked from the tree, not merged into it**. In the Büro the Projekt(e)
  node lists mounted projects with a remove action and "+ Projekt einblenden" via
  the `command` atom, the add row disabled at the cap with the cap wording; in a
  project it shows the one locked project, and the disabled "Alle Projekte · Bald
  verfügbar" row (`chat.ts:105-106`) is replaced by P3.6's action. Atoms only
  (`frontends/ui/AGENTS.md`); a new atom if the kit lacks the shape.
- **Tests:** `ScopeTree.spec.tsx` — the Büro tree shows the register row and the
  project tree does not; remove calls the endpoint; the cap disables the add row
  with the reason visible.
- **Docs:** `docs/design/workspace-chat-ui.md`;
  [`chat.md`](../docs/user-guides/chat.md) (the scope-chip paragraph is now a
  tree); `docs/design/grid-design-language.md` if a new atom lands.
- **Release note:** no (folded into P3.6). **Verify:** `task fe:test`, `task fe:screenshots`, `task verify:fast`.

### P3.6 — Attribution, the Herleitung grouping, and the doorways

- **Files:** `frontends/ui/src/features/chat/lib/{wire-citation.ts,trace-lanes.ts}`,
  `.../lib/citations/{build,views,model}.ts`,
  `.../components/{CitationPeek,SourcePreview}.tsx`,
  `.../components/reasoning/ReasoningFlow.tsx`,
  `.../components/scope/ScopeTree.tsx`,
  `frontends/ui/src/app/app/(shell)/chat/workspace-chat-client.tsx`,
  `frontends/ui/src/i18n/dictionaries/{de,en}/chat.ts`.
- **Change:** `projectId`/`projectName` ride the wire citation into the view model,
  so a mounted-project chip reads "Projekt Seestadt · Brandschutz.pdf · S. 7".
  `deriveTraceLanes` (`trace-lanes.ts:374`) groups lanes by knowledge level in
  fixed authority order — law → office → register → project → conversation — one
  subgroup per project: a regrouping of existing lanes, not a new panel, and
  deliberately not a rendering of the LangGraph topology (Langfuse keeps the
  graph). The project chat's replaced row becomes **"Im Büro fragen →"**, opening
  `/app/chat?mount=<projectId>`, which `WorkspaceChatClient` consumes once and
  strips; a project citation in the Büro offers **"Im Projekt weiterfragen"**.
- **Tests:** `citations/build.spec.ts`; `trace-lanes.spec.ts` (grouping order, two
  projects stay separate); `workspace-chat-client.spec.tsx` — `?mount=` mounts
  once, leaves the URL clean, and a failed mount shows the refusal rather than an
  empty chat; the `/dev/herleitung` screenshot target.
- **Docs:** `docs/design/workspace-chat-ui.md`,
  [`chat.md`](../docs/user-guides/chat.md), `docs/user-guides/projects.md`;
  re-capture the `herleitung` PNGs. **Release note:** **yes**,
  `task release:note -- projekt-einblenden`. **Verify:** `task fe:test`,
  `task fe:screenshots`, `task verify:fast`, plus a Compose run of the whole loop.

### P3.7 — Mounts survive escalation, and the cap is measured

- **Files:** `frontends/aiq_api/src/aiq_api/jobs/runner.py`,
  `src/aiq_agent/agents/deep_researcher/models/state.py`,
  `frontends/ui/src/lib/jobs/service.ts`,
  `frontends/benchmarks/oib_retrieval/src/oib_retrieval_eval/runner.py`,
  `tests/benchmarks/test_turn_shapes_live.py`.
- **Change:** escalation carries the mounted set as `collection_scope` through the
  header replay (`runner.py:1120-1150`), so a deep run reads exactly what the Büro
  turn could read; no project identity travels, so `remember` stays off there by
  the contract test rather than by a comment. The register digest is fetched by the
  worker the way memory is (`runner.py:1198-1219`). The harness gains the K=1 vs
  K=5 latency comparison and the RRF fairness check (per-channel hit share across
  five project channels), with the baseline recorded in its README. **The cap does
  not move in this plan.**
- **Tests:** `tests/aiq_api/` — a workspace escalation replays every mount and no
  project id; the contract test still passes for `deep_research_agent`.
- **Docs:** `docs/architecture/deep-research.md` (the scope a run inherits); the
  harness README.
- **Release note:** no. **Verify:** `task be:test:api`, `task be:eval:retrieval`,
  `OPENROUTER_API_KEY=… task be:eval:turn-shapes`.


**Phase 3 gate:** p95 time-to-first-token at five mounts ≤ 1.5× the one-mount
baseline; the knowledge layer refuses an unsigned or expired grant (test); the cap
has exactly one implementation (grep `maxMountedProjects` returns the service and
its spec). **Size: 12-15 engineer-days.**

---

## Phase 4 — Sharing and organization memory

**Goal:** the Büro can remember, and a Büro conversation can be shared without
leaking a project through it. **Value:** office knowledge accumulates where the
office asks, and a colleague can be brought into an office thread. **Spec:**
`AG-8, AG-9, AC-7, AC-8`.

- **P4.1 `org:memory:write` and `remember` in the Büro.**
  `frontends/ui/src/lib/authz/catalog.ts`,
  `frontends/ui/src/app/api/internal/memory/route.ts`,
  `frontends/ui/src/lib/projects/memory-service.ts`,
  `src/aiq_agent/agents/project_memory/register.py`: the permission ("Let Piloti
  record findings in organization memory") closes the gate
  `GRID_ALLOW_AGENT_ORG_MEMORY` holds shut today
  ([ADR-0008](../docs/adr/0008-project-and-organization-memory.md), audit finding
  S1). The internal memory route checks it for the acting user before an
  organization-scoped write; `remember` keeps its `OrgMemoryDisabledError` branch,
  which already degrades to a proposal card (`register.py:167-180`), so until the
  permission is granted the Büro's `remember` proposes instead of writing — the
  wanted default. *Tests:* `memory-service.spec.ts` and the route spec — an org
  write without the permission is refused with the existing code. *Docs:*
  `docs/architecture/project-memory-design.md`, plus the now-closed ADR-0008 gate
  in ADR-0054's follow-ups. *Release note:* yes,
  `task release:note -- buero-gedaechtnis`. *Verify:* `task fe:test` +
  `PYTHONPATH=src .venv/bin/pytest tests -q`; ask before
  `task fe:provision:authz -- --apply`.
- **P4.2 Sharing a workspace conversation.**
  `frontends/ui/src/lib/conversations/service.ts`,
  `frontends/ui/src/lib/sharing/registry.ts`,
  `frontends/ui/src/lib/workspace/mounts-service.ts`: lift the phase-1
  private-only guard. A workspace conversation may be granted only to a recipient
  holding `project:view` on **every** mounted project, checked at grant **and**
  re-checked at read (the read check survives a later revocation). Mounting into a
  shared conversation re-validates every participant and refuses the mount, naming
  who would lose access, rather than silently widening. *Tests:* the FGA
  integration spec gains a member refused the share, and refused the read when the
  mount happened after the grant. *Docs:*
  `docs/design/collaboration-sharing-and-inbox-spec.md`, and
  [`adding-a-shareable-resource-type.md`](../docs/architecture/adding-a-shareable-resource-type.md)
  §1/§3 if anything generic had to move. *Release note:* yes,
  `task release:note -- buero-chat-teilen`. *Verify:* `task fe:test` +
  `task db:test:rls`.
- **P4.3 BIM tools take their project explicitly.**
  `src/aiq_agent/agents/bim/{register,measure_register}.py`,
  `src/aiq_agent/project_context.py`,
  `tests/aiq_agent/test_tool_context_contract.py`: `ifc_query` and `ifc_measure`
  read a project id from the context and refuse without one
  (`bim/register.py:840-875`, `measure_register.py:2169-2200`); in the Büro there
  is none. Give both an explicit `project_id` argument that must name a **mounted**
  project, validated against the turn's mount registry, and declare their real
  needs in `TOOL_CONTEXT_REQUIREMENTS` (*Correlated debt* §D5). *Tests:* the
  contract test picks them up; a call naming an unmounted project returns a
  refusal string. *Docs:* `docs/api/python-endpoints.md`. *Release note:* no.
  *Verify:* `PYTHONPATH=src .venv/bin/pytest tests -q`.

**Phase 4 gate:** the tenancy integration test covers grant-time and read-time;
`TOOL_CONTEXT_REQUIREMENTS` has no tool reading an identity it does not declare.
**Size: 5-6 engineer-days.**

---

## Phase 5 — Portfolio-Recherche and Sammlungen

**Goal:** the only path that reads more than the cap, and a name for a set of
projects. **Value:** kind D — "vergleiche die Brandschutzkonzepte aller
Bezirk-3-Projekte" becomes a deep-research run instead of a refusal. **Spec:**
`DR-4…DR-8, GR-2`.

- **P5.1 Portfolio sub-runs.** `src/aiq_agent/agents/deep_researcher/`,
  `frontends/aiq_api/src/aiq_api/jobs/runner.py`: the deep researcher iterates
  readable projects **sequentially**, one sub-run per project with its own scope,
  bounded by the run's budget (ADR-0015) and a project count in the plan. No new
  agent, no new store. *Tests:* `tests/aiq_api/` — the iteration respects the
  budget, and a project that errors does not fail the run. *Docs:*
  `docs/architecture/deep-research.md`, plus the "first artifact shipped" note in
  [`cross-project-rag-vision.md`](../docs/roadmap/cross-project-rag-vision.md).
  *Release note:* yes. *Verify:* `task be:test:api` + one Compose run.
- **P5.2 Sammlungen.** `frontends/ui/src/lib/db/schema/project-sets.ts` **(NEW)**,
  migration `0084_project_sets.sql` **(NEW)**, `ScopeTree`: two secured tables
  (`project_sets`, `project_set_members`) and a set that mounts as one unit
  through the same endpoint — the cap still applies to the resulting project
  count, in the same one place. *Tests:* RLS coverage; a set larger than the cap
  is refused with the cap wording. *Docs:* `docs/database/schema.md`, the UI doc.
  *Release note:* yes. *Verify:* `task db:test:rls` + `task verify:fast`.
- **P5.3 Raise the cap, if the measurement says so.**
  [`environment-variables.md`](../docs/deployment/environment-variables.md) and
  the harness README, only after P3.7's numbers pass with room to spare and real
  traces show users hitting the cap. By measurement, never by request
  ([ADR-0044](../docs/adr/0044-retrieval-correctness-and-the-measurement-gate.md)).
  *Verify:* `task be:eval:retrieval`.

**Size: 8-10 engineer-days**, and the least certain number here.

---

## Correlated substrate debt this plan pays

Defects already on this path. YAGNI forbids unused features, not known defects
where you are walking ([`AGENTS.md`](../AGENTS.md), "Correlated substrate debt").
Each is its own commit, in the slice named.

| # | Debt | Why it is on this path | Paid in |
|---|---|---|---|
| D1 | `docs/technical-reference/collection-scoping.md` described a `MAX_SCOPE_COLLECTIONS` constant that does not exist | This plan introduces the real bound and would otherwise inherit a doc that contradicts it | **Already paid** — §"Upper bound on collections" now states there is no cap in code and points at `GRID_WORKSPACE_MAX_MOUNTED_PROJECTS`. Keep it in step when P3.2 lands. |
| D2 | The silent active-project fallback: `buildCollectionScopeFromRequest` resolves `user_preferences.active_project_id` and, when that project fails `project:chat`, degrades to unscoped rather than failing (`collection-scope-request.ts:158-160, 177-188`) | The Büro is exactly the "no project" caller that path was invented for. Leaving it, a Büro turn could silently acquire a project's corpus from a stale preference | **P1.4** — the workspace mode never consults the preference. The project-mode fallback stays, with its comment narrowed to what it actually covers (global listings), and a spec pins it. |
| D3 | `conversationMatchesProject` fails open for a null `projectId` (`features/chat/lib/project-scope.ts:18-27`) | With workspace conversations, "no project" stops meaning "legacy" and starts meaning "a different surface". Fail-open would put every Büro thread in every project's history | **P1.5** — an explicit scope branch; project chat keeps today's fail-open for genuinely legacy rows. |
| D4 | Document summaries live only in the Python `DocumentMetadataStore` (`knowledge/document_metadata_store.py:256-334`, the `aiq_jobs` database), written once at ingest | The Steckbrief wants a one-line summary per document and the BFF cannot read it | **Not paid here, and said so out loud.** P2.2 ships `doc_class` + folder instead. Lifting it means writing the summary back to `grid_app.documents` at ingest completion — a migration, an ingest callback and a backfill, which is its own change. Recorded in `docs/architecture/adding-a-shareable-resource-type.md` §3 style: a known leak with a named lift. |
| D5 | `remember`, `ifc_query` and `ifc_measure` read a project id from the context without declaring it in `TOOL_CONTEXT_REQUIREMENTS` (`agents/project_memory/register.py:130`, `agents/bim/register.py:840-875`, `agents/bim/measure_register.py:2169-2200`); only `project_memory_remember` is in the contract | The Büro is the first context where that id is legitimately absent, so the undeclared readers all degrade at once, each in its own way | **P4.3** for BIM (declaration + explicit argument); **P4.1** for `remember`'s org branch. The contract test then covers every tool that reads an identity. |
| D6 | `GRID_AUTHZ_CACHE_TTL_MS` defaults to `0`, i.e. the FGA check cache is off (`lib/authz/resource-check.ts:29-46`) | Register recall runs `listProjects` — N parallel FGA checks — on every Büro turn, and P3.3 re-authorizes every mount on every upgrade. At 40 projects that is 40 uncached round trips per turn | **P2.4** documents the requirement and **recommends a 30-60 s TTL for deployments that enable the Büro**; the code default stays `0` because turning it on is a security tradeoff a deployment makes, not a plan. The env-var row gains the sentence, and the recall path is measured with and without it in P3.7. |

---

## Risks, mitigations, and the gate that catches each

| Risk | Why it is real | Mitigation | Caught by |
|---|---|---|---|
| **Header size.** The scope header and its signed envelope both carry five collections with ids and names | Node's default max header size is 16 KB and the envelope duplicates the payload; five entries with 80-char names is ~1.2 KB per copy — fine, but nothing pins it | Truncate `projectName` to 80 chars at the builder; assert total header bytes in a spec at the cap | P3.3 spec (`collection-scope-request.spec.ts`, size assertion) |
| **FGA fan-out cost.** `listProjects` is N parallel checks with no bulk list-objects, uncached by default | An org with 40 projects pays 40 checks per Büro turn for recall, plus one per mount per upgrade | Over-fetch then filter (P2.4); recommend `GRID_AUTHZ_CACHE_TTL_MS=30000` for Büro deployments (D6); mount re-authorization is at most `cap` checks | P3.7 latency run; the recall spec asserts the call count |
| **Revocation window.** A grant stays valid for its TTL, and persisted mounts are re-checked only on the next upgrade | Identical to the window project chat already accepts, but now it is five projects instead of one | 15-minute grant TTL; re-authorization on every upgrade; the cap bounds the blast radius; stated in ADR-0054's consequences so nobody rediscovers it as a surprise | P3.4 grant-expiry test |
| **Prompt drift.** The office branch and the project branch are one prompt today and two prompts by accident tomorrow | ADR-0052 moved two behaviours from code to prompt and they need a live eval; this adds two more | Two office shapes in the live turn-shapes eval, asserted on the trace; ADR-0054 names the drift signal (a shared persona core) so the answer is not "add a router" | `task be:eval:turn-shapes` (weekly CI, `turn-shapes-live.yml`) |
| **RRF fairness with several project channels.** Fusion is RRF k=60 over per-collection rank channels with a base-first tie-break, tuned for four shelves | Five project channels plus base plus Archiv is seven; a long-tail project can crowd out the base corpus, or vice versa | Measure per-channel hit share at K=5 on the golden set before the cap moves; the tie-break stays untouched in this plan | P3.7, `task be:eval:retrieval` |
| **Register staleness.** The Steckbrief is a derived copy of four sources | A stale row points at the right project with slightly old facts — tolerable — but only if the writers stay wired | Four write-through points plus `stale_at` plus a nightly bounded reconcile; a spec per writer | P2.3 specs |
| **A Büro answer that should have mounted and did not** | The model decides; nothing in code can | Prompt branch demands honesty about answering from the register alone; one of the two office turn shapes asserts exactly that | `task be:eval:turn-shapes` |

**Measured gates (brief §4) and their harness files:** **tenancy** —
`frontends/ui/src/lib/workspace/register-recall.integration.spec.ts` plus the
mounts specs under `task db:test:rls` (both added to `scripts/rls-test-db.sh`),
with coverage by name in `frontends/ui/src/lib/db/rls-coverage.spec.ts`;
**retrieval and latency** —
`frontends/benchmarks/oib_retrieval/fixtures/oib_workspace_golden.json` (20 Büro
questions, kinds A/B/C) through
`frontends/benchmarks/oib_retrieval/src/oib_retrieval_eval/runner.py`, right
project in the top-3 register hits ≥ 90%, no regression on the 52-entry Baurecht
set, p95 TTFT at K=5 ≤ 1.5× K=1 (`task be:eval:retrieval`); **contract** —
`tests/aiq_agent/test_tool_context_contract.py` green for both entry paths against
`WORKER_IDENTITY_HEADERS` (`frontends/aiq_api/src/aiq_api/jobs/runner.py:119`);
**turn shapes** — `tests/benchmarks/test_turn_shapes_live.py`
(`task be:eval:turn-shapes`).

---

## Size

| Phase | Engineer-days | Confidence |
|---|---|---|
| 1 — Büro-Chat Basis | 4-5 | High. Schema, one route, one client, existing components. |
| 2 — Projektregister | 8-10 | Medium. Builder and writers are straightforward, embedding + hybrid recall is a known shape from `project_memory`; the prompt branch and its eval are the uncertain half. |
| 3 — Einblenden | 12-15 | Medium-low. Grant, contextvar registry and `ScopeTree` are a day or two each; attribution touches ten citation files, and the measurement may send the cap back for retuning. |
| 4 — Sharing + memory | 5-6 | Medium. The sharing rule is small; re-validating participants on every mount is where the edge cases live. |
| 5 — Portfolio + Sammlungen | 8-10 | Low. Sequential sub-runs under a budget is unexplored territory in this codebase. |

**Total: 37-46 engineer-days**, phases 1-3 being the 24-30 that make the feature
real. Every number assumes one engineer who has read
[`frontends/ui/AGENTS.md`](../frontends/ui/AGENTS.md) and
[`src/aiq_agent/AGENTS.md`](../src/aiq_agent/AGENTS.md), and excludes the two
design documents this plan executes.
