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
  restricted_folder_ids uuid[] null               -- ADR-0085: the source folders it depends on;
                                                  -- NULL = open (§3.6, migration 0111)
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

**Built (2026-07-31), without embeddings.** Contradiction handling arrives via two
detectors, both in `createProjectMemoryItem`:
1. **Polarity split on the paraphrase match.** A correction is token-wise nearly
   identical to the claim it corrects ("… is not applicable" vs "… is applicable"
   score 0.91 Jaccard), so it landed in the *merge* branch — and a merge keeps the
   OLD content, refreshing only confidence and timestamps. Corrections were being
   silently discarded while the stale row came back looking freshly confirmed.
   Matches are now compared on negation parity plus boolean literals: same
   polarity → merge, opposed → supersede.
2. **An explicit target.** The writer may quote the entry it overturns verbatim
   (`supersedesContent`); the quote is resolved against active items in scope
   (exact normalized match, else ≥ 0.7 Jaccard) and ignored when nothing matches
   — never guessed at. This covers corrections phrased too differently for (1).

Either way the replacement insert and the `superseded` marking run in ONE
transaction, so memory is never left with two live contradictory entries nor with
a fact silently deleted. The `user_confirmed` rule is honoured and widened: an
agent may not retire a pinned, `user_confirmed`, or user-authored entry at all —
the correction is still recorded, both stay active, and the user resolves it in
the panel. Still outstanding from this section: embedding-based similarity (so
semantically-distant contradictions are caught without a quote) and LLM
adjudication of genuine two-sided conflicts.

**Consolidation never crosses a restriction** (§3.6). Every pass — exact
duplicate, semantic and lexical paraphrase, the named supersede target — only
considers rows with exactly the same `restricted_folder_ids` (stored sorted and
de-duplicated, so equal restrictions are equal arrays). An open note never
merges into, supersedes or is retired by a restricted one, and neither do two
restricted notes with different collections: either would make a fact appear
for, or vanish from, people the other row is not shown to. The 0010 dedup index
carries the restriction since 0111, so an open and a restricted note with the
same text can both be live.

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

**Precedence — memory never outranks the live turn.** The digest is concatenated
into `project_context` (`compose_project_context`), whose answering prompt tells
the model to treat confirmed facts as *binding constraints it must never
contradict*. That rule is meant for the intake profile; inherited by agent-authored
`unverified` notes it turns stale memory into something the agent defends. The
answering prompt therefore carves `PROJECT_MEMORY` out explicitly, in
`prompts/piloti_static.md` `<project_record>` (above the KV-cache boundary,
since the explanation is the same bytes on every turn while only the VALUES
vary): prior notes, not confirmed facts and not law;
`user_confirmed` alone carries a confirmed fact's weight; entries run pinned-first
then newest-first; the current conversation always wins; and a memory entry is
never a citable source for a legal requirement.

**What the project decided about the agent's proposals travels with the
digest.** A `project_profile_patch` or `memory_proposal` card is a proposal;
the reader's Accept or Reject is persisted on the message (ADR-0030) and,
until 2026-09, read by nothing the agent could see, so a declined patch came
back next turn. `lib/projects/proposal-decisions.ts` renders the most recent
verdicts as a bounded `PROPOSAL_DECISIONS v1` block (≤10 lines / ≤900 chars,
newest first, in the card's own words) that is appended to the digest on the
handshake and on the live per-turn fetch. The memory header cap is sized for
both blocks (`MEMORY_HEADER_MAX_CHARS`), and `<project_record>` explains the
block once, next to PROJECT_MEMORY: accepted means already in place, declined
means not raised again without new evidence.

### 3.4 Maintain — keep it small and fresh
- `last_referenced_at` + salience decay → low-value items sink out of the digest.
- Reinforcement (`recall_count`, `last_referenced_at`) fires only on a build ranked against a question; the query-less handshake build reinforces nothing, so recency cannot reinforce recency.
- A finding that contradicts a pinned, user-confirmed or user-written note is inserted beside it with `conflicts_with_id` naming that note (migration 0076); a person resolves the pair in the panel.
- Superseded/dismissed items are archived (kept for provenance, excluded from serve).
- Periodic re-summarization collapses many small related items into one.

### 3.5 Async post-answer reflection (the post-processing phase)
The in-turn `remember` tool depends on the answering agent pausing mid-flow to
record a finding — which a busy answer often skips. The **reflection stage** is
the safety net. It runs in the chat entrypoint's *post-processing phase*,
**scheduled after the answer is already returned** (`schedule_memory_reflection`
in `memory/reflection.py`), so it never adds latency to the reply.

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
- **Restricted memory from a restricted turn** (ADR-0084, §3.6) — a turn whose
  signed scope holds a restricted folder's collection (`<project collection>_r<12 hex>`)
  still reflects; each finding is written as restricted memory when it depends
  on restricted content, through the same decision the `remember` tool uses.
  A deep-research run's reflection still skips when its scope holds one (it
  never does: research scopes carry no restricted collection).
- **Digest de-duplication** — a finding already present in the shown digest is
  dropped. This is a soft guard, not the §3.2 consolidation gate (still a
  follow-up), so it does not catch semantic paraphrase or items outside the
  bounded digest.
- **Corrections are exempt from that guard, on purpose.** "Don't restate what is
  already in memory" reads as "this topic is covered, skip it" precisely when a
  turn *overturns* an entry, which is the one case memory must not miss. The
  prompt therefore separates the two explicitly: restatements are barred,
  corrections are the highest-value thing the stage records, and it is told to
  write what holds NOW plus the fact that changed it. (The substring digest
  guard does not block them — a negated finding is not a substring of the entry
  it negates.)
- **Reflection can retire what it corrects**, not only append. Each finding
  carries a `supersedes` field (part of the strict structured-output contract, so
  the model has a sanctioned way to return one): the verbatim content of the entry
  it replaces, copied from the digest it was shown. `_finding_from_entry` honours
  it ONLY when it matches one COMPLETE entry of the shown digest (normalized
  equality against the parsed entry contents, not a substring test — a truncated
  quote like "Client chose a flat" for "Client chose a flat roof" would otherwise
  still resolve through the ≥ 0.7 Jaccard fallback). A hallucinated, paraphrased
  or truncated quote is dropped and the finding recorded as an ordinary new item,
  so a fabricated quote can never archive a real row. The in-turn `remember` tool
  takes the same argument. Resolution, the human-curation guard, and the atomic
  swap all live in the single writer (§3.2).
- **PII/secret filter** (audit finding S4, closed) — a finding whose content
  matches a coarse PII/secret shape (email, phone, IBAN, SSN-shaped digits,
  password/API-key/government-ID keywords) is dropped entirely rather than
  persisted. This is a denylist, not a privacy guarantee — it catches the
  common shapes, not every possible personal fact.

User-informing: both in-turn and reflection writes surface under each answer as a
"Grid hat sich N gemerkt" chip (a reusable `Chip` primitive + `MemoryNotedChip`,
fed by `GET /api/projects/{id}/memory?conversationId=…`), labelling in-turn
(`agent`) vs reflection (`distillation`) provenance.

De-duplication: `createProjectMemoryItem` runs a three-pass write-time check on
every write (both the tool and this stage) — a normalized-equal active item is
refreshed in place instead of duplicated; a **restatement** the embedder scores
at cosine ≥ 0.9 (any kind: one fact filed as `constraint` and as `derived_fact`
is one row) or a same-kind **paraphrase** (token Jaccard ≥ 0.8 over a bounded
candidate scan) merges the same way **unless it asserts the opposite**, in which
case it supersedes rather than merges (§3.2); and an entry the caller quotes as
superseded is retired even when the finding itself merges. Within one turn the
reflection stage also sees what the `remember` tool already wrote, so the two
writers never file the same fact twice —
backed by two partial UNIQUE indexes on normalized content (migration
`0010_project_memory_dedup.sql`) that close the race window. This is a
pragmatic slice of the §3.2 gate; embed-based consolidation remains a follow-up.
See [memory-reflection-audit.md](./memory-reflection-audit.md).

### 3.6 Restricted memory (ADR-0084, ADR-0085)
"Restricted shouldn't feel like amnesia, it should feel like a first thought"
(product owner, 2026-10-02). A turn whose scope holds restricted-folder
collections `R` it may draw on remembers as any other turn does; what it writes
carries the source FOLDERS it depends on (`restricted_folder_ids`, migration
0111; the agent decides in collections and the BFF maps each to its folder),
and only a session that may read **all** of them now is served it or shown it.

**Deciding the restriction** — one function, `aiq_agent/memory/restriction.py`
`decide_restrictions`, called by the `remember` tool and the reflection stage:
1. `R` empty → open.
2. The turn cited or read sources from collections in `R` (its captures, its
   cited and read-uncited sources, and the conversation's citation registry,
   whose passages are in the history) → restricted to those.
3. Restricted documents the turn could list but did not read — the inventory
   block and `list_files` both show their summaries — go to a **model judge**:
   the memory text plus those documents' name and summary; it names the
   documents the memory draws on (strict JSON, one verdict per note), and
   their collections are added. The judge runs on the memory-reflection model
   (`memory_reflection_llm`; the tool's `judge_llm`, both `card_llm`), with the
   org's override and credential, bounded at 12 s, one call per batch.
   Restricted MEMORY the conversation was shown is judged too — this turn's
   digest `restricted` lines, what the turn already stored as restricted, and
   the restricted lines EARLIER turns were shown — and a memory drawing on one
   is restricted to the restricted collections of the scope that line was shown
   under (a digest line does not say which collections it carries). Without it,
   a paraphrase of a restricted note would be filed as open memory.
4. **Copies need no judge.** Before the judge is asked, and whatever it
   answers, a memory whose text substantially reproduces a restricted line is
   restricted to that line's collections (`restriction.reproduces`). Both are
   normalized (Unicode form, case, punctuation, spacing); it is a copy when one
   contains the other and the contained side has at least three significant
   tokens, or when the memory repeats at least 60 % of the line's significant
   tokens and at least three of them. Significant: three letters or longer, or
   holding a digit, and not a German or English function word. Measured against
   the line, so a reordered copy („Mit Büro Müller vereinbart: Statik-Honorar
   48.000 € netto" against its 7-token line) matches and a different fact about
   the same people („Die Statik prüft Büro Müller", 3 of 7) is left to the judge.
5. **Fail closed**: no judge model, a timeout, an error, an unparseable or
   partial reply, more than 150 unread restricted entries, or an unknown
   inventory → restricted to every restricted collection of the evidence.

**What earlier turns were shown** — `aiq_agent/memory/shown_notes.py`. The
digest is re-ranked per turn and capped at 1,800 characters, so a restricted
note can leave the prompt while what it said stays in the history. Every turn
with restricted collections in its signed scope adds its digest's `restricted`
lines and its restricted writes to a per-conversation record, each line with
those collections, beside the citation registry in the shared cache (key
`restricted-notes:<conversation>`, 30 days). The next turn loads it during
setup, binds it for the `remember` tool and hands it to the reflection stage.
Its collections count as restricted scope even in a turn that no longer has
them in its signed scope. The record keeps 150 lines; a line that falls out
moves its collections to `overflowed`, and every later memory of the
conversation is restricted to those, so the bound fails closed. A record lost
to the cache (eviction, outage, past 30 days) is evidence lost: the decision
then rests on this turn's digest and the citation registry, as before.

Organization scope that depends on restricted content is filed as restricted
memory of the turn's project (org memory reaches every project); the BFF
refuses a restricted organization write, and the 0111 CHECK backs it. A
restricted finding never becomes a `memory_proposal` card: accepting a card is
an open write by the user's own session.

**Writing** — `POST /api/internal/memory` takes `restrictedCollections`;
`createProjectMemoryItemForProject` maps each to the folder whose collection it
is (`sourceFoldersOfCollections` in `lib/authz/folder-access.ts`) and refuses
(400) a name no folder of the project answers to, rather than store a note
nobody could be served.

**Serving** — every reader passes the folders it may read NOW
(`readableFolderIdsFor`, tombstones of deleted folders included, judged by
`effectiveFolderLevel`), and the default is the folders every member may read:
- the live per-turn digest (`/api/internal/memory/digest`): an interactive chat
  turn sends the restricted collections it may draw on
  (`restrictedCollections`), its conversation and its signed asker (`userId`).
  A restricted note is then served when the asker may read every one of its
  folders, AND the conversation admits them against everyone it is shared with
  (`admitSourceFolders`): a restricted note in the prompt is use of its
  folders, recorded in `conversation_restricted_folders`, and the response's
  `restrictedFoldersServed` tells the agent the conversation is confined. Deep
  research, scheduled runs and the job worker send none and get open notes,
  including those whose folders every member may read again;
- the Project Memory panel and its routes (`getProjectMemory`, edit, delete):
  the session's readable folders (admins: every folder). A note the session may
  not see is absent — not counted, and an edit or delete by id is a 404. A
  reader who may see it sees a lock naming the folders;
- the digest marks a restricted line `restricted`;
- `PROPOSAL_DECISIONS` leaves out every conversation that recorded a restricted
  folder (`conversation_restricted_folders`): the block is project-wide and a
  card's words can carry what a restricted folder said.

A folder later opened to every member opens its notes; a folder narrowed shows
them to fewer people; a deleted folder's tombstone keeps answering with the
access it had (ADR-0085). Nothing is rewritten when access changes. The per-query `mem_<project>` namespace of §3.3 is not built;
recall runs inside the digest query over the row's own vector, under the same
filter. Whoever builds that namespace must keep restricted notes out of it or
filter them the same way.

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
