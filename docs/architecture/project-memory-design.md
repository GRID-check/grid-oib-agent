# Project Memory — Design Spec

> A durable, evolving, agent-authored **and** user-curated knowledge layer scoped
> to a single project, so Grid gets measurably smarter about *that* project over
> time. This is the "AGENTS.md for a project" idea, designed as a real system.
> Status: DESIGN (not yet built). Depends on the core project-context injection
> being runtime-verified first (see `backend-deep-dive.md` §4).

## 0. The one-sentence goal

Every conversation about a project should start from everything Grid has already
learned about that project — not from zero — while never letting unverified
"memory" masquerade as legal fact.

## 1. Where memory sits (the knowledge layers)

GRID already has four knowledge layers. Memory is the missing fifth.

| Layer | Nature | Scope | Persists across chats? | Source of truth for |
|---|---|---|---|---|
| **Intake profile** | Structured facts/goals/unknowns | Project | Yes | Hard project facts (Gebäudeklasse, Nutzung…) |
| **Conversation history** | Raw messages | Conversation | **No** (siloed per chat) | The current dialog |
| **Uploaded documents (RAG)** | Chunked text, embedded | Project (`proj_*`) | Yes | The user's own files |
| **OIB corpus (RAG)** | Chunked Richtlinien | Global (`oib_knowledge`) | Yes | The law |
| **→ Project Memory (NEW)** | Curated, evolving findings | Project | **Yes** | What Grid has *learned/decided* about the project |

The gap memory fills: today, anything Grid figures out in conversation #3
(e.g. "this project triggers OIB 2.3 because of the underground garage", "the
client decided to pursue the Fluchttunnel option", "open question: is the
Aufzug a Feuerwehraufzug?") vanishes when conversation #4 starts. Memory makes
that knowledge durable and injected.

### Boundaries (avoid overlap)
- **Profile = structured & confirmed. Memory = unstructured & accreted.** They
  are complementary. High-confidence memory items can *graduate* into structured
  profile facts (§6) rather than living in both places.
- **Memory is not RAG-over-documents.** It's Grid's own notes, not the user's files.
- **Memory is not conversation history.** It's a distilled, deduped digest, not a transcript.

## 2. What a memory item is (data model)

Itemized rows, **not** one appendable blob. Rows are what make dedup, provenance,
status, retrieval-ranking, and graduation possible — an append-only text doc
degrades into contradictory noise within a dozen turns.

```
project_memory
  id                uuid  pk
  project_id        uuid  fk → projects(id)      -- scope
  organization_id   uuid                          -- denormalized tenancy (matches every other table)
  kind              enum  decision | constraint | open_question
                          | derived_fact | preference
                    -- sharp on purpose: the taxonomy IS a quality filter. If a
                    -- finding fits none of these five, it isn't worth remembering.
                    -- decision      = a choice the user/client made for this project
                    -- constraint    = a requirement imposed on this project (the compliance meat)
                    -- open_question = unresolved, needs follow-up
                    -- derived_fact  = a concluded property of the project (graduation candidate)
                    -- preference    = how the user wants Grid to work on this project
  content           text                          -- ONE concise finding, self-contained
  status            enum  proposed | active | superseded | dismissed
  confidence        enum  low | medium | high
  verification      enum  unverified | source_grounded | user_confirmed
  provenance_type   enum  agent | user | distillation | profile_graduation
  source_conversation_id  uuid  null
  source_message_id       uuid  null
  source_document_id      uuid  null              -- when grounded in an uploaded doc
  supersedes_id     uuid  null  fk → project_memory(id)   -- updates, not appends
  salience          real  default 0.5             -- retrieval/budget ranking
  pinned            bool  default false           -- always-inject core memory
  embedding_synced  bool  default false           -- has it been pushed to the vector store
  created_by        text  null                    -- user id when provenance=user
  last_referenced_at timestamptz null             -- for decay
  created_at        timestamptz
  updated_at        timestamptz
```

Postgres is the **system of record** (provenance, status, relationships — things a
vector store is bad at). The vector store is a derived index (§5).

## 3. Lifecycle — the hard 80% is quality, not storage

```
        CAPTURE                CONSOLIDATE            SERVE                 MAINTAIN
   agent `remember` tool  →  dedup vs existing   →  per-query RAG recall  →  decay (last_referenced)
   end-of-chat distill    →  contradiction check →  + pinned core digest  →  supersede stale items
   user manual add/pin    →  merge or supersede  →  budget-limited        →  periodic re-summarize
   profile graduation     →  embed (async)                                →  archive superseded
```

### 3.1 Capture — how items are created
1. **Agent tool `remember(kind, content, confidence)`** — the model calls it mid-turn
   when it learns something durable and project-specific. Primary path. Needs a
   tight prompt policy (§6) so it records signal, not chatter.
2. **Async post-answer reflection** (implemented) — a background stage in the
   post-processing phase that catches what the in-turn tool missed. See §3.5.
3. **User manual add / pin** — from the Project Memory panel (§7).
4. **Profile graduation, inverse** — accepting a `ProjectProfilePatchCard` can also
   drop a `derived_fact` memory item for provenance.

### 3.2 Consolidate — the anti-drift gate (runs on every write)
Before persisting a new item:
- Embed it, find the top-k most similar existing active items.
- If a near-duplicate exists → **update in place** (bump confidence/last_referenced), don't add.
- If it **contradicts** an existing item → LLM adjudication: mark the older one
  `superseded` (linked via `supersedes_id`) or flag for user review if both are
  user-confirmed. **Never silently overwrite a `user_confirmed` item.**
- This is the single most important component. Skip it and memory rots.

### 3.3 Serve — how it reaches the agent (two channels)
- **Always-on "core memory" digest**: pinned + top-salience items, compacted to a
  small budget, delivered as a header `x-grid-project-memory` (sibling to
  `x-grid-project-context`). This is the "Grid always knows the essentials" layer.
- **Per-query recall (RAG)**: findings are embedded into a dedicated vector
  namespace and retrieved per query via the **existing** `X-Grid-Collection-Scope`
  mechanism (add a `mem_<project>` scope). This scales past the header budget.

Injection format tags each item so the model treats it correctly, e.g.:
`[decision · user-confirmed] Client chose the Fluchttunnel option (conv #3).`
`[open_question · unverified] Is the Aufzug a Feuerwehraufzug?`

### 3.4 Maintain — keep it small and fresh
- `last_referenced_at` + salience decay → low-value items sink out of the digest.
- Superseded/dismissed items are archived (kept for provenance, excluded from serve).
- Periodic re-summarization collapses many small related items into one.

### 3.5 Async post-answer reflection (the post-processing phase)
The in-turn `remember` tool depends on the answering agent pausing mid-flow to
record a finding — which a busy answer often skips. The **reflection stage** is
the safety net. It runs in the chat entrypoint's *post-processing phase*,
**scheduled after the answer is already returned** (`schedule_memory_reflection`
in `agents/project_memory/reflection.py`), so it never adds latency to the reply.

Flow (fire-and-forget background task on the event loop):
1. The entrypoint captures the turn (query + answer), the project/organization
   ids, and the existing `x-grid-project-memory` digest **while the request
   context is live**, then schedules the task and returns the response.
2. The task prompts a small reflection LLM (`memory_reflection_llm`) with the
   exchange **and the existing memory digest**, asking for any NEW durable
   finding not already present — the dedup instruction happens against the digest
   in-prompt (the §3.2 embed-based consolidation still applies at write time).
3. Each qualifying finding is validated (kind/scope/confidence vocab, one concise
   sentence, scope has a writable target) and written through the same
   token-guarded internal endpoint the `remember` tool uses — `grid_app` stays
   single-writer; the backend never touches its database.

Guarantees: **never blocks the answer**, **never crashes the turn** (every path
is caught and logged), **opt-in** (unset `memory_reflection_llm` → the scheduler
is a no-op with zero extra LLM cost), and **context-free execution** (all values
are passed explicitly, so the task is safe after the request context is torn
down).

Enablement (two gates):
- **Capability** — the config key `memory_reflection_llm` must point at an LLM,
  or the stage is compiled out entirely (unset by default historically; now set
  to `card_llm` in `config_oib_openrouter.yml`).
- **Runtime** — each turn is gated by `isMemoryReflectionEnabled`
  (`frontends/ui/src/lib/workos/feature-flags.ts`), evaluated by the BFF at the
  WS upgrade and forwarded to the backend as the
  `x-grid-feature-memory-reflection` header (fail-closed: absent header → off).
  With `GRID_ENFORCE_FEATURE_FLAGS=true` the per-org `memory-reflection`
  **WorkOS feature flag** is the source of truth. Without enforcement the gate
  follows `GRID_MEMORY_REFLECTION_ENABLED` and **defaults ON** — reflection is
  a shipped core capability, not a dark-launched product gate, so it behaves
  like every non-dark feature in environments without the flag product.

Safety limits (see [memory-reflection-audit.md](./memory-reflection-audit.md)):
- **Project scope only** — the autonomous stage never writes `organization`-scoped
  memory (org-wide writes poison every project in the tenant and have no
  write-time authorization gate, so they stay a deliberate human action). It
  requires a `project_id`; an org-only conversation is skipped.
- **Substantive answers only** — meta/error/insufficiency and deep-research
  job-stub turns are skipped (nothing durable to record).
- **Digest de-duplication** — a finding already present in the shown digest is
  dropped. This is a soft guard, not the §3.2 consolidation gate (still a
  follow-up), so it does not catch semantic paraphrase or items outside the
  bounded digest.
- **PII/secret filter** (audit finding S4, closed) — a finding whose content
  matches a coarse PII/secret shape (email, phone, IBAN, SSN-shaped digits,
  password/API-key/government-ID keywords) is dropped entirely rather than
  persisted. This is a denylist, not a privacy guarantee — it catches the
  common shapes, not every possible personal fact.

User-informing: both in-turn and reflection writes surface under each answer as a
"Grid hat sich N gemerkt" chip (a reusable `Chip` primitive + `MemoryNotedChip`,
fed by `GET /api/projects/{id}/memory?conversationId=…`), labelling in-turn
(`agent`) vs reflection (`distillation`) provenance.

De-duplication: `createProjectMemoryItem` runs a two-pass write-time check on
every write (both the tool and this stage) — a normalized-equal active item is
refreshed in place instead of duplicated, and a same-kind **paraphrase** (token
Jaccard ≥ 0.8 over a bounded candidate scan) merges the same way — backed by
two partial UNIQUE indexes on normalized content (migration
`0010_project_memory_dedup.sql`) that close the race window. This is a
pragmatic slice of the §3.2 gate; embed-based consolidation and contradiction
adjudication remain follow-ups. See
[memory-reflection-audit.md](./memory-reflection-audit.md).

## 4. Provenance & trust — non-negotiable for a compliance product

An agent that "remembers" a wrong legal claim and repeats it as fact is a
liability, so trust is a first-class field, not an afterthought:
- Every item carries `provenance`, `verification`, and `confidence`, surfaced in
  the injection format so the model hedges appropriately.
- **Unverified memory can never be cited as legal basis.** Legal claims must still
  ground in the OIB corpus / `get_verified_sources` (the existing citation
  verification path). Memory can say "we previously discussed X"; it cannot become
  the citation.
- `user_confirmed` items outrank agent-authored ones and outrank each other by recency.
- The user can always see, edit, correct, or delete (§7) — human override is the backstop.

## 5. Architecture & data flow

```
 Agent turn
   │  calls remember(...)                        User edits in panel
   ▼                                                     │
 Backend /v1/projects/{id}/memory (write)  ◄─────────────┘  (BFF /api/projects/[id]/memory)
   │  1. consolidate (dedup/contradiction)
   │  2. upsert row in Postgres (system of record)
   │  3. enqueue async embed → vector namespace mem_<project>
   ▼
 Serve on next turn:
   server.js WS upgrade → /api/websocket-scope returns:
       • project_context header (existing)
       • project_memory CORE DIGEST header (new)        ← always-on
       • collection scope now includes mem_<project>    ← per-query recall
   → project_context.py reads both headers, merges into agent context
```

- Reuses the working RAG scoping and the existing header-injection seam.
- The consolidation LLM call reuses an existing lightweight LLM handle (same
  pattern as summary/card generation) — no new model wiring.
- **Ties into the DRY base-agent work**: memory-read (digest + recall) is a
  cross-cutting concern every agent needs identically → it belongs in the shared
  `common/agent_base.py`. This is another reason to do the base-agent refactor
  first: memory injection should be written once, not five times.

## 6. Agent integration

- **Tools**: `remember(kind, content, confidence)` always; `recall(query)` optional
  (only if we don't auto-inject via RAG — auto-inject is preferred, so `recall`
  is a Phase-2 nice-to-have).
- **Prompt policy — what to remember** (must be explicit or it records noise):
  - DO: durable, project-specific, non-obvious conclusions; decisions; constraints;
    open questions; user preferences for this project.
  - DON'T: general OIB knowledge (that's the corpus), transient turn state,
    anything already in the structured profile, restatements of the user's message.
- **Graduation**: when a `derived_fact` reaches `high` + `user_confirmed`, propose a
  `ProjectProfilePatchCard` to move it into the structured profile. Memory feeds
  the profile; they're not rivals.

## 7. Observability & management — silent capture, fully observable

**Decision (locked): capture is SILENT but OBSERVABLE.** The agent writes memory
autonomously — no confirm-gate interrupts the conversation and there is no inline
"approve this finding?" card. Instead, memory is observable two ways:

**(a) Live, in traces.** Every `remember(...)` call is emitted as an intermediate
trace event on the WS stream (same channel as tool calls / thinking steps) and as
an observability span (`src/aiq_agent/observability`). So you *watch* memory form
in the trace/Thinking view in real time — you just aren't asked to approve it.

**(b) Managed in the Project Overview.** The overview page gains a "What Grid knows
about this project" section (not a separate destination — it lives where the
profile/standards panels already are). Grouped by `kind`, each item shows content,
provenance (linked conversation), confidence, and status. Actions per item:
**confirm** (→ user_confirmed), **edit**, **delete/dismiss**, **pin** (→ always-inject),
**promote to profile fact**.

Because capture is silent (no write-time human veto), the guardrails shift to
**serve-time + post-hoc**: confidence/provenance tagging in the injection (§4), the
never-cite-unverified rule, and the overview's edit/delete/correct as the human
backstop. This keeps the "gets smarter automatically" value without a nagging
approval loop, while never letting silent memory harden into unchallenged fact.

## 8. Phasing (build the tree in rings, each shippable)

- **Phase 1 — Foundation & visibility (MVP).** Table + system-of-record, BFF CRUD
  API, the Project Memory panel (view/add/edit/delete/pin/confirm), the `remember`
  tool, and always-on **core digest** injection (top-N pinned/recent, bounded — no
  RAG yet). Deterministic, small, immediately visible. Ship this first.
- **Phase 2 — Retrieval & anti-drift.** Embed items into `mem_<project>`, per-query
  recall via collection scope, and the consolidation gate (dedup + contradiction).
- **Phase 3 — Autonomy & hygiene.** End-of-conversation distillation, salience
  decay/rotation, re-summarization, graduation into profile facts + `MemoryUpdateCard`.
- **Phase 4 — Cross-project (optional, later).** Org-level patterns ("you usually
  do X for Wohnbau") — only after single-project memory is proven and trusted.

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Memory poisoning (a wrong finding persists) | provenance + confidence gating + user edit/delete + never-cite-unverified |
| Context bloat as memory grows | RAG recall + digest budget + decay/rotation |
| Contradiction with the profile | precedence: user-confirmed profile > agent memory; graduation instead of duplication |
| Silent overwrite of good info | supersede-with-link, never hard-overwrite; protect `user_confirmed` |
| Tenancy leak | `organization_id` scoping + `requireProjectAccess`, same as every table |
| Embedding latency on write | async embed queue; digest works without it |
| Agent records noise | tight prompt policy + consolidation dedup + user pruning |

## 10. Interfaces (sketch)

- **DB**: `project_memory` table (§2) + a Drizzle migration; embed index namespace `mem_<project>`.
- **Tool schema**: `remember(kind: enum, content: string, confidence: enum) -> {id}`.
- **BFF**: `GET/POST/PATCH/DELETE /api/projects/[id]/memory` (auth + `requireProjectAccess`).
- **Backend**: `POST /v1/projects/{id}/memory` (consolidate + persist + enqueue embed);
  `project_context.py` reads `x-grid-project-memory` and merges into the injected context.
- **Serve**: extend `/api/websocket-scope` + `server.js` to emit the digest header and
  add `mem_<project>` to the collection scope.

## 11. Decisions (all LOCKED)

1. Itemized rows vs one doc → **itemized** (enables everything in §3).
2. Always-inject vs RAG-retrieve → **both eventually**, but **Phase 1 is digest-only**; RAG recall is Phase 2 when volume outgrows the digest budget.
3. Capture: agent-tool vs end-of-chat distillation → **tool + user add first**; distillation in Phase 3.
4. Embedding home: reuse `proj_*` vs dedicated `mem_<project>` → **dedicated namespace** (tune memory vs document recall independently; keep provenance clean).
5. Autonomy → **silent capture, fully observable** (§7): agent writes autonomously with no confirm-gate; every write is visible live in traces and managed post-hoc in the Project Overview. Guardrails move to serve-time tagging + never-cite-unverified + overview edit/delete.
6. Taxonomy → **5 sharp kinds** (`decision | constraint | open_question | derived_fact | preference`); `observation` dropped as a noise bucket. The taxonomy itself is a quality filter.
7. Graduation into the structured profile → **propose, never auto-apply**. Memory capture is silent, but crossing into the higher-trust profile (which drives compliance logic) goes through the existing `ProjectProfilePatchCard` accept flow.
8. Sequencing vs the base-agent refactor → **do the base-agent refactor first** so memory-read lives in one shared place.
```
