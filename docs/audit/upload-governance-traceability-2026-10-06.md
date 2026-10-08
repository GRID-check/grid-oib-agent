# Upload governance: traceability audit (PR #838 at `8bb2200d3`)

> **Migration numbers are those at `8bb2200d3`.** Before it merged, the branch folded its
> intermediate 0106 (`restricted_roles`), 0107 (`conversation_restricted_turns`) and 0108
> (`restricted_collections`) into the final designs and renumbered: 0110→0106, 0109→0107,
> 0111→0108, 0112→0109, 0113→0110. [`database/schema.md`](../database/schema.md) has the
> numbers as shipped.
>
> Since then develop took migrations 0104–0106 and ADR-0079–0082 (#847), so these numbers moved again: migrations 0104→0107, 0105→0108, 0106→0109, 0107→0110, 0108→0111, 0109→0112, 0110→0113; ADR-0079→0083, ADR-0080→0084, ADR-0081→0085.

Audited 2026-10-06 against the code, not the docs. Papierkorb audited separately on
`wave2-folder-deletion` (`3f0bf4850`). No repo file was edited.

**The short answer.** Most of the request is built and the tests pass. The core promises
still have five gaps:

- per-FILE access does not exist;
- the Büroablage cannot be restricted;
- a quarantined file is readable by everyone in the project;
- the upload preview has no access controls;
- the Papierkorb is not on this branch.

Several smaller indirect paths are open too (§3).

Paths below are relative to the repo root. `ui/` means `frontends/ui/src/`.

---

## 0. Test runs behind every MET verdict

Each batch was run in one process. The whole UI suite was never run in one process.

| Batch | Command (abridged) | Result |
|---|---|---|
| **A** screening, upload batches, upload UI | `vitest run src/lib/upload-screening src/lib/upload-batches src/features/uploads …/folder-upload-dialog.spec.tsx …/folder-upload-plan.spec.ts …/upload-screening-card.spec.tsx …/quarantine-queue.spec.tsx …/settings-ownership.spec.ts …/InputArea.screening.spec.tsx …/internal/chat-screening/route.spec.ts` | **17 files passed, 1 skipped; 248 passed, 6 skipped** (the skip is the DB integration spec, run in **R**) |
| **B** folder access, roles | `vitest run …/folder-access.spec.ts …/custom-roles.spec.ts …/org-role-permissions.spec.ts …/membership-roles.spec.ts …/folder-access-settings.spec.ts …/folder-service.access-change.spec.ts …/collection-placement.prompt-view.spec.ts …/placement-sweep.spec.ts …/prompt-view.spec.ts …/proposal-decisions.spec.ts …/folder-access-dialog.spec.tsx …/custom-roles-section.spec.tsx src/app/api/organization/roles …/model-service.folder-access.spec.ts` | **14 files, 220 passed** |
| **C** restricted use, sharing, inbox, downloads, memory | `vitest run …/restricted-use.spec.ts …/restricted-egress.spec.ts …/sharing/{access,service,registry}.spec.ts …/inbox/targets.spec.ts …/rights-lost.route.spec.ts …/conversations-client.rights-lost.spec.ts …/sessions-store.rights-lost.spec.ts …/internal/document-file/route.spec.ts src/lib/download-log …/memory-service.spec.ts …/service.memory-access.spec.ts …/conversations/live.spec.ts` | **15 files passed, 1 skipped; 275 passed, 16 skipped** (the skip is the integration spec, run in **R**) |
| **D** documents, tasks, conversations, feedback, profile | `vitest run …/documents/service.spec.ts …/generated.spec.ts …/reviewers.spec.ts …/tasks/delegation.spec.ts …/projects/service.spec.ts …/conversations/service.spec.ts …/assignments/service.spec.ts …/mentions/service.spec.ts …/feedback/service.spec.ts …/profile-service.spec.ts` | **10 files, 462 passed** |
| **E** Langfuse erasure and retention | `vitest run workers/langfuse-traces.spec.mjs purger/purge-conversation.spec.mjs purger/purge-project.spec.mjs scheduler/index.spec.mjs scheduler/db.spec.mjs` | **5 files, 140 passed** |
| **F** signed image route | `vitest run src/app/api/documents/[id]/image/route.spec.ts src/lib/images` | **4 files, 50 passed** |
| **P** Python, agent and knowledge layer | `pytest tests/aiq_agent/knowledge/{test_collection_read_inventory,test_inventory,test_restricted_collections,test_restricted_use,test_scoping}.py tests/knowledge_layer_tests/{test_restricted_reads,test_upload_screening,test_upload_screening_ingestion}.py tests/aiq_agent/memory/test_restriction.py tests/aiq_agent/common/test_content_screen.py tests/aiq_agent/agents/piloti/{test_confined_turn,test_register_restriction_facts,test_restricted_tool_round}.py tests/aiq_agent/turn/{test_context,test_subject_document}.py -q` | **792 passed** |
| **P2** chat socket | `cd frontends/aiq_api && pytest tests/test_chat_socket.py tests/test_ingest_screening.py tests/test_internal_api_chat_screening.py -q` | **103 passed** |
| **P3** memory | `pytest tests/aiq_agent/memory -q` | **154 passed** |
| **R** real Postgres (`bash scripts/rls-test-db.sh`) | 19 integration specs as `grid_app_rw`, among them `folder-access`, `restricted-use`, `memory-restricted`, `upload-batches`, `collection-placement`, `folder-visibility`, `download-log`, `tenant-isolation` | **19 files, 230 passed**, plus 1 file, 9 passed; down migrations 0086, 0092, 0097 and 0108–0112 verified; exit 0 |
| **W** wave2 worktree | `scripts/rls-test-db.sh` (port 55439) and `vitest run folder-bin-panel.spec.tsx purger/purge-folder.spec.mjs folder-access.spec.ts` | **18 files, 232 passed** (`folder-bin.integration.spec.ts` included, 28 cases) **+ 9**; unit **3 files, 79 passed**; 0106–0111 down migrations verified |

No test failed anywhere. A row marked MET points at the batch whose spec proves it.

---

## 1. NVIDIA Agent Toolkit: re-checked today against primary sources

### Current versions (PyPI JSON API, 2026-10-06)

| Package | Latest | Uploaded | Requires-Python |
|---|---|---|---|
| `nvidia-nat`, `nvidia-nat-core` | **1.9.0** | 2026-09-10 | — |
| `nvidia-nat-security` | **1.9.0** | 2026-09-10 | **`<3.14,>=3.11`** |
| `nvidia-nat-rag` | 1.9.0 | — | `<3.14,>=3.11` |
| `nvidia-nat-ingestion` | 1.4.3 (meta-package, no code) | — | `<3.14` |
| `nemoguardrails` | **0.24.1** | 2026-09-16 | **`>=3.10,<3.14`** |
| `nvidia-rag` | 2.6.0 | — | `<3.14` |

- No 1.10 pre-release exists. The newest uploads are the 1.9.0rc series and 1.9.0, sorted by upload time.
- Installed in `.venv`: the 1.9.0 family (core, langchain, mcp, eval, profiler, opentelemetry, phoenix, atif).
- **Not installed:** `nvidia-nat-security`.
- **This repo runs Python 3.14.7**, so neither `nvidia-nat-security` nor `nemoguardrails` can be installed here at all.
- `nvidia-nat-security`'s `guardrails` extra pins `nemoguardrails<0.22,>=0.11`.

Sources:

- https://pypi.org/pypi/nvidia-nat/json
- https://pypi.org/pypi/nvidia-nat-security/json
- https://pypi.org/pypi/nemoguardrails/json
- https://pypi.org/simple/ (the `nvidia-nat-*` list)
- https://github.com/NVIDIA/NeMo-Agent-Toolkit/releases/tag/v1.9.0 (released 10 Sep)
- Wheels downloaded and read: `nvidia_nat_security-1.9.0` (sha256 `ac6851a8…edbefc`) and `nemoguardrails-0.24.1` (sha256 `4fcfc9d9…31680f`, the same hash ADR-0079 cites).

### What the code does (read in the wheels)

**`nvidia-nat-security` 1.9.0: `pii_defense`.**
- It is Presidio. `defense_middleware_pii.py:116` calls `analyze(…, language="en")`.
- Default entities, `:53-60`: PERSON, EMAIL, PHONE, CREDIT_CARD, **US_SSN**, LOCATION, IP.
- It implements **`post_invoke` only** (`:238`), so it checks function **output** and never input.
- The same holds on the GitHub `develop` and `main` branches today: `raw.githubusercontent.com/NVIDIA/NeMo-Agent-Toolkit/{develop,main}/packages/nvidia_nat_security/src/nat/plugins/security/middleware/defense/defense_middleware_pii.py` still has `language="en"` and only `post_invoke`.

**`nvidia-nat-security` 1.9.0: the other middleware.**
- `content_safety_guard` and `output_verifier`: `post_invoke`, LLM-judged.
- `pre_tool_verifier`: input, but LLM-judged instruction-violation detection, not PII.
- The Guardrails middleware (`nemo_guardrails_middleware.py:58-67,96,140`) runs input rails on `pre_invoke` against a NAT **function's** arguments and output rails on `post_invoke`.
- It wraps NAT functions only. Our ingest is not a NAT function (worklog: `sources/knowledge_layer/src/llamaindex/adapter.py`), so it never sees an uploaded file.

**NeMo Guardrails 0.24.1.**
- `library/sensitive_data_detection/actions.py:59-68,150` needs `en_core_web_lg` and passes `language="en"`.
- `library/gliner/` is NVIDIA GLiNER-PII, called over HTTP (hosted `integrate.api.nvidia.com` or a local NIM). It has input, output and **retrieval** flows (`flows.co:5-67`); the retrieval flow scans retrieved chunks, not ingestion.
- `library/regex/` has input, output and retrieval flows, with a static per-deployment config.
- None hooks document ingestion.
- Docs: https://docs.nvidia.com/nemo/guardrails/latest/configure-guardrails/guardrail-catalog/pii-detection lists only "input / output / retrieval" flows, says nothing about language, and notes that retrieval runs on `LLMRails` only.

**`nvidia/gliner-PII` model card** (https://huggingface.co/nvidia/gliner-PII). Its language tag is "English", with 570M parameters. German is not mentioned.

**`nvidia-nat-rag` 1.9.0 and `nvidia-rag` 2.6.0.**
- `enable_guardrails` (default False) is "content safety". The blueprint description says Guardrails "can filter or reshape the **query**".
- It does nothing at ingestion.

### German, and input versus output

| Component | German | Acts on |
|---|---|---|
| `pii_defense` | No: `en` hard-coded | Output only |
| Guardrails sensitive-data rail | No: `en_core_web_lg` | Chat input, output, retrieval |
| GLiNER rail | English-trained, German unverified | Chat input, output, retrieval |
| Regex rail | Language-neutral, but a static deployment config and no office list | Chat input, output, retrieval |

Nothing acts on uploads.

### Does the 1 October conclusion hold?

**Yes.** `plans/2026-10-01-upload-governance-worklog.md` concluded that nothing in the NVIDIA stack screens uploaded documents, that `pii_defense` is English Presidio on output only, that the Guardrails sensitive-data rail is English-only, and that the gate is ours to build. All of that still holds against today's latest releases.

Two corrections and additions:

1. The worklog does not mention that `nvidia-nat-security` and `nemoguardrails` both declare `Requires-Python <3.14`. ADR-0079's 2 Oct amendment does note it for Guardrails. On this repo's 3.14.7 they are not merely unsuitable: they are uninstallable.
2. The worklog did not look at `nvidia-nat-rag`, `nvidia-nat-ingestion` or Guardrails' `regex` and `gliner` rails. They add nothing at ingestion.

---

## 2. Traceability table

**Status key.** MET = built and proven by a test I ran. PARTIAL = built in part, or built without a proving test. GAP = missing or unverified. Sizes: S ≤ 1 day, M ≤ 1 week, L > 1 week.

### 2a. The product owner's request, sentence by sentence

| # | Requirement | Status | Evidence (code · test) | What is missing · fix sketch · size |
|---|---|---|---|---|
| Q1 | Does the NVIDIA Agent Toolkit validate that users do not upload sensitive data? | MET (answered) | §1 | — |
| Q2 | Exclude certain documents for certain people | PARTIAL | Per-folder only: `ui/lib/authz/folder-access-rule.ts:90` `effectiveFolderLevel`, `ui/lib/documents/access.ts:66-82` · B `folder-access.spec.ts`, R `folder-access.integration.spec.ts` | No per-document access (T6.1). No restriction in the Büroablage (T6.4-d). |
| Q3 | People in an organization self-build roles with WorkOS | MET | `ui/lib/authz/custom-roles.ts`, UI `custom-roles-section.tsx` · B `custom-roles.spec.ts`, `custom-roles-section.spec.tsx`, `app/api/organization/roles` | Constraint: WorkOS Production has `multipleRolesEnabled: false` and `dsyncRoleAssignmentEnabled: false` (queried today via the WorkOS API, read-only). Each person holds ONE org role, so a custom role must also stand in for the base role (see CTO row). |
| Q4 | Only show the folders and documents inside them to the people with access | PARTIAL | Project folders: list, search, preview, download and agent are all filtered (§3) · B, C, D, P, R | The Büroablage cannot be restricted: `ui/lib/documents/access.ts:46-52` lets any member read an Archiv document, and `lib/archiv/folder-service.ts` has no access code. Chat attachments are by conversation only. |
| Q5 | "Like Genesis cloud workspaces" | PARTIAL | Folder tree with read/write per role, a lock marker and a dialog | No per-file sharing, no cross-project view (see T6.4-o). |
| Q6 | Uploads screened for sensitive information the admin defines | MET | Name gate: `ui/lib/upload-screening/name-screen.ts:121`, server repeat at `ui/lib/upload-screening/service.ts:121`. Content gate: `ingestScreeningFor` at `ui/lib/documents/service.ts:420` → `adapter.py:2860` `_screen_or_quarantine`. Policy: `ui/lib/upload-screening/policy.ts:52` · A `name-screen.spec.ts`, `content-screen.spec.ts`, `upload-screening-card.spec.tsx`; P `test_upload_screening_ingestion.py::TestAQuarantinedFileReachesNoModel` | — |
| Q7 | Matches go to a quarantine the admin screens before anything is ingested by the LLM | PARTIAL | Status `quarantined`; release only by reviewers (`ui/lib/upload-screening/review.ts:38,66`) · A `review.spec.ts`, `quarantine-queue.spec.tsx`; P (no model call before the gate) | (a) **A quarantined file is readable by every project member, and in the Büroablage by every org member**: `getAccessibleDocument` (`ui/lib/documents/access.ts:37-93`) has no status check, so download, preview, text preview and PDF stream all serve it (`ui/lib/documents/service.ts:2012,2116,2210,2275`). The listing shows it too. Fix: in `getAccessibleDocument` and the list query, serve a `quarantined` row only to its uploader and `mayReviewQuarantine`, and add a spec. **S**. (b) The queue has no preview or open link, so the admin cannot look at the file from where they decide (`quarantine-queue.tsx`). **S**. |
| Q8 | "We don't want to upload any sensitive data to an LLM at all" | PARTIAL | The gate sits before OCR, VLM, summary and embeddings (P, 792 passed) | Residual by decision or by design: (i) scans and images are checked by NAME only, then OCR or VLM sends their content to a model (PO decision of 1 Oct; ADR-0079). (ii) Content terms are words and three checksum detectors; there is no German PII model. (iii) Documents ingested before screening existed, or before a term was added, are never re-screened. Fix: an org-level "re-screen the corpus" job over existing chunks. **M**. (iv) Text that reaches a model by doors ADR-0079 lists as "Neutral" (task instructions, deep research over REST, org instructions, skills, project profile, review comments) is not masked. (v) Platform feedback and lessons (§3 row 16). |
| Q9 | "…and not propagated to the other users" | PARTIAL | See §3 | Gaps in §3 rows 4, 8, 11, 13, 16, 17, 19 and Q7(a). |
| Q10 | When an ingestion completes, the user gets an inbox notification whose modal summarises the files, what they contain and which categories they went to | MET | `ui/lib/upload-batches/settle.ts:48-81` emits `upload.completed`; target `ui/lib/inbox/targets.ts:252-257` → `/app/uploads/<id>` `RouteDialog` (`ui/features/uploads/components/upload-summary.tsx:226`) with counts, document types, folders, per-file summary and tags · A `settle.spec.ts`, `upload-summary.spec.tsx`, `upload-summary.spec.ts`; C `targets.spec.ts`; R `upload-batches.integration.spec.ts` | Caveat: intake-wizard uploads (`ui/features/projects/components/document-role-field.tsx:179-181`) open no batch, so they get no notification, summary or history entry. Fix: open and seal a batch there. **S**. |

### 2b. Ticket 4, „Übersicht – Was ist angekommen?"

| # | Requirement | Status | Evidence · test | Missing · fix · size |
|---|---|---|---|---|
| T4.1 | At a glance: what is new or changed, what is being uploaded, what was refused (with reason), what is protected | PARTIAL | Tally keys `ready, reading, quarantined, failed, stored, unchanged, excluded` (`ui/features/uploads/lib/upload-summary.ts:257`); quarantine reasons per file (`uploaded-file-row.tsx:52,118-131`); name-screen exclusions as term and count (`upload-summary.tsx:88-99`) · A `upload-summary.spec.tsx`, `upload-summary.spec.ts` | (a) **"Changed" is not shown.** A file that became a new version of an existing document (ADR-0054) is counted like a new one: `UploadSummaryDocument` (`ui/lib/upload-batches/service.ts:128-142`) has no `replaced` flag, although the upload knows it (`shelf-upload.ts:117` `replaced`). Fix: record `replaced` on the row or the batch and add a "Neue Fassung" tally. **S**. (b) **"Protected" is not shown.** Nothing marks a file filed into a folder with its own access list. Fix: add `restricted: boolean` from `getProjectFolderAccess` and a lock in the row. **S**. |
| T4.2 | Click to see each file; something refused can still be taken in | PARTIAL | Per-file rows link to the file (`upload-summary.ts:357`); a quarantined file can be released by a reviewer (`review.ts:66`, `organization/quarantine`) · A `review.spec.ts`, `quarantine-queue.spec.tsx` | (a) Only the uploader's own uploads can be opened: `findOwnUploadBatch` at `service.ts:80`, history links only own rows (`upload-history.tsx:6-8,63-71`). (b) Name-screened files cannot be taken in afterwards; their names are not even kept, only term and count. The uploader must upload again and tick „trotzdem hochladen". (c) An uploader who is not a reviewer cannot request a release from the summary. Fix: a „Freigabe anfragen" action that notifies the reviewers. **S**. |
| T4.3 | A history shows every upload of a project | PARTIAL | `ui/lib/upload-batches/service.ts:255` `listProjectUploadHistory`, mounted in `project-settings.tsx:220` · A `upload-history.spec.tsx` | (a) Capped at the 50 newest uploads with no paging (`upload-batches/repository.ts:21,170`), so "all" is not met. Fix: a keyset cursor. **S**. (b) Uploads from before migration 0105, and intake-wizard uploads (Q10), are missing. (c) **Leak:** the counts include documents in folders hidden from the reader (`repository.ts:143-159` has no folder filter); see §3 row 17. |

### 2c. Ticket 5, „Blacklist"

| # | Requirement | Status | Evidence · test | Missing · fix · size |
|---|---|---|---|---|
| T5.1 | An org-defined list of terms; files and folders with them in their name are not uploaded | MET | Every path segment is matched, folder path included (`name-screen.ts:121`; `use-file-upload.ts:338-344`; `folder-upload-plan.ts:346`); server repeat `shelf-upload.ts:345-349` · A `name-screen.spec.ts`, `folder-upload-plan.spec.ts` | — |
| T5.2 | The office creates and changes the list itself; Piloti suggests a default list to adopt or adjust | MET | `SUGGESTED_SCREENING_POLICY` (`policy.ts:52-81`), in force until the office saves its own; Organisation → Sensible Daten card; `PUT /api/organization/upload-screening` (`org:settings:manage`), audited as `org.upload_screening.updated` (`upload-screening/service.ts:79`) · A `upload-screening-card.spec.tsx` (8 cases including „Use suggestion" and read-only without the permission), `settings-ownership.spec.ts` | The route has no spec of its own; it is covered only through `authz-coverage` and the card. |
| T5.3 | Excluded files are never transferred, not even briefly | PARTIAL | The browser filters before the XHR (`use-file-upload.ts:333-346`; the plan's `excluded` action) · A `folder-upload-plan.spec.ts`, `folder-upload-dialog.spec.tsx` | (a) **Names are sent before screening.** `propose` sends every dropped file name to the server's name probe in parallel with loading the policy (`ui/features/documents/hooks/use-upload-decision.ts:98-103`), so „Lohnzettel_Mai_Huber.pdf" reaches the BFF. Fix: screen first, then probe only names that are not excluded. **S**. (b) If the office's policy cannot be loaded, the browser falls back to Piloti's suggested list (`adapters/api/upload-screening-policy.ts:22-31`), and its policy cache is 60 s. A file that matches only an office-specific term, or a term added a minute ago, is transferred and only then refused by the server. Fix: block the upload when the policy is unavailable, or put an ETag on the policy. **S**. |
| T5.4 | Before uploading, the user sees what would be excluded and why | MET for project and Büroablage uploads, PARTIAL for chat | The decision dialog opens for any excluded file (`use-upload-decision.ts:110-121`; `folder-upload-dialog.tsx:458-481`) · A `folder-upload-dialog.spec.tsx`, `folder-upload-plan.spec.ts` | Chat attachments and the intake wizard only show a message after the fact (`describeScreenedOut`); there is no preview. **S**. |
| T5.5 | Single files can still be released (e.g. a Bauvertrag in „Verträge") | MET for project and Büroablage | Per-file checkbox (`folder-upload-dialog.tsx:472`) → multipart `screeningRelease=name` → audited `document.screening_overridden` (`upload-screening/service.ts:143`). The content gate still runs, because only a reviewer release skips it (`policy.ts:144-151`) · A `folder-upload-dialog.spec.tsx`; D `documents/service.spec.ts` | There is no release path for chat attachments or the intake wizard. |
| T5.6 | AI Act: transparency, logging, human oversight | PARTIAL | See §2f | See §2f. |

### 2d. Ticket 6, „Zugriffsrechte für Ordner und Dateien"

| # | Requirement | Status | Evidence · test | Missing · fix · size |
|---|---|---|---|---|
| T6.1 | Access can be set for folders **and individual files** | **GAP for files**, MET for folders | Folders: `project_folder_grants`, `setFolderAccess` (`ui/lib/projects/folder-access-settings.ts:142`) · B `folder-access-settings.spec.ts`, `folder-access-dialog.spec.tsx`; R `folder-access.integration.spec.ts`. Files: `documents.visibility` (`ui/lib/db/schema/documents.ts:250`) can be set to `private` through the sharing registry (`lib/sharing/registry.ts:263-293`), but **no read path enforces it**: `getAccessibleDocument` ignores it, and neither listings nor retrieval read it. | No per-file access exists. Fix (one PR each): (1) remove or refuse `private` on documents so the dead switch cannot mislead (**S**); (2) per-document grants with the same rule, the document as a leaf under its folder's chain in `effectiveFolderLevel`, a read-restricted document placed in its own collection (or a hidden system folder), plus listing, search, agent and egress (**L**). |
| T6.2 | A folder's rights apply automatically to everything inside, including files uploaded later | MET | Inheritance and "nesting only narrows" (`folder-access-rule.ts:90`); upload into a restricted folder files into its collection (`shelf-upload.ts:410-414`) · B `folder-access.spec.ts` (24-row table); D `documents/service.spec.ts` › "restricted folders (ADR-0080) › files an upload into the collection its folder puts it in"; R `collection-placement.integration.spec.ts` | — |
| T6.3 | During upload the user sees the folder structure in the preview and sets **there** which folders or files are restricted and for whom; Piloti points out conspicuous files in open folders, but the user decides | **GAP** | `folder-upload-dialog.tsx` and `folder-upload-plan.ts` contain no access controls (no grants, roles or restriction). Restricting is a separate folder-menu action after the fact (`file-workspace.tsx:493`). The name gate **blocks** a matching file whatever the destination's access (`shelf-upload.ts:345-349` passes no access info); it does not hint "this is in an open folder, restrict it?". The content gate then quarantines a real fee document even inside a properly restricted „Honorare" folder. | Fix: (1) in the plan, a per-folder „Zugriff" chip that opens the grants editor, applied by `folders/ensure` before the files go (**M**); (2) turn a name match into a warning with „restrict this folder" when the target folder is open, and exempt or soften it when the target restricts reading (**M**, product decision first: tickets 5 and 6 currently contradict each other here). |
| T6.4 | No one without access finds these files in search or in Piloti's answers, nor indirectly | PARTIAL | §3, item by item | Gaps in §3 rows 4, 8, 11, 13, 16, 17, 19, and Q7(a). |
| T6.5 | Those authorised see which folders are restricted and for whom | MET | The listing carries `grants` per folder (`ui/lib/projects/folder-service.ts:95,125`); lock marker and dialog · B `folder-access-dialog.spec.tsx`, `folder-service.access-change.spec.ts`; previews at `/dev/folder-access` | — |
| T6.CTO | CTO decision: roles and groups; can rights be taken over from the office server? | PARTIAL (decision open) | Roles: decided (ADR-0080, ADR-0081). Groups: rejected (ADR-0080 "WorkOS Groups"). | **Taking rights over from the office server: no decision is recorded and nothing is built.** WorkOS Production today has `dsyncRoleAssignmentEnabled: false` and `multipleRolesEnabled: false`. Fix: an ADR on Directory Sync group→role mapping, and on "one role per person" versus enabling multiple roles (which changes `membership.role` single-role assumptions, e.g. `settle.ts:107`). **S** for the ADR; **M** to build. |

### 2e. Binding later decisions

| # | Decision | Status | Evidence · test | Missing |
|---|---|---|---|---|
| D1 | Restricted memory kept, with an LLM judge | MET | `src/aiq_agent/memory/restriction.py:458` `decide_restriction` (fails closed), `register.py:358-362`; judge configured `configs/config_oib_openrouter.yml:613` (`judge_llm: card_llm`); BFF `project_memory.restricted_folder_ids`, served only to people cleared now · P `test_restriction.py`; P3 154 passed; R `memory-restricted.integration.spec.ts` | Residual: a judge that says "not drawn" makes a note open. That risk is accepted by the decision; judge verdicts are only logged, not audited. |
| D2 | Chat screened by "mask and let me choose", against the office list only | MET | Composer `InputArea.tsx` + `ChatScreeningNotice`; socket `chat_socket.py:1167` `_masked`; BFF `conversations/service.ts` `screenedUserInputs`; one matcher `content_screen.py:661` · A `InputArea.screening.spec.tsx`; P `test_content_screen.py`; P2 `test_chat_socket.py`; D `conversations/service.spec.ts` | — |
| D3 | Restriction per person; a chat records only the folders it used | MET | `restricted-use.ts:317,356`; agent `restricted_use.py:248,262,328` · C `restricted-use.spec.ts`; R `restricted-use.integration.spec.ts`; P `test_restricted_use.py`, `test_restricted_tool_round.py`, `test_collection_read_inventory.py` | — |
| D4 | Read and write access per folder | MET | `effectiveFolderLevel`, `requireFolderWrite` on every write path · B `folder-access.spec.ts`, `folder-service.access-change.spec.ts`; D `documents/service.spec.ts`; R | ADR-0081 itself says nothing enforces that a NEW write path calls `requireFolderWrite`. |
| D5 | No webhook; roles from the membership with a 60 s cache | MET | `ui/lib/auth/membership-roles.ts:34` · B `membership-roles.spec.ts`, `org-role-permissions.spec.ts`, `folder-access.spec.ts` (`clearanceOf`) | `requireProjectAccess` still reads `org:projects:administer` from the token, so a demoted admin keeps project-level reach until the token refreshes (ADR-0081 "Bad"). |
| D6 | A shared chat whose reader lost access stays listed with a "no rights" notice | MET | `ui/lib/sharing/access.ts:170,212` `contentLocked` / `ResourceRightsLostError` · C `rights-lost.route.spec.ts`, `sessions-store.rights-lost.spec.ts`, `conversations-client.rights-lost.spec.ts`, `sharing/access.spec.ts` | ADR-0081: a locked chat cannot yet be left from its own screen. |
| D7 | Deleted folders go to a 14-day Papierkorb; an org setting decides who sees derived content | **GAP on this branch**; PARTIAL on `wave2-folder-deletion` | Head: deleting a folder soft-deletes it to a tombstone, with no bin, purge or setting. Wave2 `3f0bf4850`: `lib/projects/folder-bin.ts`, `purger/purge-folder.js`, `lib/organizations/deleted-folder-content.ts`, bin UI · W 232 + 9 integration passed (28 `folder-bin` cases), 79 unit passed | **Not ported.** Wave2 branches from `f2a4beb86`, behind head by 9 commits touching folder access (e.g. `91f686bbf` membership-derived bypass, `f46405442` move rule, `0f3664f1b` role guard, `a0164d276` Archiv folders). `git merge-tree` reports **22 conflicts**, including `folder-access.ts`, `folder-access-repository.ts`, `documents/service.ts`, `project-folders.ts` and ADR-0079↔0081. Its migration `0111_folder_bin.sql` collides with head's `0111_project_memory_restricted_folders.sql` and must become 0113. **M**. |
| D8 | Every download is logged | MET | `ui/lib/download-log/service.ts:102` `recordDocumentAccess`; coverage gate `download-log/coverage.spec.ts` · C (download-log specs); R `download-log.integration.spec.ts` | — |
| D9 | No separate GDPR erasure action and no GDPR wording users see | MET | No `DSGVO`/`GDPR` in `ui/i18n/dictionaries` on head or on wave2 (wave2 dropped the dialog in `3f0bf4850`) | No test enforces the absence; it is a grep, not a ratchet. |
| D10 | Langfuse: per-chat erasure plus 30-day retention through the native API | MET | `ui/workers/langfuse-traces.js` (`DELETE /api/public/traces`, batches ≤ 1000); purger `purge-conversation.js`, `purge-project.js`; scheduler retention sweep and erased-chat sweep; env var documented (`environment-variables.md:449`) · E 140 passed | Traces without a session id (ingest model calls over restricted documents) only age out after 30 days. Folder purge → trace erasure exists only on wave2. |

### 2f. AI Act (T5.6), worked out

**What applies.**
- Piloti is a **limited-risk** system. ADR-0079 and `docs/compliance/compliance-audit-2026-07.md:14` say the same. It is not Annex III: architecture and planning are not listed, and the blacklist decides nothing about employees.
- **Art. 50(1)** (tell people they are interacting with AI) applies since **2 Aug 2026**.
- **Art. 50(2)** (machine-readable marking of synthetic text) applies from **2 Dec 2026** for systems on the market before 2 Aug. The Digital Omnibus entered into force on 27 Jul 2026 (Goodwin, Aug 2026: https://www.goodwinlaw.com/en/insights/publications/2026/08/alerts-technology-dpc-eu-ai-act-transparency-obligations-now-in-force).
- **Art. 4** AI literacy applies since Feb 2025.
- Logging (Art. 12) and human oversight (Art. 14) are high-risk duties, not legally required here. They are still good practice, and the ticket asks for them.
- The screening itself is deterministic rules, so it is arguably not an "AI system" at all. The memory judge is AI.

**What exists.**
- Transparency notice in the composer (`InputArea.tsx:2174`) and the Art. 50 legal page (`lib/legal/content/de.ts:205`).
- `aiProvenanceMarking` for filed documents (`lib/ai-provenance.ts`) and the DOCX export (`answer-export/docx.ts:211`).
- The screening UI names the rule behind each verdict and says when content was not checked.
- Logging: `org.upload_screening.updated`, `document.screening_overridden`, `document.quarantine_released`, the download log.
- Human oversight: quarantine release by a human, mask-or-edit chosen by the user, file changes proposed and never written.

**What is missing.**
1. Quarantining (the system's own decision) writes no audit event; only release does. **S**.
2. The memory judge's verdicts are logged but not audited, and the user is not told that a model decided a note's audience. **S**.
3. The compliance audit lists Art. 50(2) machine-readable marking of chat and card output, and Art. 4 literacy material, as open (`compliance-audit-2026-07.md:80-82`). I could not verify that they are closed: unverified, so GAP. **M**.
4. There is no short AI-Act note for the screening feature itself: what it is, its limits, who oversees it. **S** (doc).

---

## 3. Leak matrix (ticket 6, „auch indirekt")

A path with no control, or a control without a test, is a GAP.

| # | Path by which restricted-folder content could reach someone else | Control (file:line) | Test (ran) | Verdict |
|---|---|---|---|---|
| 1 | Agent retrieval and tools | Restricted collections enter the signed scope only for an interactive turn of a cleared member, narrowed to the conversation's audience: `ui/lib/collection-scope-request.ts:137-151` → `restricted-use.ts:317`. Each tool round is admitted or withheld: `src/aiq_agent/knowledge/restricted_use.py:328` `admit_tool_results`, reporting at `:248,262`. Listing is not use: `sources/knowledge_layer/src/browse.py`, `read_passage.py`, `view_image.py`. Every NAT function is classified. | P `test_restricted_use.py`, `test_restricted_tool_round.py`, `test_restricted_reads.py`, `test_collection_read_inventory.py`, `test_confined_turn.py`; C `document-file/route.spec.ts` | **CLOSED.** Residual per ADR-0081: a tool outside Piloti's `ToolNode` gets no admission. |
| 2 | Memory | `project_memory.restricted_folder_ids`, served only to people who can read every folder now (`memory-service.ts:888-918`); the judge fails closed (`restriction.py:458`); org memory demoted to project (`register.py:363-366`); no `memory_proposal` card for a restricted finding (`register.py:247-255`) | P `test_restriction.py`, P3; C `memory-service.spec.ts`, `service.memory-access.spec.ts`; R `memory-restricted.integration.spec.ts` | **CLOSED**, with the judge's residual (D1). |
| 3 | Shared chats | Share allowed only to people cleared for every recorded folder; read gate `sharing/access.ts:170,212`; open sockets re-check per turn | C `restricted-use.spec.ts`, `sharing/{access,service}.spec.ts`, `live.spec.ts`, rights-lost specs; R `restricted-use.integration.spec.ts` | **CLOSED** |
| 4 | Inbox items | Read-time redaction for `contentLocked` and for documents in hidden folders (`inbox/targets.ts:121-137`; `sharing/access.ts:134`) | C `targets.spec.ts` | **CLOSED for redaction.** Reviewer fan-out: a person named or assigned is not checked against the folder (ADR-0081 "Bad"); the read side still redacts. |
| 5 | Reports and filed drafts | `requireMayFileFrom` (`restricted-egress.ts:109`) in `documents/generated.ts:547` and `lifecycle.ts:1087` | C `restricted-egress.spec.ts`; D `generated.spec.ts` | **CLOSED** |
| 6 | Deep research, runs, tasks started from a chat | `requireMayLeaveConversation` in `tasks/delegation.ts:288` (task) and `:503` (research); job scope is project-only (`jobs/service.ts:937-950`) | D `delegation.spec.ts`; C `restricted-egress.spec.ts` | **CLOSED** (by refusal; phase 4 "inherit" not built) |
| 7 | Card proposals and `PROPOSAL_DECISIONS` | Conversations with a record are left out (`conversations/repository.ts:565-568`); `project_profile_patch` refused in confined turns (`cards/envelope.py:154,240`) and at the BFF (`profile-service.ts:163-174`); quoted lines masked (`proposal-decisions.ts:191-197`) | R `memory-restricted.integration.spec.ts` › PROPOSAL_DECISIONS; B `proposal-decisions.spec.ts`; D `profile-service.spec.ts` | **CLOSED.** Note: the BFF refusal depends on the browser sending `conversationId` (`profile/patches/route.ts:21`), which is optional. |
| 8 | Revision tasks (`sourceText`) | **None.** `lifecycle.ts:499-545` `openRevisionTask` reads the draft's text and calls `delegateTask` with `conversationId: version.originConversationId ?? null`. For a version with no origin chat, the confinement check sees no conversation and passes. Nothing checks the document's folder. The task's goal (reviewer comment), its filed filename and its run are listed to every `project:view` member (`tasks/service.ts:339-366`). | none | **GAP.** Fix: refuse or skip the revision task when the document's folder restricts reading (`restrictsReading` on its path), or tag the task with folder ids and filter `listTasks`. Add a spec. **S** |
| 9 | Previews, thumbnails, downloads, exports | `getAccessibleDocument` (`documents/access.ts:76,80`) on every byte path (`service.ts:2012,2116,2210,2275,2328`); signed image URLs re-check the person's folder access on use (`service.ts:2391-2415`); every hand-over logged; message export behind the conversation read gate | D `documents/service.spec.ts`; F `image/route.spec.ts` (`isFolderVisibleToMember`); C `download-log/coverage.spec.ts` | **CLOSED for restriction.** Residual: a presigned S3 URL stays valid for its TTL after revocation (accepted, user guide). **Quarantined files are not covered: Q7(a) GAP.** |
| 10 | Search snippets | `searchProjectDocuments` (`service.ts:746-772`) searches only the reader's cleared restricted collections and joins rows with `hiddenFolderIds` | D `documents/service.spec.ts` › "searches the restricted collections this reader is cleared for, and joins only visible rows" | **CLOSED** |
| 11 | Notifications | In-app only; no email sender exists (`inbox/delivery.ts:10-11`). Quarantine notices name no file (`settle.ts:117-140`). | A `settle.spec.ts`; C `targets.spec.ts` | **CLOSED today.** Note: `reviewersOf` checks only one role (`settle.ts:107`) and the first directory page (`:89-93`). |
| 12 | Audit logs shown to non-admins | **None.** Audit events carry filenames of restricted documents (e.g. `shelf-upload.ts:127-132`, `documents/service.ts:1835,1928`, `review.ts:114`) and go to the WorkOS audit portal, readable with `org:audit:view`, which the **non-admin** `org-auditor` and `org-compliance-officer` roles hold (`authz/catalog.ts:457-464,481`; confirmed in WorkOS Production today). | none | **GAP** (names only, not content). Fix: hash or omit `filename` for a document whose folder restricts reading, or treat `org:audit:view` holders as cleared and say so in ADR-0081. Add a spec. **S** |
| 13 | Langfuse traces | Per-chat erasure plus 30-day retention (D10); masked chat text never reaches traces | E 140 passed | **PARTIAL.** It is retention, not access: the platform team can read restricted prompts, chunks and answers for up to 30 days. Ingest-time model calls on restricted documents carry no session id and are not erased with the chat. Accepted by D10; worth naming to the product owner. |
| 14 | Project prompt-view cache | The `documents:` block names nothing in a folder not every member reads; placement drops the cache before and after (`collection-placement.ts:270,274`) | B `collection-placement.prompt-view.spec.ts`, `prompt-view.spec.ts` | **CLOSED** (millisecond race acknowledged in ADR-0081) |
| 15 | Multi-project scenario („alle Wohnbau-Projekte") | Grants are per folder per project, and every project chat is single-project | B, R | **PARTIAL.** (a) No cross-project policy: the Praktikant is kept out only if each project's „Angebote/Zimmerer" folder is restricted by hand. There are no folder templates and no project category such as "Wohnbau". Fix: org folder templates with grants applied on project creation. **M**. (b) **The Büroablage cannot be restricted** and is in every project's retrieval scope (`documents/access.ts:46-52`; `lib/archiv/folder-service.ts` has no access code; Archiv folders arrived in `a0164d276`). Office-wide Personal or Honorar files placed there reach every member and every chat. Fix: extend `effectiveFolderLevel` to Archiv folders with per-folder collections under `archiv_<org>_r…`. **M–L** |
| 16 | Platform feedback and lessons (cross-tenant) | **None for restricted content.** A down-voted answer's question and answer text (`platform-lessons/repository.ts:66-90`) is distilled by a model into a lesson injected into **every org's** turns (PII scrub and auditor only); the platform answer-feedback view and CSV export show raw question and answer to Piloti staff (`app/api/platform/answer-feedback/export/route.ts`). Neither excludes conversations in `conversation_restricted_folders`. | none | **GAP.** Fix: exclude feedback whose conversation has a restricted-folder record from `listUnprocessedDownvotes` and from the feedback health and export queries (`not exists … conversation_restricted_folders`). Add a spec. **S** |
| 17 | Upload history (metadata) | **None.** `countBatchDocumentsByStatus` (`upload-batches/repository.ts:143-159`) counts every document, so a member sees "12 files, 3 quarantined" for a batch that went into a folder hidden from them (who, when, how many). | none | **GAP** (metadata). Fix: filter by `hiddenFolderIds` as the summary does (`service.ts:200-206`). **S** |
| 18 | Quarantined files to other project members | See Q7(a) | none | **GAP** (S) |
| 19 | Pre-upload name probe | Every dropped file name is sent to the BFF before screening (T5.3a) | none | **GAP** (names leave the office). **S** |

---

## 4. Prioritised gap list

Ordered by risk to "no sensitive data to an LLM, nothing propagated to other users". Each item is one PR.

1. **Quarantined files are readable by every project or org member** (Q7a, §3-18). Serve a `quarantined` row only to its uploader and its reviewers, in `getAccessibleDocument` and the list query, with a spec on download, preview and text. **S**.
2. **The Büroablage cannot be restricted** (§3-15b, Q4). Office-wide personnel and fee files placed there reach everyone and every chat. Extend folder access and per-folder collections to Archiv folders. **M–L** (split: rule plus listing first, then retrieval collections).
3. **Per-file access does not exist; `documents.visibility='private'` is settable and enforced nowhere** (T6.1). PR a: refuse `private` on documents (**S**). PR b: per-document grants (**L**).
4. **Revision tasks quote a restricted draft into a project-wide task** (§3-8). Refuse or skip when the document's folder restricts reading. **S**.
5. **Platform feedback and lessons carry restricted answers across tenants and to Piloti staff** (§3-16). Exclude conversations with a restricted record. **S**.
6. **Papierkorb not on this branch** (D7). Port wave2: rebase onto head (22 conflicts), renumber 0111 → 0113, re-run W and R. **M**.
7. **The upload preview cannot set access, and the name gate blocks rather than hints by destination** (T6.3). PR a: a „Zugriff" chip per folder in the plan (**M**). PR b, after a product decision: a name match into an open folder warns and offers restriction, and a restricted destination is exempt from the name block (**M**).
8. **The name probe leaks excluded file names before screening** (T5.3a). Screen first, then probe. **S**.
9. **The browser's fallback list and 60 s policy cache let office-specific terms through** (T5.3b). Block the upload when the policy is unknown. **S**.
10. **Audit portal shows restricted filenames to non-admin auditors** (§3-12). Redact, or document auditors as cleared. **S**.
11. **Upload history counts documents in hidden folders** (§3-17). Filter. **S**.
12. **The existing corpus is never re-screened** when screening starts or a term is added (Q8 iii). A re-screen job. **M**.
13. **Upload summary does not show "changed" (new version) or "protected"** (T4.1). **S**.
14. **History is capped at 50 and intake-wizard uploads have no batch** (T4.3, Q10). Paging plus a batch in `document-role-field.tsx`. **S**.
15. **Refused files cannot be taken in from the overview by the uploader** (T4.2). A „Freigabe anfragen" action, and a preview link in the quarantine queue. **S**.
16. **CTO decision on office-server rights, and on one role versus multiple roles** (T6.CTO). ADR first. **S**.
17. **AI Act loose ends** (§2f). Audit quarantine and judge decisions (**S**); confirm Art. 50(2) marking and Art. 4 material (**M**); a short feature note (**S**).
18. **Cross-project folder templates** for the „alle Wohnbau-Projekte" scenario (§3-15a). **M**.
