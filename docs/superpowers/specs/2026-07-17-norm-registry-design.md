# Norm Registry & Structured RAG — Design

**Date:** 2026-07-17
**Status:** Amended after review (v2) — approved for implementation
**Scope:** Phases 0–5 of the Normenregister program (parcel layer is a separate spec)
**ADR:** Will be recorded as **ADR-0025** (0024 is taken by the org Archiv, commit `b29baee`)

## 1. Context and goals

Today the retrieval pipeline is flat: 39 OIB PDFs (including 15 `aenderungen_*` diff files and
superseded duplicates) are ingested into one `oib_knowledge` collection with filename+page as the
only chunk identity; `configs/ris_catalog.yml` is a flat list of 15 RIS pointers with no notion of
legal rank, role, edition, or relations; the two researcher prompts render a catalog block, but the
writer/orchestrator/planner do not; `NormReference` on cards is free text; and the frontend
`applicable-standards.ts` hardcodes a third copy of the OIB taxonomy.

Goal: one typed **norm registry** as the spine (rank, role, editions, relations, applicability),
a **structure-aware ingestion** pipeline (real OIB `Punkt` / RIS `§` grammar, deterministic
context prefixes, metadata-stamped chunks), **stratified retrieval** (metadata filters, parent
expansion, rank/role labels), and **consumers** wired to the registry (prompt doctrine block,
applicability engine, trust-chain on cards, citation verification, compliance checker).

Non-goals (explicitly out of scope):

- Parcel layer (plans, Flächenwidmung upload/extraction, Vienna open-data zoning) — separate spec.
- Case-law (Judikatur) silos beyond what RIS search already does.
- German (or other country) corpora — the model supports them, no corpus is seeded.
- MA 37 / `behoerdliche_info` seeding — the rank exists in the enum, but no seeds and no phase in
  this program (explicitly deferred).
- RAPTOR/GraphRAG-style generated hierarchies — rejected (see §2).

## 2. Research basis (verdicts)

| Technique | Verdict | Reason |
|---|---|---|
| Hierarchical levels (doc → section → chunk) | **Adopt, structurally** | Parse the real OIB `Punkt` and RIS `§` grammar; do not generate a hierarchy. |
| Anthropic Contextual Retrieval | **Adopt, deterministically** | Prefix is registry-known (`OIB-RL 2 — Brandschutz (Ausgabe 2023-05), Pkt 3.1.2, normativ`), zero LLM cost. Anthropic measured −49 % retrieval failures. |
| Parent expansion | **Adopt, simplified** | Retrieve small `Punkt`-chunks, expand to the full `Punkt`/`§` by metadata lookup. No docstore tree. |
| Chroma metadata filtering | **Adopt** | `$and/$or/$in/$nin/$contains` confirmed; wire the existing-but-dead `filters` param to `where`. |
| BM25 hybrid | **Defer** | A cited `Punkt` is a deterministic lookup key, not a search term. Revisit if evals show lexical misses. |
| RAPTOR (cluster-summaries) | **Reject** | The corpus has rigid official numbering; clustering adds failure modes without gain. |
| GraphRAG | **Reject** | The registry *is* the graph — ~60 hand-verified nodes, no LLM entity extraction needed. |

## 3. Norm registry

### 3.1 Storage layout — one folder per country

```
configs/norms/
  at/
    registry.yml      # all Austrian norm entries (schema below)
    seeds_ris.yml     # RIS verification seeds for the build script
  de/                 # future: same two files, zero backend changes
```

The loader globs `configs/norms/*/registry.yml` and merges entries keyed on `country`.
Per-country folders (not flat `at.yml`/`de.yml` files) so a country can grow extra artifacts
(per-state seed splits, deviation lists) without restructuring.

**Loader validation (fail-loud):** the OIB-family id convention is validated at load time — any id
matching `oib-rl-<N>-<suffix>` (e.g. `oib-rl-2-leitfaden`) must have a base entry `oib-rl-<N>` in
the same registry. A typo fails validation instead of silently orphaning a Leitfaden.

### 3.2 Entry schema

```yaml
version: 1
country: at                      # ISO 3166-1 alpha-2, required on every entry and every chunk
entries:
  - id: oib-rl-2
    title: "OIB-Richtlinie 2 — Brandschutz"
    short: "OIB-RL 2"
    rank: oib_richtlinie         # bundesgesetz | landesgesetz | verordnung
                                 # | oib_richtlinie | oib_leitfaden | oib_erklaerung
                                 # | oib_referenz | behoerdliche_info | norm_extern | plan_parzelle
    role: normativ               # normativ | anwendend | erklaerend | definierend | diff
                                 # definierend is RESERVED for Begriffsbestimmungen-type docs
    jurisdiction: { country: at, state: null }   # state = bundesland code for Landesrecht
    aliases: ["OIB RL 2", "Richtlinie 2 Brandschutz"]
    editions:
      - id: "2023-05"
        label: "Ausgabe Mai 2023"
        status: current          # current | superseded
        source: { kind: corpus, file: "oib-rl_2_ausgabe_mai_2023.pdf" }
      - id: "2023-05-aenderungen"
        label: "Änderungen Ausgabe Mai 2023"
        status: current
        role: diff               # edition-level role override
        source: { kind: corpus, file: "aenderungen_oib-rl_2_ausgabe_mai_2023.pdf" }
    relations:
      - { type: declares_binding, target: oenorm-b-1600, status: verified }
    applicability:               # optional, DSL pinned in §6.2
      - when: { all: [ { fact: hauptnutzung, op: in, value: [wohnen, buero] } ] }
        verdict: required
        reason_de: "…"
        reason_en: "…"
    verified_at: "2026-07-17"

  - id: wbtv-2020
    title: "Wiener Bautechnikverordnung"
    rank: verordnung
    role: normativ
    jurisdiction: { country: at, state: wien }
    editions:
      - id: "2020"
        label: "WBTV 2020"
        status: current
        source: { kind: ris, application: LrKons, document_number: "…" }
    relations:
      - { type: implements, target: bo-wien, status: verified }
      - type: declares_binding
        target: oib-rl-2
        edition: "2023-05"
        status: unknown          # unverifiable legal facts are never guessed
        note: "Verbindlich erklärte Edition + Abweichungsanlage aus WBTV-Volltext verifizieren"

  - id: oenorm-b-1600
    title: "ÖNORM B 1600 — Barrierefreies Bauen"
    rank: norm_extern
    role: normativ               # normative WHEN CITED/declared binding; NOT definierend
    jurisdiction: { country: at, state: null }
    access: { kind: unavailable, note: "Bezugsnorm; Volltext nicht lizenziert" }
    editions: []
```

**Role taxonomy notes:**

- `definierend` is reserved for Begriffsbestimmungen/definitions documents. External technical
  norms (ÖNORM, EN) are `role: normativ` — they state requirements when declared binding — and
  carry `access: unavailable`, which drives the ÖNORM-honesty rule. The
  guidance-cited-as-requirement check (§6.4) flags only `anwendend|erklaerend` roles, so ÖNORM
  citations do not misfire.
- **Änderungen as editions:** modeling diff documents as editions of the parent norm is
  semantically imprecise but pragmatically right (keeps family grouping trivial). The combination
  `status: current` + `role: diff` is intended; chunk stamping MUST apply the edition-level role
  override so diff chunks carry `role: diff` and fall under the default exclusion (§5.1).

Exactly three relation types, each with a named consumer:

- `implements` → prompt doctrine block, lane ordering
- `declares_binding` → deviation discipline in prompts, applicability engine, jurisdiction-aware
  edition selection (§5.1)
- `supersedes` → retrieval default filter

OIB-family grouping (Richtlinie ↔ Leitfaden ↔ Erläuterung ↔ Änderungen) is **derived** from
`rank` + the validated id convention (§3.1), never hand-authored.

### 3.3 Migration from `ris_catalog.yml`

- The 15 existing entries migrate to `rank: bundesgesetz|landesgesetz`, `role: normativ`; their
  RIS fields (`application`, `document_number`, URLs) nest under `editions[].source`.
- `configs/ris_catalog.yml` is retired. `src/aiq_agent/common/ris_catalog.py` becomes
  `norm_registry.py` with a backward-compat shim (old import path keeps working, warns once).
- `scripts/build_ris_catalog.py` becomes a **merge** tool: it re-verifies only `kind: ris`
  sources live against OGD-RIS (unchanged fail-loud semantics) and merges `document_number`,
  URLs, `verified_at` into `registry.yml`. Curated fields (rank, role, relations, aliases,
  applicability, notes) are never clobbered. Seeds move to `configs/norms/at/seeds_ris.yml`.
- New env var `GRID_NORMS_DIR` (default `configs/norms`); `RIS_CATALOG_PATH` is deprecated but
  still honored by the shim with a warning.

## 4. Ingestion pipeline

### 4.1 Registry-driven base corpus

`oib_sync` becomes registry-aware for `data/oib/`: it ingests exactly the files referenced by
`configs/norms/at/registry.yml` editions of `kind: corpus`, stamping metadata from the registry.
Files in `data/oib/` not referenced by any edition are skipped with a warning (the registry is
the contract). The platform-owner uploads flow (`data/oib_uploads/`) is unchanged.

This resolves the current flat-ingest problems by construction: the 15 `aenderungen_*` files get
`role: diff`, the superseded non-rev.1 `zitierte_normen` duplicate gets `status: superseded` —
both are ingested but excluded by the default retrieval filter (§5.1).

### 4.2 Structure-aware chunking (OIB `Punkt` grammar)

A per-country **corpus adapter** (`src/aiq_agent/knowledge/corpus/at.py`) parses the pdfplumber
page text:

- Detect `Punkt` headings (`^\s*(\d+(?:\.\d+)*)\s+…` plus the OIB typographic conventions) and
  split on `Punkt` boundaries instead of the current 1024-token page chop.
- Leaf chunk = one `Punkt` (sub-points stay with their parent unless they exceed the chunk cap,
  in which case they split at sub-point boundaries).
- Fail-open: a PDF that does not match the grammar falls back to today's page-based chunking with
  doc-level metadata only, plus a logged warning.

Every chunk is stamped:

```
doc_id, edition, edition_status, rank, role, country, punkt, punkt_title,
file_name, page_label, chunk_index
```

(`paragraph` instead of `punkt` for RIS-fetched laws, §4.4.)

### 4.3 Deterministic context prefix

Before embedding, each chunk text is prefixed with a deterministic line built from registry
metadata — no LLM call:

```
OIB-RL 2 — Brandschutz (Ausgabe 2023-05), Pkt 3.1.2, normativ
```

This is the Anthropic Contextual-Retrieval effect at zero marginal cost; all fields are known at
ingestion time.

### 4.4 `ris_knowledge` persistent norm cache — with a freshness policy (Phase 3)

`ris_fetch_document` currently ingests full text into the TTL'd session collection `s_<conv>`
only. It will additionally write into a **persistent** `ris_knowledge` collection. A persistent
cache of consolidated statutes (LrKons/BrKons) is a **correctness hazard** — a Novelle changes
the text, and these statutes version by *Fassung* date, not by Ausgabe — so the cache is only
acceptable with an explicit freshness policy:

- **Versioning:** for `kind: ris` sources, the cache edition key is the RIS-reported
  Fassung/last-changed date, not a registry-authored Ausgabe id. `edition` (registry Ausgabe) is
  only set when the document is registry-known.
- **Blind fetches:** documents fetched via `ris_search` that are NOT in the registry are keyed by
  `(document_number, content_hash)` with no edition.
- **Cache record:** each cached document carries `fetched_at`, `content_hash` (SHA-256), and the
  RIS last-changed/Fassung metadata captured at fetch time.
- **TTL re-validation:** when a cached copy is older than `GRID_RIS_CACHE_TTL_DAYS` (default `7`),
  it is NOT served blindly: the fetch path first re-checks the RIS metadata (cheap call). If
  last-changed moved → re-fetch, re-chunk, replace. If unchanged → refresh `fetched_at` and serve.
  Within the TTL the cached copy is served directly (that is the cost win).
- **No "no-op forever":** the unchanged-hash skip only applies *after* a metadata re-validation
  within the TTL window; the hash alone never short-circuits a stale copy.
- The session collection keeps a short pointer document ("WBTV 2020 fetched, see ris_knowledge")
  so the existing session-scoped flow is unaffected.
- Superseded Fassungen are marked, never auto-deleted.

**Retrieval scope:** `ris_knowledge` is a backend-global collection like `oib_knowledge`. It is
added to the fan-out in `_resolve_target_collections` (`knowledge_layer/register.py:216-280`)
alongside base/project/session collections — it is NOT part of the frontend
`X-Grid-Collection-Scope` header.

## 5. Retrieval pipeline

### 5.1 Metadata filtering — wiring the dead param, jurisdiction-aware

`BaseRetriever.retrieve(filters=…)` exists (`knowledge/base.py:162`) but no caller passes filters
and the LlamaIndex adapter ignores them (`llamaindex/adapter.py:2379-2403`). Wire it end to end:

- `knowledge_search` tool gains an optional `filters` argument (dict passed through).
- The adapter translates it to a Chroma `where` clause (`$and/$or/$in/$nin`).
- **Default filter** (applied when the caller passes none) for `oib_knowledge` and `ris_knowledge`:
  exclude `role: diff`; exclude `edition_status: superseded` **only when no verified
  `declares_binding` relation from any state points at that edition**. Project/session
  collections are unaffected (they carry no role metadata).
- **Jurisdiction-aware edition selection:** when a project context with `bundesland` is present,
  norm collections prefer the edition declared binding for that state
  (`declares_binding.edition`, status `verified`); fall back to `status: current`.
  `edition_status` alone NEVER hard-excludes an edition that some state still binds — an OIB
  edition can be superseded by the OIB and still be the binding one in a given state.
- Explicit caller filters override the default (e.g. "show me the Änderungen" must be possible).

### 5.2 Parent expansion

After similarity search, chunks with `punkt`/`paragraph` metadata are expanded: if a `Punkt` is
matched only partially (some of its chunks retrieved), fetch all chunks sharing
`(doc_id, edition, punkt)` ordered by `chunk_index` and present the full `Punkt` text (token cap
applies). Implemented as a retriever post-step, flag-gated (`parent_expansion: true` default for
norm collections).

### 5.3 Stratum labels in results

`_format_results` (`knowledge_layer/register.py:328-370`) gains rank/role labels so the LLM sees
e.g. `[oib_richtlinie · normativ · Ausgabe 2023-05]` per hit instead of just Source/Page. The flat
score-merge across collections is unchanged — stratification is expressed through labels +
filters, not through re-ranking (deliberately minimal intervention).

## 6. Consumers

### 6.1 Prompt doctrine block

A German `Normenhierarchie & Dokumentrollen` block, rendered by
`norm_registry.render_doctrine_block(project_context)` (jurisdiction-aware via the existing
bundesland chain), injected into the **shallow researcher, deep researcher, deep writer, and deep
planner** prompts (writer and planner currently render nothing — the planner is the one planning
queries and arguably benefits most from the lane listing). Phase 0 ships the static text; Phase
1+ adds the registry-rendered lane listing. Content:

1. Authority order per question ≠ retrieval-trust order.
2. Role rules: Anforderungen nur aus `normativ` Dokumenten; Leitfaden = Anwendung; Erläuterung =
   Begründung; MA 37 = Praxis, niemals neue Norm; Kommentare nicht verfügbar — sagen, nicht
   simulieren.
3. Deviation discipline: OIB-Zitat ⇒ verbindlich erklärte Edition + Landesabweichungen prüfen
   oder offen kennzeichnen; Edition = registry-binding, nie "neueste".
4. Definitions follow the layer of the question (Gebäudehöhe-Beispiel).
5. ÖNORM honesty rule (Bezugsnorm, kein Volltext).
6. Bestand/Übergangsrecht flag when `bestand_neubau != neubau`.

### 6.2 Applicability engine — rule data in the registry, DSL pinned

Applicability rules live in `registry.yml` (`applicability:` on entries) as data. The DSL is
defined NOW, not discovered in Phase 4:

```yaml
applicability:
  - when:
      all:                                # AND of conditions (required)
        - { fact: hauptnutzung, op: in, value: [wohnen, buero] }
        - { fact: gebaeudeklasse, op: gte, value: 4 }
      any:                                # optional OR group
        - { fact: fluchtniveau, op: undefined }
        - { fact: fluchtniveau, op: lte, value: 8 }
    verdict: required                     # required | likely | check
    reason_de: "…"                        # BOTH languages required (bilingual UI)
    reason_en: "…"
```

- **Operators:** `eq`, `in`, `defined`, `undefined`, `gt`, `gte`, `lt`, `lte`. `defined`/
  `undefined` make the fact-present-vs-fact-unknown distinction first-class (the current TS logic
  relies on it: GK5 + unknown Fluchtniveau → `check`).
- **Combination rule:** rules are evaluated in document order; **first match wins**. No rule
  matches → the standard is omitted (not shown as `check`). This mirrors today's
  omit-vs-check-vs-required behavior.
- **Facts vocabulary:** `hauptnutzung`, `gebaeudeklasse`, `fluchtniveau`,
  `geschosse_unterirdisch`, `bestand_neubau`, plus new intake triggers `kleingartengebiet`,
  `denkmalschutz`, `betriebsanlage`, `stellplatz_relevant`.

Two generated consumers, one source of truth:

- **Python resolver** `src/aiq_agent/common/applicability.py` — used by researcher prompts and
  compliance Stage 1.
- **TypeScript output** generated into `frontends/ui/src/lib/oib/generated/` by a codegen script
  (same pattern as the existing cards codegen), consumed by the project Overview UI. A parity
  test runs fixture profiles through both implementations and diffs the verdicts.
- `applicable-standards.ts` and the standards catalog stop hand-encoding rules; the
  six-Richtlinien taxonomy gets one registry-backed definition with parity tests (kills the three
  hardcoded copies).

### 6.3 Trust chain on `NormReference` — system-derived only

`NormReference` gains optional `norm_id`, `rank`, `binding` (`normativ|anwendend|erklaerend`),
`via`. **The LLM never authors these fields.** After card emission, a resolver matches the
LLM-written free-text `document`/`edition` against registry aliases and stamps the structured
fields; unmatched references stay free-text (backwards compatible). TS mirror + zod schemas are
regenerated by the existing cards codegen.

### 6.4 Registry-validated citation verification

`verify_citations` gains a registry pass:

- `document` + `edition` must resolve against the registry (typo/hallucination catch).
- Guidance-cited-as-requirement flag: a chunk of role `anwendend|erklaerend` cited in an
  "Anforderung" sentence produces a verification note, not silent acceptance. (Roles `normativ`
  — including ÖNORM entries — never trigger this flag.)

### 6.5 Compliance checker

Stage 1 takes its Richtlinien scope from the applicability engine (facts-driven) instead of the
static `[1..6]` config; requirement IDs stay `R<rl>-<punkt>`; matrix rows inherit
`rank`/`binding` from the registry so the report can distinguish Norm-Verstoß from
Leitfaden-Abweichung.

### 6.6 `ris_catalog_lookup`

Returns relations and lane grouping alongside the pointer data it returns today.

## 7. Country extension model — the `CountryPack` contract

`country` (ISO 3166-1 alpha-2) is required on every registry entry and every chunk. Everything
above — rank/role/editions/relations, chunking metadata, filters, doctrine block, applicability —
is country-agnostic. Per-country variance is isolated behind ONE explicit contract so that adding
a country is "implement the pack, add the folder", never "fork the backend":

- `src/aiq_agent/common/country_packs/base.py` — the **`CountryPack` protocol**. Every country
  MUST provide:
  - `country: str` — the ISO code this pack answers for;
  - `states: Mapping[str, str | None]` — the intake state-token vocabulary (token → canonical
    name; a token mapping to `None` is an explicit "outside this country" sentinel);
  - `state_token_to_name` / `state_name_to_token` / `extract_state(text)` /
    `resolve_state(text)` — jurisdiction resolution (structured envelope fact first, then
    structured prompt-text line, then free-text probing);
  - `doctrine_lines: list[str]` — the country-specific header of the lane-rendered registry
    prompt block (the legal-hierarchy doctrine the model must apply);
  - `validate_ids(entries) -> list[str]` — country-specific id-convention checks (AT: the
    OIB-family `oib-rl-<N>-<suffix>` ⇒ base-entry rule);
  - optional `corpus_grammar` — Phase 2 hook: filename conventions, `Punkt`/`§`/`Art.` grammars,
    citation label formats (AT implements `corpus/at.py` in Phase 2).
- `src/aiq_agent/common/country_packs/at.py` — the Austria pack (ships now; the existing
  `_BUNDESLAENDER`/token maps, Bundesland probing, doctrine header, and OIB id rule move here;
  `norm_registry`'s public helpers become thin delegates for backward compatibility).
- `configs/norms/<country>/` — registry + legal-source seeds (`seeds_ris.yml` is the AT/RIS
  instance of a `seeds_<provider>.yml` pattern).

**Pack-validated loading:** `load_registry` rejects entries whose `jurisdiction.country` has no
registered pack and entries whose `jurisdiction.state` token is not in the pack's `states`
vocabulary — runtime drops the offending entry with a warning (fail-open per-entry, like the
country-mismatch rule); `strict=True` raises (config bug, caught by the build script and the
shipped-registry test).

**Project country:** backend resolution reads a structured `country=<iso>` fact (default `at`);
the intake-wizard country question ships when a second country actually onboards (YAGNI until
then — the resolution seam exists, the UI does not).

Germany later = `country_packs/de.py` + `configs/norms/de/registry.yml` + `corpus/de.py`. No
backend changes, no second backend, and the pack contract is what "done" means for that work.

## 8. Phasing

| Phase | Scope | Exit criteria |
|---|---|---|
| **0** (days) | Static doctrine block in shallow+deep researcher, writer, planner prompts; default exclusion of diff/superseded files via a **`file_name $nin [...]` where-clause** built from a filename-prefix heuristic (`aenderungen_*`, non-rev.1 `zitierte_normen` duplicates) — chosen over deleting chunks because it is reversible; mark `config_grid_oib.yml` as non-Baurecht. **Note:** the preview seed tarball (`deploy/entrypoint.py` seed-restore) bakes the old flat chunks in and must be regenerated either way. | Prompts render doctrine; diff chunks no longer surface in default retrieval |
| **1a** (~1–2 wk) | Registry schema (pydantic) incl. id-convention validation, `configs/norms/at/registry.yml` + `seeds_ris.yml`, `norm_registry.py` + shim, migrate 15 entries, build-script merge mode, lane rendering, lookup relations, **ADR-0025** | `registry.yml` validates (incl. orphan check); old import path works; catalog tests pass against new module |
| **1b** (~1 wk) | **Coverage seeding + live verification:** WBTV, Wiener Garagenverordnung, Kleingartengesetz, remaining Wiener Verordnungen/Nebengesetze, federal feasibility cluster (DMSG, UVP-G, WRG, ForstG, GewO §74ff, BauPVO); resolve the WBTV `declares_binding` `status: unknown` edges to verified facts at least for Wien. MA 37 explicitly deferred. | All seeds verify fail-loud against OGD-RIS; WBTV→OIB edges resolved for Wien; registry entry count grows from 15 to ≥ 30 |
| **1c** (~2–3 d) | **CountryPack contract:** `country_packs/` package (protocol + `at.py` extraction + registry), pack-validated loading (state vocabulary, unknown-country rejection), doctrine lines from the pack, structured `country=<iso>` resolution (default `at`); wizard country question deferred | Loader rejects unknown country/state in strict mode; all existing registry tests pass unchanged through the AT pack delegates |
| **2** (~1–2 wk) ✅ implemented 2026-07-17 | `corpus/at.py` Punkt parser, chunk metadata stamping, context prefix, parent expansion, filters wiring (incl. jurisdiction-aware edition selection), full corpus re-ingest | Chunks carry `doc_id/edition/punkt/rank/role`; default filter excludes diff+superseded via metadata; citation format `OIB-RL 2, Pkt 3.1.2, Ausgabe 2023-05` |
| **3** (~1 wk) ✅ implemented 2026-07-17 | `ris_knowledge` persistent cache **with the §4.4 freshness policy**, `corpus/ris.py` § chunking, stratum labels, scope fan-out | Stale-copy TTL re-validation proven by test (simulated Novelle → re-fetch); results show rank/role labels |
| **4** (~2 wk) ✅ implemented 2026-07-17 | Applicability rules in registry (per the pinned DSL), Python resolver, TS codegen + parity test, new intake triggers, compliance Stage 1 integration, UI parity | Overview UI and backend prompts produce identical verdicts on fixture profiles |
| **5** (~1 wk) ✅ implemented 2026-07-17 | NormReference trust-chain fields + resolver, registry-validated citation verification | Cards carry stamped `norm_id/rank/binding`; invalid document/edition citations flagged |

Phases are separately mergeable PRs against `develop`, each with its docs updates (see §10).

## 9. Testing

- **Python (pytest):** registry schema + loader + id-convention validation + shim; CountryPack
  contract (AT pack vocabulary parity with the legacy maps, pack-validated loading: unknown
  country / unknown state token rejected in strict mode, dropped fail-open at runtime, doctrine
  lines rendered from the pack); `corpus/at.py`
  parser against real OIB PDF fixtures (golden `Punkt` splits); filters→`where` translation incl.
  jurisdiction-aware edition selection; parent expansion; applicability resolver (DSL semantics:
  first-match, defined/undefined); **ris_knowledge TTL re-validation** (stale copy + moved
  last-changed → re-fetch; unchanged → refresh); citation-verification registry pass;
  NormReference resolver.
- **Frontend:** applicability parity test (TS codegen output vs Python resolver on shared
  fixtures); typecheck via `Dockerfile.typecheck` (host npm is unreliable on this repo).
- **Evals:** existing `oib_compliance` golden dataset unchanged; add cases for edition discipline
  and guidance-vs-requirement once Phase 5 lands.
- **Verification workflow per AGENTS.md:** ruff + `ruff format --check`, `py_compile`,
  `pytest tests/`, Docker frontend typecheck.

## 10. Documentation obligations (same change, not follow-up)

- **ADR-0025** (norm registry + structured RAG decision), copied from `0000-template.md`.
- `docs/architecture/backend-deep-dive.md`: rewrite §6b (curated RIS index → norm registry),
  update §6 (chunk metadata, filters, ris_knowledge), §8c (compliance scope source).
- `docs/deployment/environment-variables.md` + `AGENTS.md` env table: `GRID_NORMS_DIR`,
  `GRID_RIS_CACHE_TTL_DAYS`, deprecated `RIS_CATALOG_PATH`.
- `docs/api/*` if the `knowledge_search` tool contract changes (filters arg).
- README/AGENTS quick-start only if the ingest command surface changes (it should not).

## 11. Failure modes and fallbacks

- Registry file missing/invalid → loader fails open to today's flat behavior with a warning
  (same semantics as `load_catalog` today); id-convention violations fail LOUD (config bug, not
  runtime data).
- Punkt parser fails on a PDF → page-based fallback chunking, doc-level metadata, logged warning.
- RIS re-verification fails in build script → fail-loud `SystemExit` (unchanged).
- ris_knowledge staleness → bounded by the §4.4 TTL re-validation; RIS metadata check failing
  → serve cached copy with a staleness warning in the source label, never silently.
- NormReference alias match fails → fields omitted, card renders as today.
