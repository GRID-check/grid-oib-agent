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
| S1 | HIGH | Org-wide writes have no authorization gate and no human-in-the-loop; an autonomous, prompt-injectable stage could plant `organization`-scoped memory that poisons every project in the tenant. Contradicts design §8 (org memory = Phase 4) and multitenancy-spec §6/§11 (cross-project mutation needs an org role). | **Fixed.** Reflection is project-scope only, AND the internal endpoint now **default-denies** agent-authored org writes (403 unless `GRID_ALLOW_AGENT_ORG_MEMORY=true`). Org-wide memory is a human-only action via the panel. |
| S2 | MED-HIGH | Prompt-injectable: the reflection LLM's output is the sole driver of writes, fed user/answer/digest text. | **Reduced** — project-scope-only bounds blast radius to the current project; prompt now tells it not to treat embedded instructions as findings; digest-dedup drops echoed items. Residual: a semantically valid attacker-chosen *project* finding can still be written (same as the `remember` tool). |
| INFORM | HIGH (UX/trust) | Reflection-phase writes are surfaced to the user **nowhere** — no tool step (it's not a tool call), no WS event, no toast/badge; the memory panel fetches once on mount and never refreshes. | **Built.** A per-turn "Grid hat sich N gemerkt" chip (reusable `Chip` primitive) polls conversation-scoped memory after each answer and lists items in a popover, labelling in-turn (`agent`) vs reflection (`distillation`) provenance. Panel auto-refresh remains a nice-to-have. |
| DEDUP | HIGH (correctness) | No write-time consolidation (design §3.2 unbuilt); no uniqueness constraint; digest is bounded (20 items / 1800 chars) so reflection is blind to older items; in-turn `remember` writes aren't in the pre-turn digest → double-store. | **Reduced** — write-time normalized de-duplication now runs on **every** write (`createProjectMemoryItem`): a normalized-equal active item updates in place instead of inserting a duplicate. Full embed/contradiction gate + a DB uniqueness constraint remain follow-ups. |
| GATE | MED | Reflection ran on error/meta/insufficiency answers (only job stubs were skipped). | **Fixed** — `_reflection_answer_is_substantive` skips meta/error intent, canned error/empty answers, and insufficiency ("I don't have enough information …"). |
| PROV | LOW | Reflection vs in-turn agent writes were indistinguishable in the UI (both `provenanceType:'agent'`). | **Fixed** — reflection writes are tagged `distillation`; the chip labels them "nach der Antwort ergänzt". |
| S3 | MED (config) | Anonymous mode (`REQUIRE_AUTH=false`) trusts client `projectId` unchecked → cross-tenant project write primitive. | **Open (pre-existing, independent of reflection).** Deploy with auth on. |
| S4 | MED | Data minimization: answer/query text is sent to `memory_reflection_llm` (egress if external) and any finding is silently persisted (no PII/secret filter). | **Partly reduced** by the INFORM + GATE follow-ups; a PII filter remains open. |
| S5 | LOW | No per-turn/-project rate cap → digest flooding; one extra LLM call per substantive turn, no debounce. | **Open (follow-up).** `MAX_NEW_ITEMS=5` caps a single pass only. |
| S6 | LOW | `tokensMatch` early-returns on length mismatch (leaks token length via timing). Negligible for a static secret. | Open (accepted). |

## Hardening applied
Round 1 (reflection stage):
1. **Project-scope only.** `_sanitize_findings` forces every finding to project
   scope and drops all when no project is in scope; `schedule_memory_reflection`
   requires a `project_id`.
2. **Substantive-answer gate.** `_reflection_answer_is_substantive` keeps
   reflection off meta/error/insufficiency/empty turns.
3. **In-prompt digest de-duplication** + an **injection-aware prompt**.

Round 2 (system-wide):
4. **Endpoint org default-deny (S1).** `POST /api/internal/memory` rejects
   agent-authored `organization` writes with 403 unless
   `GRID_ALLOW_AGENT_ORG_MEMORY=true`.
5. **Write-time de-duplication (DEDUP).** `createProjectMemoryItem` finds a
   normalized-equal active item and updates it in place (recency + best-known
   confidence) instead of inserting a duplicate — applies to BOTH the in-turn
   `remember` tool and the reflection stage.
6. **User-informing chip (INFORM).** A reusable `Chip` primitive
   (`components/ui/chip.tsx`) + `MemoryNotedChip` surface "Grid hat sich N
   gemerkt" under each answer, via a conversation-scoped memory fetch
   (`GET /api/projects/{id}/memory?conversationId=…`).
7. **Provenance (PROV).** Reflection writes are tagged `distillation` so the UI
   distinguishes them from in-turn `agent` writes.

## Follow-ups (require product decisions / larger surface)
- **DEDUP hardening**: the §3.2 embed/contradiction consolidation gate, a DB
  uniqueness constraint on `project_memory`, and a per-project row cap. (The
  app-level normalized dedup covers the single-writer path today.)
- **INFORM polish**: live memory-panel refresh/badge when the panel is open.
- **S1 (remember tool)**: a proper org-admin permission gate (with role
  propagation) so org writes can be *enabled* safely rather than all-or-nothing.
- **S3**: close the anonymous-mode `projectId` trust gap (or hard-require auth).
- **S4/S5**: PII/secret filtering before persistence; per-conversation debounce.
