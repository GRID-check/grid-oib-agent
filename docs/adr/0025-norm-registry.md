# ADR-0025: Norm catalog — flat curated pointers + prose legal notes, admin-managed

- **Status:** Accepted (v2 — supersedes the v1 "typed legal-document spine" draft of this ADR, reduced after adversarial review; see Context)
- **Date:** 2026-07-18
- **Deciders:** Grid engineering
- **Related:** ADR-0006 (knowledge collection scoping), ADR-0016 (platform owner tier), ADR-0024 (org Archiv), `docs/superpowers/specs/2026-07-17-norm-registry-design.md` (superseded design, kept for history), `configs/norms/`

## Context

The agent needs three kinds of legal knowledge the RAG pipeline cannot supply
by itself:

1. **Where each law lives** — verified RIS pointers (application, document
   number, URLs), so statutes are fetched deterministically instead of via
   blind full-text search.
2. **Legal facts that are in no retrievable document's text** — most
   importantly the binding chain: the Wiener Bautechnikverordnung (WBTV) is
   what makes the OIB-Richtlinien binding in Vienna, with deviations; the
   Kleingartengesetz displaces the BauO in Kleingartengebieten (lex specialis).
3. **Reasoning doctrine** — authority order ≠ retrieval order; requirements
   only from normative documents; ÖNORM texts are unavailable; parcel
   questions need the parcel documents; Bestand may enjoy Übergangsrecht.

The v1 draft of this ADR answered all three with one typed data model: a
per-country registry with ranks, roles, nested editions, a typed relation
graph (`implements`/`declares_binding`/`supersedes`), a data-driven
applicability DSL with TS codegen + parity fixtures, structure-aware Punkt
chunking, and a persistent RIS text cache. The implementation (PR #79) was
adversarially reviewed with these outcomes:

- the typed relation graph **computed nothing that reached the LLM** (its two
  consumers were dead or wrong in production);
- the norm resolver stamped **wrong norm ids** on cards ("OIB-Richtlinie 2" →
  `oib-rl-2.3`);
- the Punkt chunker **shredded real OIB text** (fire-resistance table rows
  became headings; citations like "Pkt 90" were fabricated);
- the applicability codegen **broke the production build** and existed only to
  keep two rule engines identical;
- the RIS cache's freshness re-validation was **structurally inert**;
- the country-pack plugin protocol served exactly one country.

The pattern: the machinery re-modeled knowledge that already lives in the
corpus text, the filenames, or the prompt — and the bugs lived precisely in
that redundant machinery. Reviewed against "the best part is no part", most of
it is deleted rather than fixed.

## Decision

**The registry is a flat curated catalog of pointer entries plus prose legal
notes, stored behind an admin surface; hierarchy is expressed as data-derived
labels, not as a typed graph.**

1. **Flat catalog** (`src/aiq_agent/common/norm_registry.py`,
   `configs/norms/at/registry.yml`): one entry per norm — id, title, short,
   `rank` (bundesgesetz | landesgesetz | verordnung), `bundesland` (canonical
   name, empty = federal), topics, RIS pointer fields, aliases, and two prose
   fields: `binding_note` (a curated legal fact rendered into researcher
   prompts — this is how the WBTV→OIB chain reaches the model) and
   `review_note` (an open verification TODO surfaced only in the admin UI,
   never asserted as fact). Each entry may carry a `verify` seed
   (title query + disambiguation guards) consumed by the live RIS
   verification (build script and admin verify endpoint) — the former
   separate seeds file is gone.
2. **Doctrine as prompt, once** — the Normenhierarchie doctrine is a single
   constant (`NORM_DOCTRINE`) injected into the shallow researcher, deep
   researcher, planner, and writer templates as `{{ norm_doctrine }}`.
3. **OIB corpus stays out of the registry.** The knowledge base is its source
   of truth; what a corpus document *is* (Richtlinie / Leitfaden / Erläuterung
   / Begriffsbestimmungen / Zitierte Normen / Änderungsdokument) derives from
   the stable filename convention (`oib_doc_class`). The 15 `aenderungen_*`
   diff files and the superseded revision are excluded from retrieval by a
   filename list on the knowledge tool config (`exclude_file_names`) — no
   chunk metadata required.
4. **Hierarchy for display = deterministic tagging** (`lane_for_hit`): a
   retrieval/citation hit maps to a stratum + lane label (Bundesrecht /
   Landesrecht / Verordnung via registry rank; OIB-Richtlinie / -Leitfaden /
   -Erläuterung via filename class; Projektwissen / Büroarchiv / Web via
   collection origin) for the research fan-out UI. The hierarchy of the
   Baurecht-Wien model is preserved in data; no parallel ontology.
5. **Admin-managed storage.** A single-row-per-country JSON store
   (`norm_store.py`, same engine/URL as the summary store) seeds itself from
   the YAML on first boot and registers itself as the runtime registry source;
   the YAML remains the version-controlled seed. Backend CRUD + live-verify
   endpoints under `/v1/admin/norms` (X-Admin-Token, same guard as the OIB
   admin routes); platform-owner-gated UI on `/app/platform` (ADR-0016) with
   lane-grouped listing, entry editor, verify-and-pick against live RIS, and
   the `review_note` TODO queue. Optimistic versioning; every write audited.
6. **Applicability = two small hand-written functions** — one Python
   (compliance scoping + prompt block), one TypeScript (Overview UI chips).
   No DSL, no codegen, no parity fixtures.
7. **Kept from PR #79 besides the above:** the `filters` parameter of
   `knowledge_search` wired to real Chroma `where` clauses; the four boolean
   intake triggers (Kleingarten, Denkmalschutz, Betriebsanlage, Stellplatz);
   the expanded catalog coverage (WBTV, KlGG, DMSG, UVP-G, WRG, ForstG,
   GewO + the previous 15 entries).

## Consequences

- Adding or amending a norm is an admin-UI operation (edit → verify against
  RIS → save), not a two-file YAML edit plus scripts. A Novelle shows up as a
  `review_note` TODO, not silent staleness.
- Multi-country expansion is data: a new `configs/norms/<cc>/registry.yml`
  seed (or admin-created entries) — no plugin protocol, no code fork. What
  remains AT-specific in code is the Bundesland vocabulary and the doctrine
  text; both move to data when country #2 actually ships.
- Punkt-precise citations are not structurally guaranteed; the model reads
  Punkt numbers from chunk text. If evals show a real miss rate, the next
  step is annotating the nearest heading as chunk *metadata* (fail-soft), not
  re-chunking (fail-hard).
- Statute texts are re-fetched per session (no persistent RIS cache) — a cost,
  accepted until a cache with a real freshness contract is designed.
- The registry hot path is unchanged for consumers: `load_registry()` returns
  the same object shape regardless of storage (store-first, YAML fallback,
  fail-open).

## Alternatives considered

- **Typed relation graph, normalized editions, country packs (v1)** — built,
  reviewed, reduced: the graph had no live consumer, and every consumer that
  was supposed to use it worked on prose/prompt/filename information anyway.
  Reintroduce a minimal typed `binding_edition` field only when a consumer
  exists (e.g. machine-checked edition discipline on cards).
- **BFF-owned registry in Postgres/drizzle** — inverts data ownership: the
  Python backend is the hot-path consumer; the BFF would either serve reads
  cross-service or re-export YAML. Rejected.
- **Writable YAML on a volume** — least code but couples edit durability to
  volume configuration in ephemeral deploys; the single-row store reuses the
  already-persistent DB instead.
