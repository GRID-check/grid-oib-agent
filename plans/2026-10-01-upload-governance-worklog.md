# Upload governance — working log (2026-10-01, overnight)

Branch `claude/nvidia-toolkit-data-validation-rbnyi6`. Request, in the user's words:
can the NVIDIA Agent Toolkit validate that nothing sensitive is uploaded; can an
organization build its own roles (WorkOS) and restrict folders and their documents
to the people holding them; screen new uploads against admin-defined sensitive
terms and hold matches in a quarantine an admin clears before anything reaches a
model; notify the uploader in the inbox when an ingestion completes, with a modal
summarising what arrived and where. Plus triage of the ten "Upload & Datenablage"
tickets (Jonathan, 1 Oct 2026). Done means evidence.

Entries are appended in time order. Each says what was done, what it proved, and
where the evidence is.

## Log

- **Orientation.** HEAD `f62552a`. NAT installed: `nvidia-nat` 1.9.0 (core,
  langchain, mcp, eval, profiler, opentelemetry, phoenix). Prior art found:
  `docs/audit/pilot-feedback-triage-2026-09.md` already established that the
  Archiv is one table (ADR-0024), that `projects` has no status column, that a
  per-org blacklist does not exist (org `settings` jsonb is its home), and that
  `@redactpii/node` is already bought for the platform-lessons scrub.
- **WorkOS, read-only (Staging `environment_01KEF0YG238…`).** FGA is live with
  three resource types `organization → project → skill`; no `folder` type. Seven
  organization roles (member, admin, org-auditor, org-billing-admin,
  org-knowledge-manager, org-compliance-officer, org-user-admin) and four
  project-scoped roles (project-viewer, -contributor, -editor, -admin), all
  environment-wide. Role config: `multipleRolesEnabled: false`,
  `ssoRoleAssignmentEnabled: false`, `dsyncRoleAssignmentEnabled: false`.
  The API offers organization-scoped `createRole`, resource-scoped role
  assignments, and Directory-Sync group→role mappings — the last is the
  "take the rights over from the office server" path Ticket 6 asks the CTO about.

### Research results (six agents, all read-only)

**Does the NVIDIA Agent Toolkit screen uploads for sensitive data? No.**
- NAT 1.9.0 as installed (`nvidia-nat`, `-core`, `-langchain`, `-mcp`, `-eval`,
  `-profiler`, `-opentelemetry`, `-phoenix`, `-atif`) has no content
  inspection. Its middleware hooks registered functions and an allowlist of
  component methods (`nat/middleware/utils/workflow_inventory.py:29-53`); the
  built-ins are cache, circuit breaker, logging, timeout, HITL. The only
  redaction is span-attribute blanking on telemetry export
  (`nat/observability/processor/redaction/*`), which we already use.
- The matching package is **`nvidia-nat-security` 1.9.0** (not installed;
  wheel downloaded and read). Its `pii_defense` is Presidio with
  `language="en"` hard-coded (`defense_middleware_pii.py:116`), US-centric
  entities, and inspects function **output only** (`post_invoke`; no
  `pre_invoke`). `content_safety_guard` and the verifiers are LLM-judged harm
  checks. The NeMo Guardrails middleware (Colang 1.0) wraps chat input/output.
- NeMo Guardrails' `sensitive_data_detection` is also English-only
  (`actions.py:55-64`, `en_core_web_lg`). `nvidia/gliner-PII` (570M, CPU-capable,
  NVIDIA Open Model License) is trained on English synthetic data; German
  quality unverified. NeMo Curator's PII modifier is gone in 1.x. nv-ingest has
  no PII feature.
- **None of these hook document ingestion.** Our ingest runs in the knowledge
  layer's own ingestor, not through a NAT embedder, so NAT middleware never sees
  an uploaded file. Nothing in the NVIDIA stack classifies a document as an
  invoice, a fee agreement or payroll.
- Conclusion: the gate is ours to build, local and rule-based, at the one place
  every upload passes before its first model call.

**Where content leaves the deployment during ingest** (`sources/knowledge_layer/src/llamaindex/adapter.py`),
in order, all through the ZDR seam to OpenRouter: (1) OCR of scanned pages
`route_pdf_pages` :4450; (2) image captioning ~:4486; (3) VLM enrichment of
embedded images/drawings :4620; (4) summary + tag classification ~:4743;
(5) embeddings :4847. Before (1): download from our bucket, local pdfium
thumbnail, **local pdfplumber extraction :4443**, office/text extractors ~:4535.
The BFF calls no external model during upload (Gotenberg and the IFC parse are
in-cluster). So the content gate belongs right after local extraction.

**Upload path.** Picker → name probe (names only) → `validateFileUpload` →
one multipart XHR per file → `uploadDocument` (`lib/documents/service.ts:931`)
→ S3 put → `admitOrDiscard` → `dispatchDocument` (:1304) → `/v1/ingest` →
durable queue (`ingest_job_queue`, Python DB) → `_run_ingestion`. Archiv and
chat uploads take the same `dispatchDocument`. `documents.status` is plain text
whose vocabulary is `DOCUMENT_STATUS_FACTS`; `stored` is the precedent for
"bytes here, deliberately not dispatched". No server-side batch id exists;
completion is only seen by lazy reconciliation on read.

**Authorization.** Roles are fixed in `lib/authz/catalog.ts` and provisioned to
WorkOS; custom roles exist only via the dashboard; the session reads `role` and
`permissions` but not `roles`. FGA covers projects and skills. No per-folder
access exists; `documents.visibility = 'private'` can be set and **nothing on
the read side enforces it** (live gap). Retrieval is scoped by the signed
collection list; the folder filter is post-hoc and chunks carry no folder or
document id. A new collection per restricted folder makes every Python read
path inherit the restriction; a deny-list would need ~10 separate sites.

**WorkOS.** Custom (organization-scoped) roles: `POST
/authorization/organizations/{id}/roles`, slug must start `org-`, permissions
set via `PUT …/roles/{slug}/permissions`; SDK 10.12 has
`createOrganizationRole`, `setOrganizationRolePermissions`,
`listOrganizationRoles`, `deleteOrganizationRole`. Custom roles behave like
environment roles in sessions. Multiple roles is an environment-wide switch
(off today); with it on, the token's `roles: string[]` lists them. FGA is
purely additive (no deny), so it cannot express "restricted child folder".
Groups exist (GA 2026-04) but do not reach the token.

**Inbox.** A new type is five touch-points and no migration
(`INBOX_ITEM_TYPES`, `INBOX_TYPE_DEFINITIONS`, `INBOX_TYPE_PRESENTATION`,
i18n, emitter). The item view carries only subject/excerpt/href, so a summary
modal must fetch its own data. No type opens a modal today.

### Decisions taken with the user (2026-10-01)

1. Restricted folders: **organization admins see everything** (the existing
   `org:projects:administer` bypass holds).
2. Files whose text cannot be read locally (scans, plans without a text layer):
   **filename check only**, and the upload summary says the content was not
   checked.
3. Quarantine is cleared by **org admins and the project's admins**.
4. **All roles live in WorkOS, as custom roles** (workos.com/docs/rbac/custom-roles).
   Anything role-shaped held outside WorkOS moves there. Ticket 9 is out of scope.

### Build log

- **Screening and quarantine (ADR-0077).** Commits `c0d7a3f`..`b5265fd`. Name gate in
  the browser and on the server, content gate in the ingest job before the first
  model call, quarantine status, release tied to the content hash, admin pages
  for the list and the queue. Revert checks: dispatch screening 5/6 red,
  reconcile mapping 3 red, hook gate 2 red, Python hook 7/10 red, raster
  `partial` 2 red. Found on the way: Windows-1252 previews decoded C1 controls on
  Node 22 (`ee5f7a9`, 3 red on revert).
- **Upload batches and the inbox (migration 0103).** `5ce3bdf`, `19b0e69`. Settlement
  runs on reconcile and on the scheduler sweep; the completion SQL guard is
  proven against Postgres (1 red on revert, RLS suite 136/136).
- **Summary dialog and history.** `e666a48` (built by a subagent, reviewed and extended):
  uploader names resolved server-side, files in folders hidden since the upload
  left out (1 red on revert). `15a76d2`: the inbox payload carried German place
  names to English readers; only a project name travels now (1/43 red on
  revert). `1dee1c8`: Archiv `?doc=` links never opened their document, which
  also broke shared Archiv links (1/22 red on revert).
- **Folder access (ADR-0078).** `735f21c`: custom roles through WorkOS, the
  session's roles claim, org-own role lookups first, the restriction table,
  placement into per-folder collections. `dd927de`: every BFF read path asks
  `folder-access.ts`; uploads file into the folder's collection; one name per
  project across collections. Seven revert checks, each red; one test was
  vacuous (destination check passed with the fix removed) and was fixed.
  **Leak found and closed:** the name screen ran before the visibility check,
  so an upload aimed at a hidden folder called „Honorare" was refused with a
  message naming it.
- **Container restart** mid-run stopped three subagents (retrieval scope,
  Python/purger, roles UI); their edits survived on disk and they were resumed.
- **Triage** of the remaining tickets: `docs/audit/upload-and-filing-triage-2026-10.md`.
- **Retrieval and leak controls (ADR-0078).** `7a9baf7`: restricted collections enter
  the signed scope only for an interactive chat turn of a cleared member on a thread
  confined to them; the v1 proxy requires clearance; a thread whose answers cite or
  read a restricted collection cannot be shared, escalated or widened. Ten revert
  checks, each red. `57a0a00`: a thread shared while its socket is open — the socket
  now asks the BFF per turn and closes (4412) when the thread is no longer confined.
  `f49c97c`: memory writes refused in a turn whose scope holds a restricted collection
  (scope, not hits: the inventory block has already put every in-scope summary in the
  prompt); the purger reaches every collection of a project.
- **Found and fixed on the way: conversation sharing was dead since #813** (`4504bc1`).
  A uuid guard on a text column answered null for every real conversation id
  (`s_<uuid_with_underscores>`): every share 404'd, and the WebSocket conversation gate
  passed every id as "not created yet", so any member could open a turn on a
  colleague's private thread. Verified against the code before committing; flagged in
  the PR for the team to decide disclosure.
- **Placement retried by the scheduler** (`dad1062`), proven against Postgres: purge
  before re-point, a failed purge leaves the row, the sweep finishes it (2 red on
  revert through the real database). Discovery outside a tenant context was caught by
  the real-DB run, not by the unit specs.
- **Review findings (CodeRabbit), all four real and fixed:** retry lost the release and
  the destination folder (`7486204`); the quarantine queue limited before authorizing
  (`f85a481`, keyset cursor proven against Postgres); PDF table text from a page the
  text pass lost was embedded unscreened (`ff47f30`); spreadsheet truncation reported
  `clean` (`ff47f30`, extended in `32397b2` to columns and long cells).
- **Self-corrections.** Committed an integration spec that failed `tsc` (vitest skips
  integration specs without a database, so only the typecheck sees them): run
  `tsc --noEmit` before every commit that touches a spec. The full UI run found seven
  suites the targeted runs missed (folder access reaching the database through
  `getAccessibleDocument`); ratcheted with `@/test-utils/folder-access` and a gotchas
  row indexed by the symptom.
- **Container restarts:** two, mid-run. Uncommitted work survived on disk both times;
  stopped agents were resumed from their transcripts. The full vitest run in one
  process exceeds the container's memory; run it in shards.
- **Independent verification, round one.** A verifier that wrote none of the code tried
  to refute eight claims against a throwaway Postgres with the full migration chain.
  Four held: no model call before the screen (1), restricted collections only in an
  interactive chat scope (4), no permission escalation through custom roles (7), tenant
  isolation of the new tables (8). The rest were refuted in part, and `4ef628f` fixes
  what they and the follow-up review turned up: placement stopped after its first page
  of candidates and never reconciled a row in flight; two ingests of one file into
  different collections shared a dispatch key; the overview, document roles and the
  cached prompt view still counted documents in hidden folders; `folders/ensure` told a
  caller a hidden folder existed; a folder delete or move could carry documents out of
  a restriction without `project:manage`; the intake wizard's upload skipped the name
  screen; BIM routes read models in hidden folders; and a restricted turn's mark lived
  in memory only (now migration 0105, `conversation_restricted_turns`). Full UI suite
  after the fix, four shards: 11,383 passed, 0 failed. CI green on `4ef628f`.
- **Memory decision (product owner, 2 Oct).** Writing nothing from a restricted turn
  felt broken: „Restricted shouldn't feel like that it should feel like a first
  thought." Chosen: **restricted memory**. A memory carries the restricted collections
  it came from and is served only to people cleared for all of them; what the turn
  cited or read decides, and when that says nothing an LLM judge classifies, failing
  closed to every restricted collection in scope. Migration 0106.
