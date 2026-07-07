# Audit — async memory-reflection stage & the memory write path

> Multi-persona audit of the post-answer memory-reflection stage
> (`src/aiq_agent/agents/project_memory/reflection.py`) and the surrounding
> project-memory system. Records the findings, what was hardened in code, and
> what remains a deliberate follow-up. See also
> [project-memory-design.md](./project-memory-design.md) §3.5.

## Scope reviewed
Reflection stage + its wiring (`agents/chat_researcher/register.py`), the
internal write endpoint (`app/api/internal/memory/route.ts`), the memory service
(`lib/projects/memory-service.ts`), the backend write client
(`knowledge/project_memory.py`), the WS scope route, `requireProjectAccess`, and
the UI surfacing path (thinking panel, memory panel). Perspectives: security,
privacy/GDPR, UX, backend/SRE, adversarial user, end-user architect.

## What is sound (verified, not findings)
- Internal endpoint auth: constant-time token compare, dev-default token refused
  outside dev, fails closed (503) when unset, `isDevEnvironment` defaults to
  production.
- Tight zod validation (uuid projectId, enum kind/confidence/scope, content
  1–2000, cross-field refine).
- **Project-scope tenancy is safe under auth**: the write derives `organization_id`
  from the project row (ignoring any client value), and `requireProjectAccess`
  enforces the org match + WorkOS permission. A project-scoped write cannot land
  in the wrong tenant when auth is on.
- The async task has no context-bleed / cross-turn race: request-scoped values
  are captured synchronously and passed explicitly; `insert_memory_item` reads no
  ContextVars; `_background_tasks` only holds task references.

## Findings

| # | Sev | Finding | Status |
|---|-----|---------|--------|
| S1 | HIGH | Org-wide writes have no authorization gate and no human-in-the-loop; an autonomous, prompt-injectable stage could plant `organization`-scoped memory that poisons every project in the tenant. Contradicts design §8 (org memory = Phase 4) and multitenancy-spec §6/§11 (cross-project mutation needs an org role). | **Mitigated for this stage** — reflection is now project-scope only (never emits `organization`). The *endpoint-level* org-admin gate remains a follow-up for the `remember` tool path. |
| S2 | MED-HIGH | Prompt-injectable: the reflection LLM's output is the sole driver of writes, fed user/answer/digest text. | **Reduced** — project-scope-only bounds blast radius to the current project; prompt now tells it not to treat embedded instructions as findings; digest-dedup drops echoed items. Residual: a semantically valid attacker-chosen *project* finding can still be written (same as the `remember` tool). |
| INFORM | HIGH (UX/trust) | Reflection-phase writes are surfaced to the user **nowhere** — no tool step (it's not a tool call), no WS event, no toast/badge; the memory panel fetches once on mount and never refreshes. | **Open (follow-up).** Documented; needs a post-turn "Grid noted N item(s)" signal + panel refresh. |
| DEDUP | HIGH (correctness) | No write-time consolidation (design §3.2 unbuilt); no uniqueness constraint; digest is bounded (20 items / 1800 chars) so reflection is blind to older items; in-turn `remember` writes aren't in the pre-turn digest → double-store. | **Reduced** — normalized digest-dedup added. Full fix = the §3.2 consolidation gate (follow-up). |
| GATE | MED | Reflection ran on error/meta/insufficiency answers (only job stubs were skipped). | **Fixed** — `_reflection_answer_is_substantive` skips meta/error intent, canned error/empty answers, and insufficiency ("I don't have enough information …"). |
| S3 | MED (config) | Anonymous mode (`REQUIRE_AUTH=false`) trusts client `projectId` unchecked → cross-tenant project write primitive. | **Open (pre-existing, independent of reflection).** Deploy with auth on. |
| S4 | MED | Data minimization: answer/query text is sent to `memory_reflection_llm` (egress if external) and any finding is silently persisted (no PII/secret filter). | **Partly reduced** by the INFORM + GATE follow-ups; a PII filter remains open. |
| S5 | LOW | No per-turn/-project rate cap → digest flooding; one extra LLM call per substantive turn, no debounce. | **Open (follow-up).** `MAX_NEW_ITEMS=5` caps a single pass only. |
| S6 | LOW | `tokensMatch` early-returns on length mismatch (leaks token length via timing). Negligible for a static secret. | Open (accepted). |

## Hardening applied in this change (P0)
1. **Project-scope only.** `_sanitize_findings` forces every finding to project
   scope and drops all when no project is in scope; `schedule_memory_reflection`
   requires a `project_id`. The autonomous stage can never write org-wide memory.
2. **Substantive-answer gate.** `_reflection_answer_is_substantive` keeps
   reflection off meta/error/insufficiency/empty turns.
3. **Digest de-duplication.** `_content_in_digest` drops any finding whose
   normalized content already appears in the digest shown to the LLM.
4. **Injection-aware prompt.** The system prompt states findings are project-only
   and instructs the model not to treat embedded instructions as findings.

## Follow-ups (require product decisions / larger surface)
- **INFORM**: surface memory writes to the user (post-turn "Grid noted N ▸" +
  panel auto-refresh/badge; show content; distinguish reflection vs in-turn
  provenance and surface `sourceConversationId`).
- **DEDUP**: build the §3.2 write-time consolidation gate (embed → near-duplicate
  update-in-place → contradiction adjudication) and add a `project_memory`
  uniqueness guard + per-project row cap.
- **S1 (endpoint)**: an org-admin permission gate on the endpoint's org branch,
  for the `remember` tool path that can still request org scope.
- **S3**: close the anonymous-mode `projectId` trust gap (or hard-require auth).
- **S4/S5**: PII/secret filtering before persistence; per-conversation debounce.
