# Platform failure learning — the lesson register

> The correction ratchet ([`correction-ratchet.md`](../contributing/correction-ratchet.md))
> applied to the product itself. **Human intervention is a failure signal**: a
> down-vote on an answer is a user stepping in, and the first one is already
> the signal. This subsystem turns that signal into an anonymized,
> deduplicated **lesson** injected into every agent turn — automatically,
> auditably, and framed everywhere as what it is: a **symptomatic bandage**
> that holds while the root cause is still open.
>
> Status: built 2026-08. Reaches shallow research, meta turns and both
> deep-research paths; matching is semantic and effectiveness is measurable
> (see [Honest gaps](#honest-gaps)).

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
            1b. semantic match candidates       cosine over the register (0069), rank window as fallback
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

## Adjudicated: why serving is NOT retrieval (RAG)

The obvious alternative — put lessons in ChromaDB and retrieve the relevant
ones per turn — was considered and rejected, for reasons that are the repo's
own, not taste:

1. **The two-knowledge-systems doctrine already decides this.** Retrieval is
   "the library, searched on demand" — citable, verified, evidence. Memory and
   context are "the briefing, carried every turn" — never embedded, never a
   citation source (system-overview §5.2). A lesson is unambiguously
   briefing-class: it is guidance *about* answering, not material *for* an
   answer. Putting it in the retrieval path is the same category error
   `common/source_kinds.py` exists to prevent for measurements — anything that
   travels the source channel can end up grounding an uncited claim.
2. **Retrieval keys on content; the best lessons are content-poor.** "Don't
   guess submission deadlines" has weak semantic similarity to any particular
   question — exactly the lessons a similarity search misses. And a missed
   retrieval here is not degraded ranking; it is the silent recurrence of the
   one failure the system promises won't recur. A probabilistic recall channel
   under a deterministic guarantee is a design contradiction.
3. **The corpus-size problem RAG solves is designed not to exist.** Dedup plus
   the power law plus capacity eviction keep the *active* register at ~20
   items. Retrieval infrastructure to select from twenty things costs an
   embedding call per turn, a global vector collection, and store/DB
   consistency — to save a few hundred always-injected tokens.
4. **Auditability.** With always-inject, "what was the fleet told at time T"
   has an exact answer, reconstructible from the event trail. With per-turn
   retrieval it becomes a distribution.

Where vectors DO belong: **matching**, not serving — and that is now built.
Dedup candidates come from cosine similarity over the register rather than a
popularity window ([`semantic-notes.md`](semantic-notes.md)). If the register
is ever deliberately allowed to grow past the prompt budget (e.g. per-topic
lanes), similarity may additionally *select which lessons fill the fixed
budget* — selection inside the briefing channel, never passage-retrieval
through the citation path.

The 2026 survey of shipping agent-memory systems in
[`semantic-notes.md`](semantic-notes.md) strengthened this rather than
weakening it: almost none of them use vector search for SERVING either.
ChatGPT does not RAG its own chat history — it precomputes a profile and
injects it — and Copilot, Cursor, Windsurf and Devin all select by having the
model read a menu of short prose descriptions.

## Data model

Three global tables (no `organization_id`), secured with
`grid_secure_platform_table` and then **tightened past the platform-table
norm**: migration `0068` revokes even the tenant-role read grant, because
nothing tenant-facing queries these tables (the digest is built under the
platform role behind the internal route) and a candidate lesson is exactly
the text the auditor flagged as possibly identifying. Tenant-invisible in
both directions, platform-role only; `tenant-isolation.integration.spec.ts`
pins the posture.

| Table | Holds |
|---|---|
| `platform_lessons` | The injectable text + lifecycle (`candidate`/`active`/`retired`), category, counters, `root_cause_status`. CHECK-pinned vocabularies; partial unique index on German-normalized content over non-retired rows. |
| `platform_lesson_reports` | Provenance, one row per processed down-vote. `feedback_id` UNIQUE = the pipeline's idempotency key. |
| `platform_lesson_events` | Append-only trail of every transition, system or human. 0070 adds `flagged_ineffective` — the sweep's once-per-activation verdict that reports keep linking to an active lesson, i.e. the bandage is not holding (the lesson stays active; the flag routes a human at the root cause). |

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
- **candidates expire too** (45 days without a repeat report, or beyond a cap
  of 40 — `candidate_expired`, reversible, evented). Without this, flagged
  singletons nobody reviews would accumulate, crowd the bounded matcher
  window, and make new reports spawn duplicates of lessons the matcher can no
  longer see — a divergence loop. Every sweep runs the expiry first.

Sweep robustness, because the failure modes of a background LLM loop are
quiet ones:

- **No head-of-line wedging.** A deferral (distiller error) leaves no row so
  the next sweep retries — but oldest-first ordering would let one permanently
  failing report block everything behind it. An in-process attempt memo skips
  a report after 3 failed tries per process (resets on deploy, when a
  permanent failure is most likely fixed); the 30-day sweep window is the
  durable backstop.
- **Single-flight per process.** A burst of down-votes starts one sweep, not
  N racing sweeps paying the same LLM calls; the manual sweep waits for an
  in-flight kick and then runs its own pass. Cross-replica duplicates remain
  possible, are bounded by replica count, and cost only a wasted call — the
  UNIQUE provenance key keeps them correct — which is why there is no lock
  held across model calls.

Threat model note: the pipeline's input is adversarial by definition — anyone
who can vote can author it. The distiller treats report text as fenced data
and is told to describe manipulation attempts as the failure they are; the
auditor never sees the raw report (so injected text cannot lobby its own
screening) and flags manipulative or fact-asserting candidates; the residual —
an attacker-influenced process caution passing both models — is bounded by the
meta-only rule and the everything-outranks-lessons framing.

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
- **Dedup was the real pressure point, and is now semantic.** Match candidates
  come from cosine similarity over the lesson register (migration 0069,
  threshold 0.85), not from a popularity window — a window ordered by report
  count answers "which lessons are popular", and past its edge the matcher
  simply could not see the lesson it should have merged into. The rank window
  survives as the fallback when the embedder is unavailable or the register is
  unembedded. Mechanics, and the point where a real ANN index becomes
  necessary: [`semantic-notes.md`](semantic-notes.md).

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

## Measuring whether any of this works

Three signals, and the differences between them are the point.

**The counters** (`helpful_votes` / `harmful_votes`) count up/down votes cast
while a lesson was active. With an always-injected digest, exposure is a
function of TIME — a vote at T saw every lesson active at T — so this needs no
per-turn exposure table, just a temporal join. It is a **correlation**: every
active lesson is credited for every vote in its window, and the digest caches
mean a lesson activated minutes ago may not have reached every worker yet.
Labelled as correlation wherever it is shown.

**The holdout** is the credible one. `lessons.holdout_pct` (Platform →
Retrieval, **default 0 = off**) puts a deterministic slice of conversations in
a control group that receives no lessons at all, and every vote records which
arm it fell on, so the two down-vote rates are directly comparable. Both tiers
decide with the same pure function over the same key — `isInHoldoutSlice` in
TypeScript, `is_in_holdout_slice` in Python, with pinned cross-language test
vectors on both sides — so nothing has to be plumbed between them and they
cannot disagree.

Three deliberate choices:

- **Off by default.** A product does not degrade a slice of its own answers
  unless an operator turns measurement on.
- **Keyed on the conversation**, so a thread stays in one arm and a user never
  gets a lesson-shaped answer and a lesson-free one to the same follow-up. The
  conversation is therefore the unit of the experiment.
- **Monotonic in the percentage** — raising the holdout never removes a
  conversation from it, so a change does not reshuffle both arms and invalidate
  everything measured before it.

**Recurrence** (0070) is the only per-lesson signal, and the sweep acts on it
in both directions. A report the matcher semantically LINKS to an
already-active lesson means the failure the lesson exists to prevent happened
again under treatment — the counters, being a shared clock over all active
lessons, can never say that about one lesson. At
`LESSON_RECURRENCE_FLAG_THRESHOLD` linked reports since activation the sweep
records `flagged_ineffective` (once per activation; the lesson STAYS active —
the wound is demonstrably open, the flag routes a human at the root cause).
The mirror rule closes the lifecycle: once `root_cause_status` is `addressed`
and `LESSON_ADDRESSED_QUIET_DAYS` pass with zero recurrences, the sweep
retires the lesson automatically (`detail.automatic = true`) — 0068's "the
owner retires once the fix is verified" with the verification made mechanical:
no recurrence after the fix IS the evidence, and reactivation exists for the
fix that turns out not to have held. Re-opening and re-addressing the root
cause restarts the quiet clock.

Honest limitation, stated because it decides how to read the result: at low
traffic a holdout is under-powered. Interleaving is far more sensitive but does
not apply to a prompt block that is either present or absent, so a holdout is
the applicable design — and a small difference needs a long window before it
means anything.

## Honest gaps

- **The clarifier does not receive lessons.** Shallow research, meta turns and
  both deep-research paths (in-process and async job) do.
- **Counters are correlational.** See above; the holdout is the answer, and it
  is off until somebody turns it on.
- **A re-vote only re-opens a SKIPPED report.** Adding a comment to a
  down-vote the sweep dismissed sends it back for distillation; a report that
  already produced a lesson keeps its provenance row, because re-distilling it
  would count one user's opinion twice in `report_count` — the number the
  activation and eviction order are built on.
- **The k-anonymity trade-off is decided, not dodged:** a lesson can activate
  from a single organization's report because the text is anonymized by
  construction and audited; `org_count` is surfaced so an owner can weigh
  single-org lessons differently. Raising the bar to k distinct orgs is a
  one-line change in the activation gate if the posture changes.
- **Effectiveness attribution is layered, not solved.** Counters are
  correlational, the holdout needs traffic and an operator to turn it on, and
  recurrence (the per-lesson signal the sweep flags and retires on) depends on
  the matcher linking the repeat report to the right lesson — a recurrence the
  matcher files as a NEW lesson is invisible to the flag.

- **There is no scheduler container, on purpose.** Sweeps are event-driven
  (every down-vote kicks one) and the kick widens from 3 to 12 reports when a
  backlog has formed, so the pipeline is self-healing while anyone is voting —
  and a deployment where nobody votes is also one where no backlog forms. An
  operator who wants a clock anyway points it at
  `POST /api/internal/platform-lessons/sweep`.

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
