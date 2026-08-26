# Platform failure learning — the lesson register

> The correction ratchet ([`correction-ratchet.md`](../contributing/correction-ratchet.md))
> applied to the product itself. **Human intervention is a failure signal**: a
> down-vote on an answer is a user stepping in, and the first one is already
> the signal. This subsystem turns that signal into an anonymized,
> deduplicated **lesson** injected into every agent turn — automatically,
> auditably, and framed everywhere as what it is: a **symptomatic bandage**
> that holds while the root cause is still open.
>
> Status: built 2026-08. Shallow-research/meta chat path only (see
> [Honest gaps](#honest-gaps)).

## Why this exists

The repo's contributor docs demand that a human correction clicks a ratchet:
fix the output, then close the layer that let it through, so a second
occurrence is caught by something other than a person noticing. The product
collected the correction signal (WS-7 thumbs feedback) and ended it on a
dashboard — a surface a person has to notice. Nothing changed agent behaviour.
That is the exact anti-pattern the doctrine names, so this subsystem is the
missing layer: the register is the product's `gotchas.md`, and like gotchas it
is **the weakest ratchet** — it needs the model to read it, which is why every
surface says "bandage" and carries a per-lesson `root_cause_status`.

## The loop

```
down-vote (existing WS-7 capture: verdict + reason chip + comment)
  └─ POST /api/feedback/answers ── after() ──► kickLessonDistillation()   [fail-open]
       └─ sweep: unprocessed down-votes (anti-joined, 30-day window, oldest first)
            1. deterministic PII scrub          lib/text/redact-pii.ts (@redactpii/node + AT/DE rules)
            2. POST backend /v1/lesson-distill  two LLM calls:
                 distill+match: anonymized German META lesson, or the id of the
                                existing lesson this report restates
                 audit:         independent screen of the DISTILLED text only
            3. outcome (all transactional, all evented):
                 match          → link report, recompute counters
                 not general    → recorded as skipped
                 new + audit ok → lesson ACTIVE immediately, capacity eviction
                 new + flagged  → CANDIDATE, held for a human
  active lessons ──► bounded digest (≤20 lessons / 1600 chars, cached 5 min)
    └─ GET /api/internal/platform-lessons/digest   [token-guarded, cross-tenant]
         └─ aiq_agent.common.platform_lessons      [60 s TTL, fail-open to None]
              └─ researcher.j2 §PLATFORM_LESSONS   [meta-framing, everything outranks it]
```

One code path serves both the event-driven kick (3 reports per vote) and the
dashboard's manual sweep (25) — two paths would disagree about the rules
eventually.

## Lessons are meta, and that is load-bearing

A lesson corrects the assistant's **process** — what to verify, when to
retrieve deeper, when to ask — and must never assert a domain or legal fact.
The distiller is instructed to refuse the tempting form ("OIB 4 verlangt X")
and write the process form ("verify the referenced OIB part matches the
question before citing"); the auditor flags domain-fact assertions as a
holding condition. The reason is blast radius: a wrong process caution costs a
little over-verification, while a wrong "fact" injected fleet-wide poisons
every tenant's answers. The prompt section mirrors this: lessons carry zero
factual authority, are never citable, and retrieval, documents, profile and
the live conversation all outrank them.

## Data model

Three global tables (no `organization_id`), secured with
`grid_secure_platform_table` — every tenant reads, only the platform role
writes (migration `0068_platform_lessons.sql`):

| Table | Holds |
|---|---|
| `platform_lessons` | The injectable text + lifecycle (`candidate`/`active`/`retired`), category, counters, `root_cause_status`. CHECK-pinned vocabularies; partial unique index on German-normalized content over non-retired rows. |
| `platform_lesson_reports` | Provenance, one row per processed down-vote. `feedback_id` UNIQUE = the pipeline's idempotency key. |
| `platform_lesson_events` | Append-only trail of every transition, system or human. |

**Anonymization is structural, not procedural.** The provenance row carries a
sha256 `org_hash` (enough to count distinct organizations) and the feedback
row's uuid as an opaque pointer — never the org id, user id, or raw text. The
`canonical_summary` is the distiller's anonymized restatement, kept so
provenance survives a retracted vote. Dereferencing a pointer back to the raw
report means joining `answer_feedback` under the audited platform bypass,
which is a deliberate second gate: the injectable/visible layer is safe by
construction, and crossing back to raw is a privileged act.

Four defence layers, none trusted alone: deterministic scrub → instructed
omission (the distiller writes the failure class, not the instance) → auditor
model on the distilled text (which never sees the raw report, so injected
report text cannot lobby its own screening) → storage that has nowhere to put
an identity.

## Automatic, supervised, auditable

The gate sits at **activation, not distillation** (the loop stays fully
automatic; the supervision is a held-back state, not a required click):

- generalizable + clean audit → active immediately. "A failure should never
  occur twice" argues against waiting for a second report or a human.
- auditor-flagged → `candidate`, listed under "held for review" in
  Platform → Lessons until an owner activates, edits or retires it.
- every transition — system or human — is a `platform_lesson_events` row;
  human mutations are additionally WorkOS-audited (`platform.lesson.updated`).
- the active set is hard-capped (20 lessons / 1600-char digest — a prompt
  budget, paid on every turn of every tenant). Past the cap the
  least-recently-reported lesson is auto-retired (`evicted_capacity`).

## Scaling posture (tens of thousands of reports)

- **Injection is O(1) in feedback volume.** The digest is capped whatever the
  table holds; per-turn cost never grows with reports. This is the deliberate
  contrast with project memory's known walls
  ([`memory-system-audit-2026-07.md`](memory-system-audit-2026-07.md) F2/F3).
- **Serving is cached twice** (BFF Dragonfly 5 min, Python in-process 60 s):
  one internal GET per worker per minute, independent of fleet size.
- **The pipeline is linear in down-votes and embarrassingly parallel.** Each
  report costs at most two LLM calls, exactly once (UNIQUE backstop; races
  cost a duplicate call, never a duplicate row). The sweep's anti-join runs on
  a partial index (`verdict='down'`), so scan cost tracks down-votes in the
  window, not table size.
- **Dedup is the real pressure point.** Reports deduplicate into lessons on a
  power-law curve; the matcher compares against the top-`60` live lessons by
  report count, so what falls outside the window is the long tail a new
  report is least likely to duplicate. **Phase 2, when the live register
  outgrows that window:** embed lesson content/summaries into the backend's
  vector store and retrieve match candidates by similarity instead of rank —
  the same recall channel the memory design specifies (§3.3) and for the same
  reason, so building it once for both is the expected shape.

## Shared substrate with project memory

Per the correlated-substrate rule, the proven core of the memory service was
lifted rather than forked, and both stores now run on it:

- `lib/knowledge/consolidation.ts` — normalization, tokenization, Jaccard,
  the polarity split. Two normalizers on purpose: memory keeps the ASCII fold
  (lock-step with the deployed 0010 indexes), lessons use the
  umlaut-preserving German fold (lock-step with the 0068 index). Documented
  non-adoption, not drift.
- `lib/knowledge/digest-format.ts` — the bounded, injection-safe digest
  formatter (escaped quoting so stored text cannot forge tag lines), used by
  both `PROJECT_MEMORY` and `PLATFORM_LESSONS`.

Storage deliberately stays two tables: project memory is tenant-scoped under
RLS; lessons are platform-scoped under the platform-table pattern. A single
mixed table would fight the 0031 policy, the scope CHECK and both unique
indexes at once.

## Honest gaps

- **Deep research and the clarifier do not receive lessons yet.** The
  injection covers the shallow-research/meta path — the primary chat answer
  path. Extending to deep research means threading the digest through
  `submit_agent_job` and the deep prompts; nothing in the design blocks it.
- **Semantic matching is windowed** (top-60 by report count). Sufficient
  until the live register outgrows it; the Phase-2 vector recall above is the
  designed successor, not an afterthought.
- **A re-vote does not re-distill.** The first processing of a feedback row
  is the signal; an edited comment on the same vote is not reconsidered.
- **The k-anonymity trade-off is decided, not dodged:** a lesson can activate
  from a single organization's report because the text is anonymized by
  construction and audited; `org_count` is surfaced so an owner can weigh
  single-org lessons differently. Raising the bar to k distinct orgs is a
  one-line change in the activation gate if the posture changes.
- **Effectiveness is not yet measured.** Counters record reports, not whether
  an active lesson reduced them; a helpful/harmful signal (down-vote rate on
  turns where a lesson was in context) is the natural next ratchet.

## Where things are

| Concern | Path |
|---|---|
| Pipeline service + digest | `frontends/ui/src/lib/platform-lessons/service.ts` |
| Repository (all SQL) | `frontends/ui/src/lib/platform-lessons/repository.ts` |
| Distiller/auditor route | `frontends/aiq_api/src/aiq_api/routes/lesson_distill.py` |
| PII scrub | `frontends/ui/src/lib/text/redact-pii.ts` |
| Schema | `frontends/ui/src/lib/db/schema/platform-lessons.ts`, migration `0068` |
| Trigger | `frontends/ui/src/app/api/feedback/answers/route.ts` (`after()`) |
| Internal pull | `frontends/ui/src/app/api/internal/platform-lessons/digest/route.ts` → `src/aiq_agent/common/platform_lessons.py` |
| Prompt section | `src/aiq_agent/agents/shallow_researcher/prompts/researcher.j2` §PLATFORM_LESSONS |
| Dashboard | `frontends/ui/src/app/app/(shell)/platform/lessons/` |
