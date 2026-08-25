# RIS Catalog Index — Design

Date: 2026-07-16
Status: Approved (design), pending implementation plan

## Problem

`ris_search` (sources/ris_adapter) is blind: it takes German keywords, a fragile
planner LLM guesses which of ~40 OGD-RIS application silos to query
(`CONTROLLER_FOR_APPLICATION`, `sources/ris_adapter/src/client.py:51-96`), fires a
live full-text `Suchworte` search, and hopes. Wrong term or wrong silo →
"No RIS documents found". This already caused trust-chain pollution
(`docs/audit/feedback-backlog.md:106`, Cycle 13). Nothing in the system knows *which laws
exist* or *where they live*.

## Goal

A deterministic, curated pointer index: topic → exact RIS location
(application, NOR document number, citation URL, full-law URL, Bundesland
scope). The agent goes straight to the right document; blind live search
becomes the fallback for genuinely unknown topics.

## Decisions (from brainstorming, user-approved)

- **Scope:** building law + adjacent federal. ~30-40 entries: the 9
  Landesbauordnungen, Bautechnikgesetze/-verordnungen per state where separate,
  and adjacent BrKons federal acts (ASchG, Ziviltechnikergesetz,
  behindertenrelevante Normen, etc.).
- **Depth:** pointer index only. Full texts are still fetched live via
  `ris_fetch_document`. No local corpus sync (possible follow-up).
- **Delivery:** (1) prompt block in researcher prompts, (2) `ris_catalog_lookup`
  tool, (3) short-circuit inside `ris_search`.
- **Curation:** scripted live-API verification; no unverified pointers ship.
- **Architecture:** versioned YAML catalog + adapter-owned tooling. No new
  infra (no DB table, no admin API, no scheduler).

## Components

### 1. `configs/ris_catalog.yml` — the catalog

Curated, version-controlled, one entry per legal norm:

```yaml
version: 1
entries:
  - id: bo-wien                      # stable slug
    title: "Bauordnung für Wien"
    short: "BO Wien"
    application: LrKons              # RIS application (from CONTROLLER_FOR_APPLICATION)
    document_number: "NOR40038759"   # verified against live API at curation time
    citation_url: "https://www.ris.bka.gv.at/eli/lgbl/WI/..."
    full_law_url: "https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=LrW&Gesetzesnummer=..."
    bundesland: "Wien"               # "" for federal entries
    topics: [baugebuehr, bauantrag, fluchtwege]   # German domain terms, closed vocabulary
    relevance: "State building code for Vienna — permits, fees, construction rules"
    verified_at: "2026-07-16"        # curation/verification date
```

`topics` uses a controlled vocabulary of German domain terms (same philosophy
as `src/aiq_agent/knowledge/document_classification.py`'s closed tag
vocabulary) to keep matching deterministic.

### 2. `sources/ris_adapter/src/catalog.py` — loader + matcher + renderer

- Loads the YAML once, caches in-process; validates schema via pydantic.
- `match(query) -> list[CatalogEntry]`: deterministic matching against
  `topics` and `title` — case- and umlaut-normalized substring match on the
  query (no LLM, no fuzzy scoring).
- `render_prompt_block(bundesland: str | None) -> str`: renders **all** entries
  as one compact line each (`short — title [application/NOR]`), ordered
  Bundesland-first when a Bundesland is known from project facts — same
  pattern as `frontends/ui/src/lib/oib/applicable-standards.ts`.
- Missing/invalid catalog → logged warning, all consumers degrade gracefully
  (see Error handling).

### 3. `ris_catalog_lookup` tool — `sources/ris_adapter/src/register.py`

Registered like the existing two tools. Input: free-text German topic.
Output: full pointer set (application, NOR number, citation URL, full-law URL,
relevance note). The agent then calls `ris_fetch_document` directly with the
NOR number — zero guessing. No match → clear "not in curated catalog, use
ris_search" guidance.

### 4. `ris_search` short-circuit — `_ris_search` in `register.py`

Before the planner LLM runs: if the query contains an exact normalized match
against the `topics` vocabulary or an entry `title` (same normalization as
`catalog.match`), return the catalog pointer block instead of firing a live
`Suchworte` query, with a note that live search remains available for anything
outside the catalog. Any query without an exact normalized match goes to the
normal planner path — the fragile path becomes the exception, not the default.

### 5. Prompt wiring

Catalog block injected into `shallow_researcher/prompts/researcher.j2` and
`deep_researcher/prompts/researcher.j2`, beside the existing
`available_documents` block. Bundesland-aware ordering when project facts are
available.

### 6. `scripts/build_ris_catalog.py` — curation + verification

Contains the seed list (the ~30-40 norms by name/expected NOR), queries the
live OGD-RIS API, verifies each document number and captures the real citation
and full-law URLs, and writes `configs/ris_catalog.yml`. Fails loudly on any
entry that cannot be verified. Re-runnable when a Bauordnung is novelliert —
updates `verified_at`, and the diff is reviewable in git.

## Data flow

```
Agent question (German legal topic)
  → prompt block already shows core norms (no tool call for common cases)
  → ris_catalog_lookup(topic) → exact pointers
  → ris_fetch_document(NOR…) → full text → session KB → citation [RIS]

Unknown topic:
  → ris_search (planner LLM → live OGD-RIS) — unchanged fallback path
```

## Error handling

- Catalog file missing/invalid at load → warning logged; prompt block omitted,
  lookup tool returns "catalog unavailable", `ris_search` behaves exactly as
  today. The catalog never breaks the existing live path.
- Lookup with no topic match → "not in curated catalog, use ris_search".
- Short-circuit only fires on exact normalized matches; everything else goes
  to the normal live path.

## Testing

pytest in `sources/ris_adapter/tests/`:

- YAML schema validation (runs in CI — a hand-edited catalog can't ship
  malformed).
- Loader caching; missing/invalid file degradation.
- Topic matching: hit, miss, Bundesland ordering.
- `ris_catalog_lookup` output format (mocked catalog).
- `ris_search` short-circuit: match → pointer block without HTTP; no match →
  existing planner path (mocked).

## Out of scope (explicit)

- Full local corpus sync into ChromaDB (`ris_knowledge`) — follow-up candidate.
- Automatic/scheduled catalog refresh; metadata auto-refresh.
- DB-backed catalog or admin UI.
- Web UI changes.

## Addendum (same-day follow-up): jurisdiction as a structured fact

Review of the first cut exposed a ranking hole: the nine state building codes
all share generic topics ("bauordnung"), matches were returned in catalog
order, and truncation happened before any jurisdiction filter — a lookup for
"Bauordnung Tirol" with `max_matches: 5` returned Wien/NÖ/OÖ/Stmk/Ktn and
dropped Tirol entirely. The deeper root cause: the Bundesland was never a
structured fact anywhere in the system, only free text.

Shipped in this PR on top of the original design:

- **Intake wizard** (`intake-definition.ts`): required `bundesland`
  single-select (nine states + "Outside Austria") writing to
  `/facts/bundesland/value`, plus a conditional free-text `standort_details`
  for non-Austrian projects. Vocabulary-validated like every intake fact.
- **Backfill** (drizzle `0018`): pre-existing projects get an *unconfirmed*
  `bundesland=wien` assumption (`onboarding_default`) — surfaced in the
  Project Brief for one-click confirm/correct, spliced into the stored prompt
  view, retired automatically once a confirmed fact exists
  (`pruneResolvedAssumptions` in `persistProfile`).
- **Matcher** (`ris_catalog.py`): `extract_bundesland` reads the structured
  `bundesland=<token>` prompt-view line as authoritative (free-text state-name
  probing is the fallback); new `focus_entries` drops other states' law and
  sorts the project's state first, federal law always kept.
- **Tools** (`register.py`): both the `ris_search` short-circuit (explicit
  `bundesland` argument wins, query text is fallback; non-default
  `application` narrows) and `ris_catalog_lookup` (state named in the topic)
  filter via `focus_entries` BEFORE truncation.
