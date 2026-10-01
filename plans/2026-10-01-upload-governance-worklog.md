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
