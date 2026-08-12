# ADR-0047: A document's shelf travels as data, not as a name or a label

- **Status:** Proposed
- **Date:** 2026-08-12
- **Deciders:** Grid engineering
- **Related:** ADR-0024 (org-wide Archiv), ADR-0026 (source-kind taxonomy), ADR-0045 (IFC models as a queryable building)

## Context

A document in Grid sits on one of three shelves: the org-wide **Archiv**, a
**project**, or a private chat **session**. That single fact decides who may
read it, which collection retrieval searches, how a citation is labelled, and —
since ADR-0045 — whether an upload is parsed as a building or embedded as text.

It is currently defined four times, in four vocabularies, none of which is the
source of truth.

| # | Definition | Vocabulary | Gap |
|---|---|---|---|
| 1 | `documents.scope` — `frontends/ui/src/lib/db/schema/documents.ts:22` | `project \| archiv` | no `session` |
| 2 | `CollectionScope` — `frontends/ui/src/features/chat/lib/source-kinds.ts:70` and its Python mirror `src/aiq_agent/common/source_kinds.py:141` | `baurecht \| buero \| projekt` | `session` folded into `projekt`; includes `baurecht`, which is not a shelf |
| 3 | `uploadTarget` — `frontends/ui/src/features/layout/components/FileSourcesTab.tsx:73` | `project \| session` | no `archiv` |
| 4 | Collection-id prefixes `archiv_` / `proj_` / `s_` | duplicated in `source-kinds.ts:72` and `source_kinds.py:141` | — |

### The shelf is destroyed at the wire and guessed back twice

| Hop | What crosses | Shelf |
|---|---|---|
| DB → BFF | `documents.scope` | present (two values) |
| BFF → agent | `X-Grid-Collection-Scope`: a list of raw collection ids (`register.py:320,340`) | **erased** |
| retrieval → citation | `chunk.metadata['collection']` re-matched by prefix (`register.py:713,720`) | **re-derived** |
| agent → frontend | citation key carrying a German qualifier, e.g. `(Projektwissen)` | **re-derived again** (`scopeForQualifier`) |

Two prefix tables exist because, by the time anything downstream needs the
shelf, the only thing left to inspect is a name. A parity test keeps the two
tables equal; it polices the duplication rather than removing it.

### Consequences visible today

- A file the user attaches privately to a chat is cited as **"Projektwissen"**,
  because `('s_', 'projekt')` is the only guess available. The user is told the
  file went to a *"Private Sitzung"* (`de/research.ts:194`) and then sees the
  answer attribute it to project knowledge.
- `collectionScope()` fails **open**: an unrecognised collection returns
  `baurecht`, so an unknown document claims to be authoritative base law. This
  is the same failure the code already guards against one function away, where
  `baurecht_basis` is explicitly stopped from inheriting a RIS badge.
- The agent cannot tell the shelves apart at all: `available_documents` carries
  `(file_name, summary)` only (`src/aiq_agent/agents/clarifier/models/state.py:58`).
- `SCOPE_QUALIFIERS` strings are pinned as un-renameable because they are
  persisted inside citation keys — display copy has become a wire format.

## Decision

**We will make the shelf an explicit field that travels across every boundary,
and delete every place that infers it from a name.**

1. **Shelf travels as data.** The scope header, chunk metadata, and the citation
   payload each carry the shelf explicitly. No consumer parses a collection-id
   prefix or a display label to recover it.

2. **Both prefix tables are deleted.** `COLLECTION_SCOPE_PREFIXES`
   (`source-kinds.ts:72`) and `_COLLECTION_SCOPE_PREFIXES`
   (`source_kinds.py:141`) are removed, not synchronised. Their deletion is the
   acceptance test for this ADR: if either survives, the shelf is still being
   guessed.

3. **Each runtime owns its own small, total enum.** TypeScript declares a
   discriminated union with an exhaustive switch (a missing case is a compile
   error); Python declares a `StrEnum` with an exhaustiveness guard. Neither
   runtime imports the other's. Three constants declared twice is looser
   coupling than a shared artifact, and cheaper than generating them.

4. **We will not generate this.** Code generation is reserved for large evolving
   schemas (cards, ADR-0026 lineage). A three-member enum does not justify a
   build step on the core retrieval path.

5. **German is rendering, never transport.** Labels become a pure function of the
   shelf on the display side. New citation payloads carry the shelf; a versioned
   reader continues to parse legacy qualifier-based keys already persisted in
   messages.

6. **The database anchors the definition.** `documents.scope` is the durable
   statement of which shelf a document is on; every other representation is a
   projection of it.

7. **A round-trip contract test replaces the parity test.** One test drives the
   seam end to end — BFF emits shelf X, retrieval carries X, the citation
   returns X, the frontend renders X — so a shelf added on one side only fails
   at the boundary where it actually breaks.

### The contract

Two enums, deliberately different sets. Conflating them is what produced the
current mess.

**Wire shelf** — where a *retrieved chunk* came from. Carried explicitly in the
scope header, chunk metadata and citation payload:

| Shelf | Collection | Display label (rendering only) |
|---|---|---|
| `archiv` | `archiv_<org>` | Büroarchiv |
| `project` | `proj_<id>` | Projektwissen |
| `session` | `s_<id>` | *(new — a private attachment, no longer "Projektwissen")* |
| `base` | base corpus | Basiswissen |

**DB scope** (`documents.scope`) — where a *stored document* lives: `project |
archiv` in Phase 1, gaining `session` in Phase 2.

The wire shelf carries `session` from Phase 1, because session *collections*
already exist in retrieval even though session *documents* are not yet rows.
That asymmetry is precisely what fixes the mislabel without a premature schema
change.

`base` is retrieval provenance, not a shelf a user can file to; it is separate
from the `baurecht | buero | projekt | web` display taxonomy (ADR-0026), which
remains its own axis.

A missing shelf on the wire reads as *unknown* and renders unattributed. It is
never defaulted to `base`/`baurecht`.

### Sequencing

**Phase 1 — correctness, no new shelf.** Shelf on the wire; both prefix tables
deleted; German demoted to rendering; round-trip test. This removes both
inferences and fixes the session mislabel without adding any concept.

**Phase 2 — `session` becomes a real shelf.** Session uploads create real
`documents` rows through the BFF pipeline, and `session` joins `DocumentScope`.
Deliberately second: until session files are rows, a `session` enum member is a
value no row can hold, which is a worse foundation than omitting it. Phase 2
carries the upload-target unification and the model-pipeline decision for
session uploads.

## Consequences

### Positive

- Net **less** machinery than exists today: two tables and one parity test are
  removed, and nothing is generated.
- The private-attachment mislabel is fixed at its cause rather than by adding a
  fourth special case.
- Renaming user-facing German copy stops invalidating citation keys.
- The agent can distinguish office knowledge, project knowledge and a file the
  user just dropped into the conversation.

### Negative

- The wire payloads gain a field, so BFF and agent must be deployed in a
  compatible order; the reader tolerates a missing shelf during the rollout.
- Citation keys exist in two forms (legacy qualifier, new shelf) until old
  messages age out.

### Risks

- **Silent fail-open during rollout.** A missing shelf must be represented as
  *unknown*, never defaulted to `baurecht`; the exhaustive switch and the
  round-trip test are the guards.
- **Phase 2 scope creep.** Rerouting session uploads touches list, delete,
  polling and session-discard. It is sequenced behind Phase 1 so the foundation
  lands independently of it.

## Alternatives Considered

- **Generate a shared scope module into both languages** (cards pattern) —
  rejected: a build step on the core path to share three constants, and it would
  have left both re-derivations intact, since the enum is not what travels.
- **A shared cross-language package** — rejected: couples the agent to the BFF's
  domain model to save two small declarations.
- **Keep the mirrors and extend the parity test** — rejected: it preserves the
  guessing that causes the defect and only asserts the two guesses agree.
- **Add `session` to `DocumentScope` immediately** — rejected for Phase 1: no row
  can hold the value until session uploads create rows.

## Open Questions / Follow-ups

- Should `baurecht` leave the shelf enum entirely and become a separate
  provenance axis? It is the reason `CollectionScope` must be a subset type
  today. Current lean: yes.
- Does `ifc_query` become shelf-aware, or stay project-pinned? A session-scoped
  model has no viewer home.
- `backlog.md:58` claims ~14 pre-existing failing frontend specs; the suite is
  green as of 2026-08-12 (477 files / 6223 tests). The stale note should be
  removed.

## References

- `frontends/ui/src/features/chat/lib/source-kinds.ts` — TS taxonomy + prefix table
- `src/aiq_agent/common/source_kinds.py` — Python mirror
- `sources/knowledge_layer/src/register.py:315-360,713-720` — collection selection and re-derivation
- `frontends/ui/src/lib/db/schema/documents.ts` — `DocumentScope`
