# ADR-0025: Norm registry (Normenregister) as the typed legal-document spine

- **Status:** Proposed
- **Date:** 2026-07-17
- **Deciders:** Grid engineering
- **Related:** ADR-0006 (knowledge collection scoping), `docs/superpowers/specs/2026-07-17-norm-registry-design.md`, `docs/architecture/backend-deep-dive.md` §6b, `configs/norms/`

## Context

The Baurecht agent reasons over two untyped knowledge sources:

1. **The curated RIS catalog** (`configs/ris_catalog.yml`) — 15 flat entries
   (state building codes, five federal acts) with live-verified RIS pointers
   (`application`, `document_number`, URLs). It had no notion of legal rank
   (Bundesgesetz vs. Landesgesetz vs. Verordnung), document role (normative
   requirements vs. explanatory guidance vs. change sets), editions, or
   relations between documents (a state building code *implements* EU law; a
   state law *declares binding* a specific OIB-Richtlinie edition).
2. **The OIB corpus** (`data/oib/*.pdf` → `oib_knowledge`) — 39 PDFs ingested
   flat, keyed by filename, with no distinction between the 9 normative
   Richtlinien, their Leitfäden (application guidance), Erläuterungen
   (rationale), Begriffsbestimmungen (definitions), the 15 `aenderungen_*`
   change documents, and de-facto superseded revisions.

Consequences we observed: the doctrine "requirements only from normative
documents; a Leitfaden never creates a new requirement; cite the *declared*
edition, not the newest" existed only as prose in prompts; change documents
and superseded revisions competed with current law in retrieval; the
`ris_catalog_lookup` tool could not tell the LLM that the WBTV declares a
specific OIB-RL edition binding; and adding a second country (Germany) would
have meant either a second hardcoded catalog or a forked backend.

## Decision

We will make a **per-country norm registry** the single typed spine for every
legal document the system knows about, replacing the flat RIS catalog.

- **Storage.** Hand-curated YAML at `configs/norms/<country>/registry.yml`
  (ISO 3166-1 alpha-2 folder per country; `at` ships first). Every entry
  carries `id`, `rank` (bundesgesetz | landesgesetz | verordnung |
  oib_richtlinie | oib_leitfaden | oib_erklaerung | oib_referenz |
  behoerdliche_info | norm_extern | plan_parzelle), `role` (normativ |
  anwendend | erklaerend | definierend | diff), `jurisdiction`,
  `editions[]` (each with `status: current | superseded` and a `source` of
  `kind: corpus` (file in `data/oib`) or `kind: ris` (live pointer)),
  optional `relations[]` (only `implements`, `declares_binding`,
  `supersedes` — each has a concrete consumer; unverifiable legal facts are
  recorded as `status: unknown`, never guessed), and optional
  `applicability[]` rules (pinned DSL: eq/in/defined/undefined/gt/gte/lt/lte
  over project-profile facts, all/any groups, first-match-wins,
  `reason_de` + `reason_en` mandatory).
- **Loading.** `aiq_agent.common.norm_registry` globs
  `configs/norms/*/registry.yml` (env override `GRID_NORMS_DIR`), merges all
  countries, validates fail-loud in strict mode (id convention: family ids
  like `oib-rl-2-leitfaden` require the base entry `oib-rl-2`) and fail-open
  at runtime (invalid registry ⇒ registry features disabled, live RIS search
  unaffected). Country is mandatory on every entry; the pipeline itself stays
  country-agnostic so Germany later means `configs/norms/de/` plus a corpus
  adapter — zero backend changes.
- **Country packs.** Per-country variance sits behind one explicit contract:
  `aiq_agent.common.country_packs` (`CountryPack` protocol + `at.py` +
  registry). A pack owns the intake state-token vocabulary, jurisdiction
  resolution (structured envelope fact first), the doctrine header of the
  lane-rendered prompt block, and country-specific id-convention checks
  (`validate_ids`); Phase 2 adds the corpus-grammar hook to the same contract.
  The loader validates every entry against the pack for its
  `jurisdiction.country`: unknown country or unknown state token drops the
  entry at runtime and raises in strict mode. Adding a country = implement
  the pack + add the folder; that contract is what "done" means.
- **Migration.** `configs/ris_catalog.yml` is retired. Its 15 entries moved
  into `configs/norms/at/registry.yml` with RIS pointers nested under
  `editions[].source`. `aiq_agent.common.ris_catalog` remains as a
  backward-compatible shim (same public API; explicit legacy file paths and
  `RIS_CATALOG_PATH` still work with a `DeprecationWarning`).
- **Build script.** `scripts/build_ris_catalog.py` keeps its live OGD-RIS
  verification semantics (§ 0 anchor, in-force, unambiguous) but reads seeds
  from `configs/norms/<country>/seeds_ris.yml` and *merges* verified pointers
  into the registry — it never clobbers curated fields. Unknown seed ids
  become skeleton entries (rank inferred from the RIS application) with a
  prominent curation warning.
- **Consumers.** The researcher prompts receive a lane-rendered block grouped
  by rank (Bundesrecht → Landesrecht for the project state first →
  OIB-Richtlinien with role/edition-annotated family members → Referenz →
  externe Normen). `ris_catalog_lookup` annotates each hit with its registry
  relations. Phase 0 additionally shipped: metadata filters wired through to
  the Chroma query (previously accepted but silently ignored), a
  `file_name $nin` exclusion of the 15 `aenderungen_*` diffs and the
  superseded pre-rev.1 reference document on the base corpus, and a static
  doctrine block ("Normenhierarchie & Dokumentrollen") in the researcher,
  writer, and planner prompts until the registry-rendered block supersedes it.

## Consequences

### Positive

- Rank, role, edition, and relations are **data**, not prompt prose — the
  applicability engine, citation verification, and compliance checker can
  consume them deterministically (Phases 2–5 of the spec).
- Country extension is additive data + adapters, no fork.
- Retrieval defaults can exclude diffs and superseded editions structurally.
- The registry is human-auditable YAML with live-verified RIS pointers and
  explicit `unknown` status for unverifiable legal facts.

### Negative

- Two YAML artifacts per country (registry + seeds) to keep in sync; the
  build script's merge mode mitigates drift for RIS pointers only — corpus
  editions are curated by hand.
- The `ris_catalog` shim keeps a legacy API alive; full removal is deferred
  until all consumers migrate.

### Risks

- **Registry rot**: curated fields (relations, editions) can go stale when
  the OIB or a Land publishes new editions. Mitigation: `verified_at` per
  entry, build-script re-verification of RIS pointers, `status: unknown`
  instead of guesses.
- **Schema drift between loader and YAML**: mitigated by fail-loud strict
  loading in tests and in the build script (the shipped registry is
  re-validated on every build run).

## Alternatives Considered

- **Keep the flat catalog, add a parallel OIB map** — rejected: two sources
  of truth for "which documents exist", no place for cross-document
  relations, country extension still forks.
- **Single `configs/norms.yml` instead of folder-per-country** — rejected:
  a country bundles registry + seeds (+ future corpus adapters); the folder
  keeps that unit together and keeps per-country files diff-friendly.
- **Database-backed registry** — rejected for now: the registry is
  deploy-time configuration curated in code review; YAML + git history gives
  us auditability and fail-loud validation without a migration path. A DB
  backend can be added behind the same loader interface if runtime editing
  ever becomes a requirement.

## Open Questions / Follow-ups

- Phase 1b: coverage seeds (WBTV, Wiener Garagenverordnung,
  Kleingartengesetz, remaining Verordnungen/Nebengesetze, federal cluster
  DMSG/UVP-G/WRG/ForstG/GewO §74ff/BauPVO) with live OGD-RIS verification;
  resolve the `declares_binding` unknowns at least for Wien.
- Phases 2–5 per the spec: Punkt-aware chunking + contextual chunk prefixes,
  persistent `ris_knowledge` cache with TTL (`GRID_RIS_CACHE_TTL_DAYS`),
  the shared applicability engine (registry YAML → TS codegen/parity test),
  NormReference trust chain + registry-validated citation verification.
- Remove the `ris_catalog` shim once no consumer imports it.

## References

- `docs/superpowers/specs/2026-07-17-norm-registry-design.md` (full design,
  phases 0–5)
- `src/aiq_agent/common/norm_registry.py`, `configs/norms/at/`
- OGD-RIS API v2.6 (live verification source)
