# Continuous improvement ledger

A loop state file, not a plan. One row per iteration in §3, appended by whoever
runs the loop: **what was examined, what was found, what changed, evidence**.
The backlog in §2 is re-ranked at the top of each iteration from what the last
one learned — an item that survives three iterations untouched is either
mis-sized or not worth doing, and saying so is a legitimate outcome.

Distinct from its neighbours on purpose. [`backlog.md`](../../backlog.md) is the
2026-07 loop's tier queue and is stale in both directions (it still lists PF-1
and PF-9 open; both are closed at this tip). [`docs/audit/overnight-run-log.md`](../audit/overnight-run-log.md)
is a frozen record of a finished loop. This file is the live one, and it is
scoped to the *whole product* rather than to one branch.

**How to append.** Add a row to §3 with an id (`I<n>`), the sources you read,
the item ids you moved, and a verification line naming the command that proved
it. Then edit the affected §2 rows in place — strike them, do not delete, so the
next reader can see what the loop has already spent. Every claim here carries a
file path, a PR number or a doc section; a row without one is a guess and should
be marked as such.

**Ranking rule.** User impact per unit of effort, not severity. **R = ratchet**:
the item is (or contains) a test, a lint rule or a schema constraint that stops
a *class* of regression rather than one instance. Ratchets are cheap and
compound, so they outrank equal-impact one-offs. Sizes are S (hours), M (a day
or two), L (needs an ADR or a dependency decision).

## 1. What this survey verified as already closed

Do not re-do these; the backlog and the triage doc still list some of them open.

- **PF-1 `view_knowledge_image` unwired** — declared and bound at
  `configs/config_oib_openrouter.yml:431,668,891`.
- **PF-9 the 100 MB batch ceiling on durable corpora** — `frontends/ui/src/features/documents/validation.ts:348`
  now guards the total-size cap with `!context.durableCorpus`.
- **PF-7 / PF-8 drag-and-drop and folder upload** — PR #625, #626, #627.
- **PF-3 the re-upload ghost** — migration `0074`, unique live document per
  `(organization, collection, filename)`.
- **Task list has a consumer** — `frontends/ui/src/features/tasks/components/tasks-panel.tsx`
  reads `GET /api/projects/[id]/tasks` and is mounted at
  `frontends/ui/src/features/automation/components/automation-panel.tsx:101`,
  which closes the "no UI reads it" finding in
  [`piloti-writes-perspective-review.md`](piloti-writes-perspective-review.md) §3.4.
- **`sources/` suites run in CI** — `.github/workflows/ci.yml:133`.

## 2. The backlog

| # | R | Item | Why it matters | Size | Done when | Depends on |
|---|---|---|---|---|---|---|
| 1 | R | Record the pilot's deployed SHA and the three feature flags, and log them at boot | `GRID_SKILLS_ENABLED`, `GRID_COLLABORATION_ENABLED`, `GRID_ENFORCE_FEATURE_FLAGS` all default `false` (`deploy/compose/docker-compose.coolify.yaml:511,517,605,606`), so a pilot org may have no inbox, sharing, mentions, jobs or skills at all — [`agentic-workspace-architecture.md`](agentic-workspace-architecture.md) §8 | S | A startup log line and a health-endpoint field name the SHA and each flag's effective value, and the triage doc records what the pilot is actually running | — |
| 2 |  | A reviewer picker on submit, plus a `project:edit` fallback in `resolveReviewers` | An unassigned draft cannot be submitted, which is step one of the review round-trip every release note describes ([`piloti-writes-perspective-review.md`](piloti-writes-perspective-review.md) §3.1; `frontends/ui/src/lib/documents/reviewers.ts:99`) | M | Submitting a draft with no explicit reviewer resolves to the project's `project:edit` members and returns 200, with a spec that fails without the fallback | — |
| 3 |  | Let a solo commissioner exit „In Prüfung" on their own scheduled report | Two-person offices and sole Ziviltechniker have no exit; item 2 makes it a dead end (§3.2 of the same doc) | S | A scheduled report commissioned by the only `project:edit` member reaches `approved` without a second account | 2 |
| 4 | R | Run the `packages/` suites in CI | ~636 tests behind `packages/ifc-spatial*` back a default-on feature that renders compliance verdicts, and no CI job runs them (`.github/workflows/ci.yml` has no `packages` step; `AGENTS.md` "Two gates sit outside `task verify`") | S | A CI job runs them and a deliberately broken assertion fails the PR | — |
| 5 | R | Three drafting cases in the live turn-shape harness — commission, revise, file | No turn on the Piloti-writes branch was validated against a live model; `tests/benchmarks/test_turn_shapes_live.py` has three cases and none is a drafting turn ([perspective review](piloti-writes-perspective-review.md) §3.3, §5) | S | `task be:eval:turn-shapes` covers the three verbs and the weekly `turn-shapes-live.yml` run reports them | — |
| 6 | R | Cache fail-open tests for `common/cache.py` and `lib/cache/index.ts` (audit option E6) | The fail-open contract ADR-0020 leans on is asserted nowhere, and neither module counts hits ([`latency-and-caching-audit-2026-09.md`](../architecture/latency-and-caching-audit-2026-09.md) §4.4) | S | A fake client that raises on every op leaves `get_json` returning the local value and `eval_script` returning `None`, under test | — |
| 7 | R | An ESLint rule requiring an org identifier in every cache key (option E3) | Keys are ad-hoc f-strings at 28 call sites and the tenant leak that invites is already in `docs/contributing/gotchas.md:36` as something that happened | S | The rule sits beside `eslint-rules/require-tenant-scope.mjs` and a global-key allowlist; a new unscoped key fails lint | — |
| 8 | R | Fix the four duplicate ADR numbers and make `scripts/check_adrs.py` catch them | `0027`, `0039`, `0044`, `0047` are each two files (`ls docs/adr/ \| sed 's/-.*//' \| sort \| uniq -d`); the collisions predate the checker ([agentic-workspace](agentic-workspace-architecture.md) §8) | S | Each number is one file and the checker fails on a re-introduced collision | — |
| 9 | R | Verify `subjectId` against the member roster for `scope='member'` budget policies | `frontends/ui/src/lib/budgets/service.ts:596` — an admin can store a policy for an arbitrary user id; it never matches spend, so the limit silently does nothing | S | A policy for a non-member is refused, with a test | — |
| 10 | R | A cross-service contract test for the job fire path's headers | ADR-0046's Risks section records the 403 that broke every scheduled run in a real deployment; the lesson was written down and the test was not ([agentic-workspace](agentic-workspace-architecture.md) §8) | S | A test asserts the exact header envelope the BFF sends against what the worker requires, and fails when either moves | — |
| 11 |  | Surface a request or trace id on `ErrorBanner`, and wire OTEL into the compose deployment | `grep -c OTEL_ deploy/compose/docker-compose.coolify.yaml` is `0`; a user cannot say why a turn failed and an operator cannot look it up ([agentic-workspace](agentic-workspace-architecture.md) §8) | M | A failed turn shows an id the operator can find in a trace | 1 |
| 12 |  | `projects.status` (aktiv / abgeschlossen) and the closing form | `frontends/ui/src/lib/db/schema/projects.ts` has no status column at all; this is the valuable half of the pilot's archive proposal and nothing in the schema resists it ([`pilot-feedback-triage-2026-09.md`](../audit/pilot-feedback-triage-2026-09.md), PF-6) | S | A project can be closed and reopened, and a closed project is visibly distinct in the list | — |
| 13 |  | Move a document between shelves (project ↔ Archiv) | A document lives in exactly one retrieval collection; re-shelving means delete and re-upload, and this is the one thing „gute Details werden befördert" actually needs (PF-5; ADR-0024 already gives it one table and a `scope` column) | M | A project document becomes an Archiv document with its chunks re-scoped, and citations pointing at it still resolve | — |
| 14 |  | A line-granularity diff between two document versions | Two texts side by side in a product whose whole review gesture is „was hat sich geändert"; the route already returns both contents and `package.json` carries no diff dependency ([perspective review](piloti-writes-perspective-review.md) §3.6) | S | The version pane marks added and removed lines, rendered client-side | — |
| 15 |  | A retention policy for superseded versions and per-conversation working directories | Every re-upload now keeps its predecessor and counts against quota, with nothing warning before the ceiling; `frontends/ui/src/lib/documents/service.ts:905` says the policy "does not exist yet" ([perspective review](piloti-writes-perspective-review.md) §3.5, §4) | M | An org setting with a default bounds both, and the conversation cascade cleans up on delete | — |
| 16 |  | Stream the answer instead of buffering it | The first delta is the last thing computed, which is the largest non-generation wait on a chat turn ([latency audit](../architecture/latency-and-caching-audit-2026-09.md) §3.1) | L | Time to first visible token drops measurably on the profiler's root span, with citation markers still resolving | 11 |
| 17 | R | One job execution path: delete `dask` or delete `db` | `frontends/aiq_api/src/aiq_api/jobs/submit.py:30` defaults to `dask`; `docker-compose.coolify.yaml:96` sets `db`. Two paths, one tested (ADR-0021's own migration plan says pick one) | M | One path remains, the other's code is deleted, and the env var is gone from compose | 1 |
| 18 | R | Give `research_job_queue` a migration, RLS and a `kind` | Created by `CREATE TABLE IF NOT EXISTS` at `frontends/aiq_api/src/aiq_api/jobs/queue.py:74` — no drizzle migration, no tenant policy, and it is the table the task row will sit on ([agentic-workspace](agentic-workspace-architecture.md) §8, Loop C) | M | `task db:test:rls` covers it and the table is created by a migration | — |
| 19 |  | Draw the Herleitung's sources under the checkpoint that fetched them | The spine of checkpoints landed; sources still hang off the round, so the reader cannot fold a step ([`architect-workspace-voice-and-agentic-loop.md`](architect-workspace-voice-and-agentic-loop.md) header, "what is still open from §5") | M | A turn with two retrieval rounds renders two foldable checkpoints, each owning its own source cards | — |
| 20 |  | Make requery and repair observations the model can see | Both run as hidden workflows; the model that would react to a failed quote never learns it happened (same doc, §5 layer map, Runtime row) | M | A repair pass appears as a model-visible observation and the next call can act on it | 19 |
| 21 |  | An email (or push) transport for mentions and inbox items | `notifyMentionRecipients` writes an inbox row and publishes a live event; there is no mail transport anywhere in the product, which is the most likely honest basis for „@ erwähnen funktioniert nicht" (PF-4) | M | A mentioned colleague who never opens Piloti receives a message | 1 |
| 22 |  | `STEP_NAME_RULES` for `write_file`, `edit_file` and `file_draft` | The thinking line does not name the new verbs, so a drafting turn looks like a search (`frontends/ui/src/features/chat/lib/executed-steps.ts:74-82`; [perspective review](piloti-writes-perspective-review.md) §3.13) | S | A drafting turn's live line names what it wrote, verified against a real turn | 5 |
| 23 |  | One follow-up chip after a long answer — „als Aktenvermerk schreiben" | Nobody learns Piloti can write; discovery today is a person happening to phrase a request as a commission ([perspective review](piloti-writes-perspective-review.md) §3.12) | S | The chip appears after a long answer and commissioning it produces a draft | 2 |
| 24 |  | Restore one measurement arm of the retrieval eval to CI | The corpus left git in PR #642 and with it the only check enforcing ADR-0044 rule 7; two tests now skip in CI permanently | M | Some arm of retrieval quality runs on every merge against a committed baseline, per one of the three routes the ADR amendment names | — |
| 25 |  | Emit a usage event for the rerank call, and resolve the BYOK key per search | `sources/knowledge_layer/src/cross_encoder.py:237,378` — a frontier-model call per `knowledge_search` is charged to nobody and always uses the platform key; PR #639 documents BYOK as "honestly unwired" | M | A rerank appears on the ledger with its model and search units, under the org's own key when it has one | — |
| 26 |  | A Freigabe section on the Archiv | Office knowledge — the shelf the pilot asked to grow — cannot be reviewed or versioned, because `file-preview-pane.tsx:936` requires a `projectId` ([perspective review](piloti-writes-perspective-review.md) §3.7) | M | The same review panel mounts on an Archiv document with org-level permissions | 2 |
| 27 |  | Resolve a citation to a RIS document ingested into the session shelf | A `RIS_*.txt` in the session knowledge base has no `documents` row and its citation key carries no URL, so the chip resolves to nothing — stated as not covered in PR #628 | M | A session-ingested RIS document opens in `RisDocumentDialog` at the cited passage | — |
| 28 |  | A by-filename resolve endpoint for surfaced documents | `frontends/ui/src/features/documents/hooks/use-surfaced-documents.ts:240` — corpora are bounded at `DOCUMENT_LIST_LIMIT` (500), so in a larger corpus a legitimately surfaced file renders as unresolved | M | A file beyond the window resolves and opens | — |
| 29 |  | Let the agent ask which shelves to search | `ask_user` exists and its description forbids asking what a search could establish; shelf selection is a UI chip the agent receives and never negotiates (PF-14) | S | A question whose shelf is ambiguous produces a clarifying choice rather than a wrong-shelf answer | — |
| 30 |  | A per-organization ingest blacklist in the org `settings` jsonb | Only a deployment-wide extension allow-list and a global exclusion file exist; the jsonb is the obvious empty home (PF-16) | S | An org can exclude an extension and a matching upload is refused with its own message | — |
| 31 | R | Validate thumbnail bytes on the writer side | PR #629 closed the zero-byte case and states the residual plainly: corrupt but non-empty bytes still pass the guard, and validating the writer is backend work | S | A thumbnail that cannot be decoded is never stored, with a test on the writer | — |
| 32 |  | Audit the stream lifecycle behind err2issue #337 / #338 | Both were closed and then reopened after an independent review contested the close: "no app frame does not exonerate our stream lifecycle" (PR #629) | M | Either an upstream report with a reproduction, or a lifecycle fix with a regression test | — |
| 33 | R | Re-capture the stale `sessions*` screenshots and gate the registry | PR #631 and #634 both shipped with `task fe:screenshots` unrun (bun unavailable), so the committed PNGs no longer describe the surface | S | The screenshots match, and CI fails when a registered target's image is older than its component | — |
| 34 |  | Reconcile the marketing site against the product | `frontends/web/src/i18n/ui.ts:70-78` sells „Materialkennwerte, CO₂-Bilanzen" and „Budget"; `grep -rin "co2\|materialkennwert"` over `src/`, `sources/` and `frontends/ui/src` returns nothing, and no project-budget model exists | S | Every claim on the site names something the product does, or the claim is withdrawn | — |
| 35 |  | Make the site, the ToS and `vision.md` agree on what Piloti is | The site says „Zu jeder Empfehlung"; the ToS still says research assistant; the voice work replaced „Einschätzung, nicht Empfehlung" with a colleague voice ([voice doc](architect-workspace-voice-and-agentic-loop.md) §9, "Liability voice was load-bearing") | S | One product sentence appears in all three, and it names what replaces the liability disclaimer | 34 |
| 36 |  | Substantiate or qualify „Cloud und KI laufen in der EU nach DSGVO" | `frontends/web/src/i18n/ui.ts` states it as fact; the boot default is `openai/gpt-5.6-luna` through OpenRouter (`configs/config_oib_openrouter.yml:123`) and the live default is admin-set | S | The claim names the actual processors, or is narrowed to what the deployment guarantees | 34 |
| 37 |  | Re-base the card type ramp against 16px prose | Every step is internally consistent and externally undersized; the charter §A2 records the question as open (PF-13). Affects all 35 cards at once, so it is one decision, not thirty | S | A decision is recorded and the ramp is either re-based or the question is closed | — |
| 38 |  | An ADR for a CAD/Office rasteriser | DWG, DXF, IFC, TIFF, DOCX and XLSX get no thumbnail and no viewer; the same wall bounds how far citation-opening can widen (PF-11, PF "Office-Viewer") | L | An ADR names the dependency and the formats it buys, accepted or rejected | — |
| 39 |  | Resumable upload | Nothing exists: the three `@uppy/*` packages are imported by nothing and `@uppy/xhr-upload` cannot resume regardless. Needs tus or S3 multipart plus a server-side session store (PF-10) | L | A 2 GB Einreichung survives a dropped connection and resumes | 38 |
| 40 |  | Check the review rail on a phone | The review controls live in a right-hand rail on a file page and nobody has opened it at 400px ([perspective review](piloti-writes-perspective-review.md) §3.14) | S | A screenshot target at mobile width shows the rail reachable, or a fix makes it so | 2 |

### TODO census

`grep -rn "TODO\|FIXME\|XXX" src frontends/ui/src frontends/aiq_api/src sources
--include=*.py --include=*.ts --include=*.tsx | grep -v node_modules | wc -l`
→ **17**, of which seven are false positives (a constant named
`DEEP_RESEARCH_TODO_PERSIST_DEBOUNCE_MS`, an `ArtifactType.TODO` enum, a
`\uXXXX` escape in a comment, a test fixture string). The ten that are real
debt, in the order they matter:

1. `frontends/ui/src/lib/budgets/service.ts:596` — member-scope `subjectId` unverified against the roster → item 9.
2. `sources/knowledge_layer/src/cross_encoder.py:237` — `TODO(byok): resolve the key per search from the turn's organization id` → item 25.
3. `sources/knowledge_layer/src/cross_encoder.py:378` — `TODO(cost-tracking): emit a usage event (model, search_units)` → item 25.
4. `frontends/ui/src/features/documents/hooks/use-surfaced-documents.ts:240` — the 500-row resolve window → item 28.
5. `frontends/ui/src/lib/jobs/backend-client.ts:48` — `conversation_id` is "THE SEAM, not the feature": nothing sets it, pending the ownership model for a job's conversation.
6. `frontends/aiq_api/src/aiq_api/websocket_reconnect.py:1621` — `install_reconnectable_handler` is a local monkeypatch, `TODO: upstream to NAT`.
7. `sources/ris_adapter/src/register.py:285` — `TODO(follow-up): re-evaluate switching method= away from json_schema`, the same constrained-decoding class of bug that PR #75 fixed for the researcher.
8. `frontends/ui/src/features/chat/hooks/use-deep-research.spec.ts:511` — a skipped assertion, "Fix fake timer interaction with waitFor"; a hole in the coverage of the surface items 32 and 33 touch.
9. `src/aiq_agent/common/norm_registry.py:236` — `review_note` is an open verification queue for the norm registry with an admin UI and no owner.
10. `frontends/ui/src/app/api/projects/[id]/diagrams/route.ts:48` — a documented control-character escaping rule with no test naming it.

### What this survey could not verify

- **Nothing was run.** No `task verify`, no test suite, no live backend. Every
  "closed" in §1 is a code read, not a passing run.
- **The tree was mid-merge.** `git status` showed a conflict in
  `frontends/ui/src/features/chat/lib/executed-steps.ts` while another agent
  merged `fix/herleitung-spine` in. Items 19, 20 and 22 are read off that
  branch's doc and may already have moved.
- **`docs/audit/feedback-backlog.md`** (July, FB-1…FB-17) was skimmed and
  deliberately not mined: several entries name modules that PR #642 deleted, and
  re-triaging it against this tip is itself an iteration's work.
- **The err2issue tickets** were read only through PR #629's summary.
- **Runtime claims** — latency, cache hit rates, the interaction-budget change
  from 6 to 9 — rest on the audits' file:line evidence, never on a measurement
  taken here. Item 16 in particular should be measured before it is built.
- **No index entry was added** to `docs/README.md` for this file, because this
  survey was scoped to write exactly one file. Whoever runs iteration 1 should
  add the pointer `AGENTS.md` asks for.

## 3. Iterations

| Id | Date | Examined | Found | Changed | Evidence |
|---|---|---|---|---|---|
| I0 | 2026-09-10 | Read-only survey on `claude/practical-goodall-tkmh3t`: PRs #642, #639, #637, #634, #633, #631, #630, #629, #628, #627, #626, #625, #620, #618 (bodies and stated leftovers); [`pilot-feedback-triage-2026-09.md`](../audit/pilot-feedback-triage-2026-09.md); [`agentic-workspace-architecture.md`](agentic-workspace-architecture.md) §7, §8, §10; [`piloti-writes-artifacts-and-approval.md`](piloti-writes-artifacts-and-approval.md); [`piloti-writes-perspective-review.md`](piloti-writes-perspective-review.md) §3, §5; [`architect-workspace-voice-and-agentic-loop.md`](architect-workspace-voice-and-agentic-loop.md) §5, §8, §9 and the six commits `feba7a7..origin/fix/herleitung-spine`; [`backlog.md`](../../backlog.md); [`latency-and-caching-audit-2026-09.md`](../architecture/latency-and-caching-audit-2026-09.md); [`vision.md`](../product/vision.md); `frontends/web/src/i18n/ui.ts` | 40 open items with a citation each; six items the backlog and the triage doc still list open are closed at this tip (§1); 17 TODO hits, 10 real; four duplicate ADR numbers; `packages/` still runs in no CI job; the marketing site sells two capability families (Materialkennwerte / CO₂, Budget) with no code behind them | This file only. No code, no commit | Every row cites a path, a PR or a doc section. Verified in the tree rather than taken from a doc: `validation.ts:348` (PF-9 closed), `configs/config_oib_openrouter.yml:431` (PF-1 closed), `schema/projects.ts` (no status column), `automation-panel.tsx:101` (tasks panel mounted), `.github/workflows/ci.yml` (no `packages` step), `jobs/queue.py:74` (no migration), `docker-compose.coolify.yaml:511,517,605,606` (flags default false), `grep -c OTEL_` = 0 |
