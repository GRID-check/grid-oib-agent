# RIS Adapter

NAT data-source package for the **Austrian RIS** (Rechtsinformationssystem des
Bundes) built on the official [OGD-RIS API v2.6](https://data.bka.gv.at/ris/api/v2.6/)
(see the *OGD-RIS API Handbuch V2_6*, July 2025). No API key is required —
OGD-RIS is an open-government-data service.

## Tools

| Tool | `_type` | Purpose |
|------|---------|---------|
| RIS search | `ris_search` | Search federal law (`BrKons`, `BgblAuth`, …), state law (`LrKons`, …), and case law (`Vfgh`, `Vwgh`, `Justiz`, `Bvwg`, `Lvwg`, …). Returns document references with citation URLs. |
| RIS document fetch | `ris_fetch_document` | Fetch an **entire document on demand** — a law paragraph, a complete consolidated law (`GesamteRechtsvorschrift`), or a court decision — and return its full text to the agent. |
| RIS catalog lookup | `ris_catalog_lookup` | Topic search in the **norm registry** — verified pointers plus rank/role/relations for the building-relevant norms, no keyword guessing. |

### Norm registry (deterministic pointers + legal metadata)

Live `ris_search` is keyword-blind: it guesses one of ~40 OGD-RIS application
silos and fires a full-text query. The norm registry (ADR-0025) removes the
guesswork for the core building-law corpus: `configs/norms/<country>/registry.yml`
(env override `GRID_NORMS_DIR`) is the typed spine for every known legal
document — rank, role, editions (corpus file or **verified** RIS pointer:
application, document number, citation URL, entire-consolidated-law URL),
relations, applicability rules. Austria ships 38 entries: the nine state
building codes (Bauordnungen / Baugesetze / Bautechnikgesetze), the Wiener
Garagengesetz, adjacent federal acts (ASchG, AStV, BKAG, ZTG, WGG) — and the
full OIB corpus (Richtlinien, Leitfäden, Erläuterungen, Referenzdokumente with
their editions and roles). It is a **pointer index only** for RIS documents:
full texts are still fetched live with `ris_fetch_document`. The legacy flat
`configs/ris_catalog.yml` is retired; the `ris_catalog` module remains as a
backward-compatible shim (`RIS_CATALOG_PATH` still honored with a deprecation
warning).

Three consumers, all fail-open (missing/invalid catalog → today's live-search
behavior with a warning):

1. **`ris_search` short-circuit** (`catalog_shortcut: true` by default): when
   the query matches a catalog entry and no title/date argument is set and the
   query has no case-law signal (VwGH, Erkenntnis, …), the tool returns the
   verified pointers directly — no HTTP call, no planner LLM.
2. **`ris_catalog_lookup`**: explicit topic search in the catalog for the agent.
3. **Prompt block**: `aiq_agent.common.norm_registry.render_block_for_prompt`
   renders the norm registry — lane-grouped by rank (Bundesrecht → Landesrecht,
   project state first → OIB-Richtlinien with role/edition annotations →
   Referenz → externe Normen) — into the shallow/deep researcher prompts.

**Jurisdiction-aware matching.** Building law is state law, and the nine state
codes all match generic topics like "bauordnung", so both tool consumers
resolve the Bundesland before truncating results (`focus_entries`): the
explicit `bundesland` argument (`ris_search`) or the state named in the topic
(`ris_catalog_lookup`) drops the OTHER states' law and sorts the project's own
state first; federal law always stays. The Bundesland itself comes from the
structured `bundesland=<token>` fact the project-intake wizard writes into the
project context (authoritative), falling back to state-name probing in free
text. A project explicitly outside Austria (`ausserhalb_oesterreichs`) gets no
state prioritization. An explicit non-default `application` argument narrows
the short-circuit's pointers to that application.

The registry (`configs/norms/<country>/registry.yml`, ADR-0025) is curated by
hand; the RIS pointers inside it are re-verified against the live API and merged
back (never clobbering curated fields; fails loudly on unverifiable seeds). New
seeds go into `configs/norms/<country>/seeds_ris.yml`:

```bash
uv run --no-project --with httpx --with pydantic --with beautifulsoup4 \
    --with pyyaml --with ruamel.yaml python scripts/build_ris_catalog.py
```

### On-demand documents as knowledge sources

`ris_fetch_document` does three things with a fetched document:

1. Serves it from the **persistent norm cache** when possible (ADR-0025 Phase
   3, `persistent_cache: true` by default): fetched full texts are kept on disk
   (`cache_dir`, default `data/ris_cache`) keyed by RIS document number with a
   content hash and parsed Fassung date. Fresh entries
   (`GRID_RIS_CACHE_TTL_DAYS`, default 7 days) skip the HTTP call entirely;
   stale entries are re-validated cheaply (first ~4 KB, `Stand:`/`Fassung vom`
   date) and only re-fetched when a Novelle actually changed the Fassung —
   network failure during re-validation serves the stale copy rather than
   failing the tool. Documents whose number cannot be resolved fall back to the
   legacy behavior below.
2. Returns the full text (truncated at `max_chars` for the agent's context) with
   a `Source:` line carrying the canonical `ris.bka.gv.at` URL. The citation
   verification layer picks that URL up automatically, so answers grounded in
   the document are citable.
3. Ingests the **complete** text into the persistent `ris_knowledge` knowledge
   collection (best-effort, `ingest_into_knowledge: true` by default), chunked
   on `§` boundaries with norm-registry metadata. The session collection only
   receives a small `RIS_POINTER_<docnr>.txt` pointer; without the cache the
   full text goes to the per-session collection as before. From then on
   `knowledge_search` retrieves and cites specific sections of the document —
   the document has become a regular knowledge-layer source.

### Query planning with structured outputs

`ris_search` optionally refines the agent's query through a small planner LLM
before hitting the API. The planner call uses **strict structured outputs**
(`response_format: {type: json_schema, strict: true}`, the
[OpenRouter structured-outputs](https://openrouter.ai/docs/guides/features/structured-outputs)
wire format, sent via LangChain's `with_structured_output(..., method="json_schema",
strict=True)`), so the resulting plan is always schema-valid: the application and
Bundesland are enum-constrained and cannot be hallucinated. The planner corrects
the most common failure mode — searching federal law for state-law topics
(Bauordnungen!) — and rewrites colloquial phrasing into statutory German
terminology. Any planner failure falls back to the caller's raw arguments; the
search never blocks on the planner.

Platform integration: per call, the planner model passes through
`apply_model_override(..., AgentGroup.DEEP_RESEARCH_ROUTER)` and
`apply_org_credential(...)` — the same policy wrappers other auxiliary LLM calls
use — so per-org runtime model overrides (ADR-0014) and BYOK credentials
(ADR-0022) apply consistently. Outside the Grid agent the wrappers degrade to
no-ops.

## Configuration

```yaml
functions:
  ris_search_tool:
    _type: ris_search
    page_size: 20        # 10 | 20 | 50 | 100
    max_results: 10      # results formatted per call
    planner_llm: deep_router_llm  # optional: LLM ref for structured-output query planning
    catalog_shortcut: true        # return curated-catalog pointers on a match (no live search)

  ris_fetch_tool:
    _type: ris_fetch_document
    max_chars: 40000     # characters returned to the agent
    ingest_into_knowledge: true

  ris_catalog_lookup_tool:
    _type: ris_catalog_lookup
    max_matches: 5

  data_sources:
    _type: data_source_registry
    sources:
      - id: ris
        name: "RIS – Österreichisches Recht"
        description: "Search Austrian federal/state law and case law in the official RIS and fetch entire documents on demand."
        tools:
          - ris_search_tool
          - ris_fetch_tool
          - ris_catalog_lookup_tool
```

## Notes

- Document payloads are fetched from the RIS citizen application
  (`www.ris.bka.gv.at`); only RIS hosts are allowed, HTML/XML variants are
  converted to plain text, and binary-only variants (PDF/RTF) are rejected
  with a pointer to the HTML URL.
- Search responses are XML-derived JSON with dict-or-list ambiguity; parsing
  is shape-tolerant (`OgdSearchResult/OgdDocumentResults/OgdDocumentReference`).
- API errors (`OgdSearchResult.Error`) are surfaced verbatim to the agent so it
  can correct its query (e.g. wildcard rules, invalid page numbers).
- Fetched documents are cached in memory (1 h TTL) to avoid refetching within
  a research run; HTTP requests reuse one connection pool and retry transient
  failures (5xx/transport) with exponential backoff. Structured OGD-RIS
  validation errors are never retried — they are surfaced to the agent so it
  can correct the query.
- Citation hygiene: fetched consolidated texts (BrKons/LrKons) carry an explicit
  konsolidierte-Fassung note (legally non-binding; the authentic text is the
  BGBl/LGBl promulgation) and a retrieval date, so reports can cite precisely.
- The `ris` data source is toggleable per conversation in the UI out of the box:
  it is served by `GET /v1/data_sources`, rendered in the data-sources panel,
  and filtered per request via the standard `data_sources` field.
