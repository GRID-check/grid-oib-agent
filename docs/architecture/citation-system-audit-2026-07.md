# Citation pipeline — as built (2026-07)

What the citation pipeline looks like after the 2026-07 audit, what was
deliberately left alone, and what is still open. The findings that produced
these changes are not reproduced here — the code and its tests are the record,
and `git log --grep=citation` has the reasoning.

**Related:** ADR-0026 (unified source-kind model), ADR-0025 (norm registry),
ADR-0024 (org Archiv), ADR-0012 (cards).

---

## Pipeline

```text
INGEST           oib_sync.py (base corpus) · project/archiv uploads → Chroma
                 document_metadata_store: display_title + doc_class (admin-editable)

RETRIEVAL        sources/knowledge_layer/src/register.py::_format_results
                 --- Result N ---
                 Source: / Collection: / Dokumentart: / Page: / Citation: / Relevance Score:
                 <passage body>                     ← header fields are read ONLY above this
                 ## Trace-Lanes {json: key, label, kind, hitCount, sources}

CAPTURE          extract_sources_from_tool_result → SourceEntry
                 parsers: knowledge-layer (per result block) | generic URL | tool-name fallback
                 gate (shallow): loaded tools ∩ data_sources registry

REGISTRY         SourceRegistry — dedup on normalized URL | (filename, page)
                 session ContextVar + LRU(1000) + Dragonfly persist (ADR-0020)
                 per-turn capture log for telemetry (the registry itself is cumulative)

VERIFY           verify_citations       identity only; removes, never repairs
                 verify_quoted_spans    fuzzy; annotates inline, never strips
                 sanitize_report        URL + whitespace hygiene, renumber (returns renumber_map)

CLASSIFY         lane_for_hit (doc_class ▸ collection ▸ filename ▸ url)
                 → kind_for_lane → baurecht | buero | projekt | web

WIRE             source_entry_to_wire — THE contract. Every transport uses it.
                 {number, content, title, citation_key, collection, source_type,
                  tool, url, origin, kind, lane, lane_label, binding_note,
                  file_name, page}

TRANSPORT        WS `sources` · SSE citation_source + citation_use · ## Trace-Lanes
                 (written ## Quellen markdown is display only, not a data channel)

FE NORMALIZE     citationFromWire — THE normalizer. Every transport uses it.
                 report-citations.ts parses the written list for its [N] anchors.

FE RENDER        SourcePreviewChip (variant: chip | card) — one behaviour, two shapes
                 ReportSourcesList (bibliography) · SourceCard (Herleitung) · LegalBasisCard

TELEMETRY        citation_events → POST /api/internal/citation-events
                 → platform Citation health dashboard + JSON export
```

## Contract tests

`tests/aiq_agent/common/test_citation_pipeline_contract.py` drives the **real**
producer into the **real** parser, and the golden path from tool output to wire
payload. `frontends/ui/src/features/chat/lib/citation-wire-contract.spec.ts`
pins the Python→TypeScript seam against shared fixtures in
`tests/fixtures/citation_pipeline/`.

Every bug this audit found lived at a seam, not inside a unit — including one
that survived the first fix and was caught only by driving the two real
components into each other. Keep these tests when the format changes; they are
the cheapest part of that change.

## Deliberately not done

- **No abstract `Citation` class.** The backend model was already singular
  (`SourceEntry` / `SourceRegistry` / `source_entry_to_wire`); an inheritance
  layer would add a level without removing one.
- **The report's written `## Quellen` keeps its bibliography layout.** A report
  should render a numbered list, not chips. What had to match was behaviour.
- **`legal_basis` cards carry no structured document identity.** Both producing
  surfaces are LLM-authored, so `file_name` there would be model-asserted, and
  `resolveCorpusFileName` also backs `NormRefFooter` for ~20 schematic card
  types. Threading it is a card-contract redesign, and it only becomes right
  when a deterministic producer exists (as `surface_documents` already is).
- **`_append_minimal_citation` writes an English `**References:**` header.** It
  is lifted out of the answer before display and the answer's language is not
  knowable at that point.

## Still open

- **`data_sources` coverage.** A tool in the agent's loaded set but missing from
  `data_sources:` has all its sources dropped at `debug` level — add an evidence
  tool, forget the YAML, citations silently vanish. Wants a startup assertion.
- **Legacy persisted messages.** `LEGACY_KIND_TO_SIGNAL.kb = 'project'` keeps the
  pre-ADR-0026 tint for messages stored before the wire carried `kind`. Correct
  as back-compat; there is no migration and no marker.
- **Quote attribution.** `verify_quoted_spans` matches against ANY source in the
  registry, so quoting document A while citing document B verifies clean.
  Deliberate per ADR — but it proves the words exist in what we retrieved, not
  in the document the citation names. `valid_citations` already binds each `[N]`
  to an entry, so per-citation matching is bounded work.
- **Negation-blind quote verification** — see
  `quote-verification-calibration-2026-07.md`. Tracked as **T2-CIT1** in
  `backlog.md`.
- **Unverified severity claim.** The dropped-citation fix was the largest of
  these by mechanism; its real-world size is unmeasured. The
  `citation_key_not_in_registry` share of `citations_removed` on the platform
  dashboard settles it after rollout.
- `/api/archiv/documents` is fetched on every preview-index load even when the
  org-archiv flag is off (403, degrades cleanly), and `listArchiv` is unpaginated.

## Corrections to the original audit

Kept because the reasoning is worth more than the conclusions were:

- **The page problem was overstated.** The wire always carried a *retrieved*
  page. The real defect was `entry_for_citation_key` returning the first
  filename match, so a citation to p.30 opened the PDF at p.12.
- **The lenient-matcher concern was the wrong failure mode.** Prose lines
  validating as citations was not real. Probing instead found that two common
  citation formats were being silently *dropped*.
- **`resolveCorpusFileName` is not a classifier.** It decides no taxonomy — it
  is a fail-safe resolver mapping a label to a filename. The original count of
  frontend classifiers was one too high.
- **Block-scoped parsing was not sufficient on its own.** A block holds the
  header *and* the passage, so retrieved text could supply a header field the
  producer omitted.
