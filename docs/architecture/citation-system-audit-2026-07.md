# Citation pipeline — as built (2026-07)

What the citation pipeline looks like after the 2026-07 audit and the follow-up
**two-level rebuild**, what was deliberately left alone, and what is still open.
The findings that produced these changes are not reproduced here — the code and
its tests are the record, and `git log --grep=citation` has the reasoning.

**Related:** ADR-0026 (unified source-kind model), ADR-0025 (norm registry),
ADR-0024 (org Archiv), ADR-0012 (cards).

---

## The model: a citation has two levels

A citation is not one thing. It is a **document** (which source) and a **locus**
inside it (which page/passage):

```text
CitedDocument            ← WHAT   (collection, file_name) | url | canonical OIB key
  └─ loci[]              ← WHERE  page, its [N], its passage, cited-or-only-read
```

The backend has always been shaped this way — `SourceRegistry` keys entries on
`(collection, filename, page)`, which is exactly (document, locus). It was only
ever *flattened* for the wire, and each consumer then silently picked a level:

| surface | grouped at | consequence |
|---|---|---|
| "Belegt durch" chips | document, then matched 1:1 against a locus-level list | one document cited at 4 pages → 1 good chip + 3 degraded (raw filename, no badge, wrong tint) |
| Herleitung fan-out | document, from a **different input** (`## Trace-Lanes`) | could show what was searched, never which document became `[3]` |
| report bibliography | locus, re-parsed out of prose | third parser, third identity |

`frontends/ui/src/features/chat/lib/citations/` is the one model all three now
project from. Nothing downstream classifies, labels or deduplicates a source
again — **if a surface needs a fact, it goes on the model, not into a new
parser.** That rule is the whole difference from what it replaced.

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

REGISTRY         SourceRegistry — dedup on normalized URL | (collection, filename, page)
                 session ContextVar + LRU(1000) + Dragonfly persist (ADR-0020)
                 document_key(entry) — the same identity MINUS the page

VERIFY           verify_citations       identity only; removes, never repairs
                 verify_quoted_spans    fuzzy; annotates inline, never strips
                 sanitize_report        URL + whitespace hygiene, renumber (returns renumber_map)

CLASSIFY         lane_for_hit (doc_class ▸ collection ▸ filename ▸ url)
                 → kind_for_lane → baurecht | buero | projekt | web

WIRE             source_entry_to_wire — THE contract. Every transport uses it.
                 {number, document_id, content, title, citation_key, collection,
                  source_type, tool, url, origin, kind, lane, lane_label,
                  binding_note, file_name, page}
                 One wire source = ONE LOCUS. `document_id` is the grouping key.

TRANSPORT        WS `sources` · SSE citation_source + citation_use · ## Trace-Lanes
                 (written ## Quellen markdown is a DATA CHANNEL — lifted out of the
                  answer before display, never rendered)

FE MODEL         lib/citations — buildCitationModel(inputs) → CitedDocument[]
                 producers, richest first: wire → written entries → trace lanes → cards
                 CitationAccumulator merges on identity; every later producer can
                 only ADD facts (isCited is sticky, a number never un-sets)

FE PROJECTIONS   answerDocuments()   → chips        (document level, one per source)
                 bibliographyRows()  → report list  (locus level, one per [N])
                 unusedDocuments()   → "gelesen, nicht verwendet"
                 resolveCitationTarget(doc, {locus}) → url | ris | document@page | download | info

FE RENDER        SourcePreviewChip (variant: chip | card; detail: full | name-only)
                 AnswerSourcesRow · SourceCard (Herleitung) · ReportTab · CitationCard

PERSIST          lib/citations/persistence — versioned envelope {v: 1, sources: [...]}
                 written to messages.metadata.citations, read by server-message-mapper

TELEMETRY        citation_events → POST /api/internal/citation-events
                 → platform Citation health dashboard + JSON export
```

## Identity

Most specific first (`documentIdentity`):

1. the backend's **`document_id`** — computed by `citation_verification.document_key`
   from the same `(collection, filename)` the registry groups on, so the two ends
   no longer derive identity independently;
2. `(collection, fileName)` — the true primary key, and the only pair that is
   unique: one search fans out across the base corpus, the session collection and
   the project collections at once;
3. bare `fileName` (matched permissively against a collection-bearing key);
4. normalized URL;
5. the **canonical OIB key** (`oibDocumentKey`), for an observation that has
   nothing but a law name — which is what a `legal_basis` card is;
6. the label — and an observation with **none of these identifies nothing** and is
   dropped rather than rendered as a nameless card.

The OIB key used to sit at the TOP of that list, and that was wrong: it is
derived from a law name, so it is the same key for every edition and every
revision of one Richtlinie, and putting it first collapsed two corpus documents
that the wire had already told apart by `document_id`. It is a last resort for
the one producer that has no better identity to offer. Collapsing a card onto
the retrieved document is then a MERGE (`findOibCounterpart`), not a shared
identity: exactly one side must be the label-only card, neither may sit on a
shelf other than the base corpus, and the FILE side has to be an OIB corpus
document rather than a document that merely mentions one. That last rule is the
residue test in `oibCorpusKey`, and it is what the shelf rule cannot do:
„OIB-Richtlinie 6 Kommentar.pdf" is somebody's commentary, and a source known
only from the answer's written list carries no shelf to judge it by.

On the backend side of step 1, `citation_verification.document_key` has the same
"identifies nothing" case: a source with no collection, filename, URL *or* label.
It answers with a deterministic `anon:<fingerprint>` derived from the source's own
content rather than a bare `label:` sentinel, so two unrelated anonymous sources
are no longer merged into one document by virtue of both being nameless.

A **label-only** identity also matches a document with that title in either
direction: `## Trace-Lanes` knows a RIS norm only as "Bauordnung für Wien" while
the answer's citation of it arrives with a real RIS URL. Same document, two
identities — it used to render twice, once cited and once "read, not used".

## Resolving a locus to a passage

The wire stops at the PAGE. `SourceRegistry` keys on `(collection, filename,
page)` and carries the retrieved passage as an opaque snippet string — there is
no bounding box, no character offset, and no plan to add one: geometry would
have to be produced at ingest, stored per chunk, and kept in step with a
re-ingest, and it would still only cover documents this pipeline ingested.

The viewer resolves the last step CLIENT-SIDE instead, at open time:

```text
locus.page      → open the document there
locus.snippet   → match against pdf.js's text layer for that page
                  → rectangles → scroll to them, pulse, leave a mark
```

`features/knowledge/lib/passage-highlight.ts` does the matching and
`pdf-text-chunks.ts` the PDF→CSS geometry; both are pure and unit-tested, so
neither needs a PDF to exercise. The two extractors involved — whatever ingested
the document, and pdf.js — disagree about hyphenation, ligatures, punctuation
and whitespace, so the matcher normalises both sides to letters, digits and
single spaces and then tries exact, end-anchored, and stemmed word-overlap
matching in that order.

Two properties are load-bearing and are what the tests pin:

- **Ambiguity withdraws the answer.** An anchor phrase that occurs twice on the
  page, or two windows that score alike and lie apart, produce NO mark. A page
  that says nearly the same thing twice is common in legal text; marking the
  earlier occurrence would point the reader at the wrong clause with exactly the
  confidence of a real hit.
- **No match is a supported outcome, not an error.** A scanned page has no text
  layer at all. The viewer then behaves exactly as it did before the highlight
  existed — open at the page, no mark, no error surface.

This is also why the viewer renders the PDF itself rather than framing the
browser's. `#page=N` was the entire vocabulary an `<iframe>` offered; a text
layer is not reachable through it at any price.

### The passage has to survive storage (2026-09-04)

`locus.snippet` reaching a live tab is only half of it. Two normalizers stand
between the wire and what a reload reads back, and both ENUMERATE the fields
they keep:

- `lib/conversations/agent-answer-metadata.ts` — every row the PYTHON side
  persists: deep research, and any answer whose socket was gone mid-turn;
- `features/chat/lib/prune-message-for-storage.ts` — the localStorage copy.

A field listed in neither is dropped in silence, on exactly the turns a reader
comes back to, and nothing on screen says so: a citation with no passage opens
the page and marks nothing, which is a supported outcome (above). Both were
missing `snippet`, `punkt` and `score`.

Their BOUNDS matter as much as their presence. The matchers anchor on both ends
of a snippet, so clipping one to a locator-sized 300 characters quietly demotes
"the sentence is marked" to "the page is open". The cap is 1200 on both sides
and on the producer (`_WIRE_SNIPPET_MAX_CHARS`), which is where it belongs — a
bound the wire does not enforce is one every consumer has to remember.

### Which locus a click opens at (2026-09-04)

`openAt` prefers a locus that names a PAGE over one that does not, even when the
page-less one is the locus the reader clicked. A document routinely carries
both: the retrieval payload states the page it read, and the answer's written
`## Quellen` list states the same `[N]` and frequently names no page. Both
become loci of one document, and the `[N]`→locus binding used to keep whichever
came last in locus order — the page-less one. Clicking a citation that knew it
was page 18 opened the viewer at page 1 (#621).

The rule is stated twice on purpose, at both places the loss could happen:
`referencesByNumber` (`lib/citations/views.ts`) prefers a located locus when two
carry the same `[N]`, and `openAt` (`lib/citations/target.ts`) falls back to a
located locus on the same document when the binding is honestly page-less. Only
a document read nowhere in particular still opens at its start.

### Sources with no PDF to open

Two target kinds exist beside `document`, and both replace an `info` popover
that said nothing:

- **`download`** — a stored document the reader may have and this app cannot
  draw (a `.docx`, a `.xlsx`, a `.dwg`). It used to resolve to `info`, which
  offered no way in and gave no reason, and readers concluded the product had
  lost their file (#623). The popover now says which format cannot be shown and
  hands over `/api/documents/{id}/download`.
- **`ris`** — an Austrian RIS document, read INSIDE the product
  (`RisDocumentDialog`) rather than opened in a browser tab (#622). No PDF and
  no geometry: the text comes from `/api/ris/document` (the agent's own
  `RisClient`, so it is the text the answer was grounded on) and
  `locatePassageInText` marks the cited passage using the same normalisation the
  PDF matcher uses — which is why it lives in `passage-highlight.ts` rather than
  beside the reader. Only the two confident matcher tiers apply: over a legal
  quotation, a confidently wrong mark is worse than none. The authoritative RIS
  link stays in the header; this is a reading copy.

## Contract tests

`tests/aiq_agent/common/test_citation_pipeline_contract.py` drives the **real**
producer into the **real** parser, and the golden path from tool output to wire
payload (including `document_id`).
`frontends/ui/src/features/chat/lib/citation-wire-contract.spec.ts` pins the
Python→TypeScript seam against shared fixtures in
`tests/fixtures/citation_pipeline/`.
`lib/citations/*.spec.ts` pin the model itself — each case named after the defect
it removes.

Every bug both audits found lived at a seam, not inside a unit. Keep these tests
when the format changes; they are the cheapest part of that change.

## Deliberately not done

- **No normalized `message_citations` table.** Citations persist as a *versioned,
  schema-validated* payload on the message. The wire is stored, not the derived
  model — the model is a pure function of the wire, so freezing it would mean an
  improved grouping/title/tint never reaches history. A table buys queryability
  ("which norms does this project rely on"), not correctness; it is a follow-up,
  and the typed schema is what it would be derived from.
- **The report's written `## Quellen` keeps its bibliography layout.** A report
  should render a numbered list, not chips. What had to match was behaviour.
- **`legal_basis` cards carry no structured document identity.** Both producing
  surfaces are LLM-authored, so `file_name` there would be model-asserted. They
  merge onto a real document only via the canonical OIB key, and are the LAST
  producer so a card can never name a document the wire named better.
- **`_append_minimal_citation` writes an English `**References:**` header.** It
  is lifted out of the answer before display and the answer's language is not
  knowable at that point.

## Still open

- **`data_sources` coverage.** A tool in the agent's loaded set but missing from
  `data_sources:` has all its sources dropped at `debug` level — add an evidence
  tool, forget the YAML, citations silently vanish. Wants a startup assertion.
- **Quote attribution.** `verify_quoted_spans` matches against ANY source in the
  registry, so quoting document A while citing document B verifies clean.
  Deliberate per ADR — but it proves the words exist in what we retrieved, not
  in the document the citation names. `valid_citations` already binds each `[N]`
  to an entry, so per-citation matching is bounded work.
- **Negation-blind quote verification** — see
  `quote-verification-calibration-2026-07.md`. Tracked as **T2-CIT1** in
  `backlog.md`.
- **The deep-research path resolves no `[N]` for document citations.**
  `citation_use` carries the full wire but no number, so a deep answer's chips
  show markers only where the written list supplied them. The binding exists in
  `verify_citations`; threading it through the async job is the remaining half.
- **localStorage still stores the client shape**, decoded by the persistence
  module's legacy branch. Harmless (the branch is tested), but it means one
  storage path writes the envelope and one does not.
- `/api/archiv/documents` is fetched on every preview-index load even when the
  org-archiv flag is off (403, degrades cleanly), and `listArchiv` is unpaginated.
- **The passage highlight has no telemetry.** How often the matcher finds
  nothing, and on which documents, is exactly the signal that would say whether
  the thresholds are set right — and nothing currently records it. The matcher
  already returns its tier (`exact` / `anchored` / `windowed`), so the field to
  report is there.

## Corrections to the original audit

Kept because the reasoning is worth more than the conclusions were:

- **"No abstract `Citation` class" was right about inheritance and wrong about
  the model.** The backend model was singular, so an inheritance layer would have
  added a level without removing one — but the missing abstraction was never a
  base class. It was the DOCUMENT/LOCUS distinction, which no layer named, so
  every surface picked one and assumed the other agreed.
- **The page problem was overstated.** The wire always carried a *retrieved*
  page. The real defect was `entry_for_citation_key` returning the first
  filename match, so a citation to p.30 opened the PDF at p.12.
- **The lenient-matcher concern was the wrong failure mode.** Prose lines
  validating as citations was not real. Probing instead found that two common
  citation formats were being silently *dropped*.
- **`resolveCorpusFileName` is not a classifier.** It decides no taxonomy — it
  is a fail-safe resolver mapping a label to a filename.
- **Block-scoped parsing was not sufficient on its own.** A block holds the
  header *and* the passage, so retrieved text could supply a header field the
  producer omitted.
- **"Legacy persisted messages keep the pre-ADR-0026 tint" is resolved.** The
  `LEGACY_KIND_TO_SIGNAL` table is gone: `resolveKind` falls back through
  lane → origin → URL, and a document whose identity resolves to the canonical
  OIB key infers the OIB lane, so a source known only from the answer's written
  list renders identically to the same source with a full structured wire. (The
  lane is inferred from the document's NAME rather than from its identity — see
  the note under *Identity* on why the OIB key stopped being one.)
