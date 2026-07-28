# Citation system audit — 2026-07-28

Full-pipeline audit of every citation touch point: ingest → retrieval output →
capture → verification → classification → wire → transport → frontend
normalization → render → click behaviour, plus the citation-health telemetry
that observes it.

**Status:** every finding below has been **fixed** (commits `533458d`,
`31dd36b`, `dd604b7`). The findings are kept as written so the reasoning stays
readable; §6 records what changed, what the audit got wrong, and what was found
only while fixing.

Findings are ordered by severity and each carries a concrete failure scenario
and the file:line it lived at.

**Related:** ADR-0026 (unified source-kind model), ADR-0025 (norm registry),
ADR-0024 (org Archiv), ADR-0012 (cards).

---

## 1. Verdict

The **backend** citation model is close to what a "clean citation interface"
should look like, and it does not need an abstract class — it already has the
equivalent:

- one data model — `SourceEntry` (`citation_verification.py:52`),
- one authority on what is citable — `SourceRegistry` (`:180`),
- one classifier chain — `lane_for_hit` → `kind_for_lane` (ADR-0026),
- one serializer — `source_entry_to_wire` (`:1036`).

The **problem is not a missing abstraction — it is that the abstraction is
bypassed.** `source_entry_to_wire` is the declared contract, but only *one* of
the four transports that carry citations to the browser actually uses it as the
sole channel. The other three ship citations as free text (the written
`## Quellen` section), as a side-channel JSON block (`## Trace-Lanes`), or as
domain cards (`legal_basis`) — and the frontend then rebuilds a source model
from each of them with its own parser and its own fallback heuristics.

Counted concretely:

| Layer | Implementations |
|---|---|
| Backend source model | **1** (`SourceEntry`) |
| Backend → FE transports carrying source identity | **4** (WS `sources`, SSE `citation_source`/`citation_use`, written `## Quellen` markdown, `## Trace-Lanes` JSON) + `legal_basis` cards |
| FE source models | **5** (`CitationSource`, `ReportSourceEntry`, `TraceSourceCard`, `AnswerSourceRef`, `AnswerSourceItem`) |
| FE origin/kind classifiers | **4** (`classifyCitation`, `kindForLane`, `classifySourceSignal`, `resolveCorpusFileName`) |
| FE renderers of a citation | **5** (`SourcePreviewChip`, `ReportSourcesList`, `CitationCard`, `SourceCard`, `LegalBasisCard`) |

So the user-visible symptom the maintainer describes — "citations became very
complex and architecturally unclean", "a citation should behave the same way
everywhere" — is accurate and measurable: **the same OIB document renders and
behaves differently in the chat answer, the report tab, the thinking tab and the
Herleitung fan-out.**

Separately, the audit found **one silent correctness bug** (§2.1) that
mislabels documents in the base case, and **two structural gaps** (§2.2, §2.3)
where a whole class of citation can never be cited or opened.

### On "does the agent verify every cited file actually exists?"

**Yes, transitively, and the design is sound.** A citation key can only survive
`verify_citations` if it matches an entry in the `SourceRegistry`, and registry
entries are only ever created from *actual tool output*
(`extract_sources_from_tool_result`, `citation_verification.py:545`). There is
no path by which a model-invented filename passes verification. The prompt
reinforces this — the knowledge-base inventory is explicitly labelled "index —
NOT sources" (`shallow_researcher/prompts/researcher.j2:206-212`), and the
prompt tells the model that a citation the tools do not back *costs* the answer
its source rather than being repaired (`:130`).

Three qualifications, in descending importance:

1. **The page is not verified** (§2.5). Filenames are checked, page numbers are
   not — but the UI deep-links the PDF viewer to the unverified page.
2. **"Exists" is scoped to the session, not the turn.** The registry persists
   across turns (`get_or_create_session_registry`, `:468`), so a document
   retrieved three turns ago still validates a citation written today without
   any retrieval this turn. Intentional, but "verified" then means "was
   retrieved at some point in this conversation".
3. **Existing in the registry ≠ openable in the UI** (§2.3). A perfectly
   verified Büroarchiv citation still cannot be opened.

---

## 2. Findings

### 2.1 — S1 · Knowledge-layer parser misassigns `Dokumentart` across hits

**Correctness. Silent. Affects the default mixed-corpus case.**

`_parse_knowledge_layer` (`src/aiq_agent/common/citation_verification.py:807`)
extracts four independent `findall` lists and zips them **by list position**:

```python
citations   = _KL_CITATION_RE.findall(content)     # :816
sources     = _KL_SOURCE_RE.findall(content)
collections = _KL_COLLECTION_RE.findall(content)
doc_classes = _KL_DOC_CLASS_RE.findall(content)
...
doc_class_raw = doc_classes[i] if i < len(doc_classes) else None   # :829
```

But the producer emits two of those fields **conditionally**
(`sources/knowledge_layer/src/register.py:676-689`):

```python
if collection: lines.append(f"Collection: {collection}")
...
doc_class = _hit_doc_class(chunk, resolved)
if doc_class:                                  # ← optional
    lines.append(f"Dokumentart: {doc_class} — {label}")
```

`_hit_doc_class` (`register.py:489`) returns `None` whenever neither the summary
store nor the chunk metadata classifies the document — the normal case for
project and Büroarchiv uploads. So the moment a result set mixes an unclassified
hit with a classified one, every subsequent `Dokumentart` shifts up onto the
wrong document.

**Reproduced** (result 1 = project upload, no `Dokumentart`; result 2 = OIB corpus):

```
hit[0] 'einreichplan_og.pdf, p.4'
    -> collection = 'proj_abc'
    -> doc_class  = 'oib_richtlinie — OIB-Richtlinie'    ← wrong, belongs to hit[1]
hit[1] 'oib-rl_2_ausgabe_mai_2023.pdf, p.12'
    -> collection = 'oib_knowledge'
    -> doc_class  = None                                  ← lost
```

This is not cosmetic: `doc_class` is **first priority** in `lane_for_hit`
(`src/aiq_agent/common/norm_registry.py:921`) and *fully determines* the lane,
overriding the collection and filename heuristics below it. So:

- the client's Einreichplan is classified `baurecht_oib` → coarse kind
  `baurecht` → law tint, indigo OIB accent, **"OIB" authority badge**;
- the actual OIB Richtlinie loses its authoritative classification and falls
  through to the filename guess.

A citation chip claims a private project plan is an OIB Richtlinie. In a
building-law product that is the most damaging possible mislabel.

**Why it is invisible:** every field involved is optional and fail-open, so
nothing raises, nothing logs, and the chip renders confidently.

**Fix shape:** parse per `--- Result N ---` block instead of by global position.
The block splitter already exists in the same module —
`_extract_kl_chunk_bodies` (`:779`) walks `_KL_RESULT_BLOCK_RE` correctly.
Reuse it and run the four field regexes *inside each block*. This also makes
`chunk_text` alignment structurally guaranteed rather than coincidental.

`Collection:` has the same shape of exposure. Today it is safe only because
`_retrieve_collection` calls `chunk.metadata.setdefault("collection", coll)` on
every chunk (`register.py:796`) — an invariant held by an unrelated function,
not by the protocol.

---

### 2.2 — S2 · Deep research: a knowledge-base source can never be "cited"

**Structural. Documented as deferred in ADR-0026; still live.**

Two SSE artifact types carry deep-research sources:

- `citation_source` — every discovered source, emitted from
  `_emit_structured_citation_sources` (`frontends/aiq_api/.../jobs/callbacks.py:676`).
  This one **does** go through `source_entry_to_wire`, so it carries
  `kind`/`lane`/`file_name`/`page`. Good.
- `citation_use` — "this was actually cited", emitted from `_emit_cited_urls`
  (`:454`), which extracts **URLs only** and validates via `registry.has_url`.
  There is no `has_citation_key` path.

`citation_use` is the only writer of `isCited` on the frontend
(`use-deep-research.ts:551`, `use-load-job-data.ts:661`). And
`deriveAnswerSources` filters on it (`answer-sources.ts:197`):

```ts
const cited = citations.filter((c) => c.isCited)
const relevant = cited.length > 0 ? cited : citations
```

**Failure scenario:** a deep-research run on OIB RL 2 cites four corpus
documents and one web page. The web page produces a `citation_use` event; the
four OIB documents cannot. `cited.length === 1`, so the "Belegt durch" row shows
**only the web page** and silently drops all four authoritative sources. The
answer looks web-grounded.

The fallback branch masks it in testing: with *zero* web citations the row falls
back to the full list and looks correct. The bug only appears when web and KB
sources co-occur — i.e. on the most research-heavy answers.

**Fix shape:** give `_emit_cited_urls` a citation-key path (scan the report's
source section for `[N]` lines, resolve each via `registry.entry_for_citation_key`,
emit `citation_use` with the wire payload). Better still: stop deriving
"cited" on the frontend at all and have the deep path carry
`verify_citations`' `valid_citations` — the backend already knows the answer
exactly, the same way the shallow path does (`shallow_researcher/agent.py:684-702`).

---

### 2.3 — S3 · Büroarchiv citations are structurally unclickable

**Structural gap. One of the four coarse kinds cannot resolve.**

`resolveCitationTarget` (`answer-sources.ts:415`) matches a citation's filename
against exactly two indexes, supplied by `loadSourcePreviewIndex`
(`SourcePreview.tsx:70-108`):

```ts
projectId ? fetch(`/api/documents?projectId=…`) : null,   // project uploads only
fetch('/api/knowledge-base')                              // base corpus only
```

`/api/documents` is project-scoped by schema (`projectId: z.string().min(1)`,
`app/api/documents/route.ts:11`). The org Archiv lives behind
`/api/archiv/documents` (ADR-0024) and is **never fetched**.

So any citation whose coarse kind is `buero` — an `archiv_*` collection hit,
the office's own standards and details — falls through both lookups and lands in
the `info` branch: a popover with a title and no way to open the document. The
preview *route* exists (`/api/documents/[id]/preview` is scope-aware and would
serve it); only the index is missing.

This is a whole product surface (Büroarchiv) whose citations are permanently
second-class, while the ADR's own taxonomy promises "every source becomes a
chip" with "identical first-class treatment".

**Fix shape:** add the archiv listing to `loadSourcePreviewIndex` and give
`resolveCitationTarget` a third lookup. The `CitationTarget` union already
carries `document: { type: 'project' | 'base' }` — it needs an `'archiv'`
member, or `type: 'document'` with an id, which collapses the first two anyway.

---

### 2.4 — S4 · Four renderers, four different behaviours for one citation

**The core of the maintainer's complaint. Directly contradicts "every citation
behaves the same way".**

The same `CitationSource` renders through four unrelated components:

| Surface | Component | Tint | Authority badge | Click | Copy citation | Page |
|---|---|---|---|---|---|---|
| Chat answer | `SourcePreviewChip` (`SourcePreview.tsx`) | ✅ kind + OIB accent | ✅ | ✅ PDF at page / link / popover | ✅ | ✅ |
| Report tab | `ReportSourcesList` (`ReportTab.tsx:67`) | ❌ generic `Badge` | partial (flag-gated) | ⚠️ only `sourceKind === 'kb'` | ❌ | ❌ |
| Thinking tab | `CitationCard` (`layout/components/CitationCard.tsx`) | ❌ none | ❌ | ⚠️ **only if `url` is http(s)** | ❌ | ❌ |
| Herleitung | `SourceCard` (`reasoning/SourceCard.tsx`) | ✅ | ✅ | ❌ | ❌ | ❌ |

`CitationCard` is the sharpest case: it is the deep-research citation list, it
receives fully-populated wire payloads (`kind`, `lane`, `fileName`, `page`,
`bindingNote`), and it renders **none** of them. A KB citation there is dead
text — `citation.url` is undefined for corpus hits, so the `<a>` branch at
`:112` is skipped and the card is inert. Meanwhile the identical source one tab
over opens a PDF at the cited page with a bindingness popover.

`ReportTab` is the second case: it re-renders the written markdown line and
bolts a preview chip on beside it, only for `kb`. A RIS entry gets no chip; a
`buero` entry cannot even be distinguished (`ReportSourceKind` is
`kb | web | ris` — the coarse kind never reaches this path, because it travels
in the wire and this path parses *text*).

**Fix shape:** one `<Citation>` component with layout variants
(`chip | row | card`), consuming one model. Click behaviour, tint resolution,
authority badge and copy affordance are then defined once. The three call sites
become props, not parsers.

---

### 2.5 — S5 · Page numbers are asserted, not verified — but are deep-linked

**Trust. Cheap to fix.**

`has_citation_key` matches on filename only, deliberately
(`citation_verification.py:350-364`):

> Page numbers are not required to match — the LLM may cite a different page
> than what the knowledge layer returned, and that's acceptable since the
> document itself was verified as a real source.

That reasoning holds for *identity* verification. It stops holding at the wire,
because `source_entry_to_wire` puts `page` on the payload (`:1097`) and
`resolveCitationTarget` passes it into `PdfViewerDialog` as the page to open
(`answer-sources.ts:432`, `:451`).

**Failure scenario:** the model retrieves `oib-rl_2…pdf, p.12`, writes
`[3] oib-rl_2…pdf, p.47`. Verification passes (filename matches). The chip
renders as a verified OIB source and opens the PDF **at page 47**, which the
agent never read and which may say something else entirely. The user's
reasonable inference — "the system opened it here, so the claim is here" — is
unfounded.

Note the registry already holds the truth: dedup is keyed on
`(filename, page)` (`:198`), so the set of *retrieved* pages per document is
known exactly.

**Fix shape (pick one):**
- verify the page and record a `page_not_retrieved` drop reason (strictest,
  and it feeds the citation-health ledger for free); or
- keep the lenient identity match but **only deep-link pages the registry
  actually holds**, opening the document at page 1 otherwise. Cheap, non-breaking,
  removes the false precision.

---

### 2.6 — S6 · Tool names become citations

`extract_sources_from_tool_result`'s final fallback (`:592`) registers any
non-empty, non-status tool output as a source keyed by the **tool name**:

```python
return [SourceEntry(citation_key=tool_name, source_type="tool_result", tool_name=tool_name)]
```

The shallow prompt instructs the model to cite these directly
(`researcher.j2:129`): `- [1] mcp_time__get_current_time`.

Downstream, `source_entry_to_wire` gives such an entry no `file_name` (no
extension), no `origin` token, and `kind` falls open to `web`
(`kind_for_lane` default). It renders as a `web`-tinted chip labelled with a
function name, sitting in the same row as `OIB-Richtlinie 2`, visually claiming
equal evidentiary status.

Defensible for `mcp_time`. Not defensible as a *general* fallback in a
Baurecht product, where the row is read as "what backs this answer".

**Fix shape:** give tool-result sources their own kind (`tool`) with its own
muted token and label, so they are honest about being a computation, not a
document. One registry entry in `source_kinds.py` plus its CSS token — the ADR
explicitly designed for this ("adding a source kind is a one-line registry
entry").

---

### 2.7 — S7 · Redundant and drifting classifiers

Four independent classifiers decide "what kind of source is this?", three of
them re-deriving information the wire already carries:

1. `classifyCitation` (`answer-sources.ts:135`) — checks structured `origin`
   first (good), then falls back to re-parsing the `[KB]`/`[RIS]`/`[Web]` token
   out of `content`, then URL regexes, then defaults to `kb`. The final
   `return 'kb'` means *any* unclassifiable citation is asserted to be
   knowledge-base.
2. `LEGACY_KIND_TO_SIGNAL` (`answer-sources.ts:32`) — keeps the pre-ADR-0026
   `kb → project` mislabel alive for persisted messages. Correct as
   back-compat, but it means old conversations still render OIB documents in the
   project tint, which is exactly the defect ADR-0026 was written to remove.
   There is no migration and no marker distinguishing "legacy" from "current"
   in the UI.
3. `classifySourceSignal` (`source-presets.ts:66`) — a *third* taxonomy, regex
   over data-source ids/names, for composer presets.
4. `resolveCorpusFileName` (`knowledge/lib/resolve-corpus-file.ts`) — a fourth,
   mapping human labels ("OIB RL 4 Leitfaden") back to filenames, needed only
   because `legal_basis` cards carry display strings and no file identity.

(4) is the interesting one: it exists purely because the card transport dropped
the structured identity that the citation wire already carries. Threading
`file_name` onto `legal_basis` cards would delete that heuristic outright.

---

### 2.8 — S8 · `_is_knowledge_citation`'s lenient fallback over-matches

`citation_verification.py:894-924`. After the strict `filename.ext` pattern
fails, the fallback checks whether **any** registered filename appears
*anywhere* in the reference text, and then returns the **registry's** citation
key rather than the model's:

```python
for entry in registry._citation_keys:
    entry_file, _ = _parse_citation_key(entry.citation_key)
    if entry_file.lower() in ref_lower:
        return True, entry.citation_key
```

Consequences:

- A prose line — `[4] Siehe auch oib-rl_2_ausgabe_mai_2023.pdf für Details` —
  validates as a citation.
- The returned key is the registry's, so two different written entries that both
  mention the same filename resolve to the **same** key and are then collapsed by
  the dedup pass (`:1687-1723`) with reason `duplicate_of_citation_N`. The
  second entry's distinct content is lost.
- It reaches into `registry._citation_keys` — a private attribute — from a
  module-level function. Minor, but it is the same coupling that makes this
  module hard to change safely (`persist_session_registry` reaches into
  `registry._all` at `:457` for the same reason).

---

### 2.9 — S9 · Citation-health metrics count the session, not the turn

`shallow_researcher/agent.py:824-847` emits the per-turn ledger row using
`registry.all_sources()` — the **cumulative session registry**, which persists
across turns by design:

```python
registry_sources = registry.all_sources()
citation_events.record_turn(
    source_count=len(registry_sources),
    ...
    retrieved_source_labels=[... for entry in registry_sources],
```

`cited_count` is correctly this turn's (`len(wire_sources)`), so the two halves
of every ratio are measured over different windows. Over a 10-turn conversation
`source_count` grows monotonically while `cited_count` stays flat, so the
dashboard's implied "citation efficiency" decays for reasons that have nothing to
do with citation quality. `retrieved_source_labels` likewise attributes prior
turns' documents to this turn — which then feeds the missing-source candidate
analysis in `lib/citations/missing-sources.ts`.

---

### 2.10 — S10 · Minor / cosmetic

- **German answers get an English heading.** The shallow prompt asks for
  `**References:**` (`researcher.j2:37`), even for German answers.
  `_normalize_source_section_layout` (`:1198`) rewrites the heading to
  `## Quellen` only when it matches the German label list — so a German answer
  written to spec gets `## Sources`. Either ask the prompt for `**Quellen:**` on
  German turns, or derive the heading from the answer language.
- **`_MAX_SESSION_REGISTRIES = 1000` LRU vs. persistence race** — noted and
  accepted in ADR-0026; unchanged.
- **`top_k` retrieval ceiling** — noted and accepted in ADR-0026; unchanged.
- **Shallow capture double-gate** (`agent.py:490-498`) — a tool present in the
  loaded set but absent from `data_sources:` has all its sources dropped at
  `debug` level. Still no config-coverage guard, as ADR-0026 flagged. Worth a
  startup assertion rather than a behaviour change.

---

## 3. What is genuinely good

Worth stating, because the recommendation below is "consolidate", not "rewrite":

- **Quote verification** (`verify_quoted_spans`, `_quote_coverage`, `:1377`) is
  strong, original work. The non-contiguity budget correctly defeats the
  adjacent-clause splice that both earlier metrics let through, and the
  reasoning is documented at the level of *why the previous two attempts failed*.
  Fail-open, annotate-never-delete, and it feeds the confidence cap. Keep.
- **The overconfidence guard** (`markers.py:182-226`) is a clean pure-function
  boundary — deterministic platform policy on top of a model self-report, with
  the cap reason surfaced to telemetry.
- **The shallow chip path is correct.** Emitting only `verification.valid_citations`
  (not the cumulative registry) is the right call and is why a greeting turn does
  not leak the previous turn's RIS sources.
- **Per-entry wire serialization** (`agent.py:806-814`) — a malformed source
  costs one chip, not the whole row. Exactly right, and it was a real bug once.
- **The citation-health ledger** is a genuinely well-designed observability
  layer: one baseline row per turn keeps the clean-rate denominator honest, no
  answer prose crosses the boundary, and the missing-source analysis
  cross-checks against what the platform actually holds before recommending an
  action.
- **The prompts are careful.** The shallow prompt's "inventory is an INDEX, not
  evidence" block and the deep writer's citation-map rules are unusually precise
  and directly encode the verification semantics.

---

## 4. Recommendation

Do **not** add an abstract `Citation` base class. The backend model is already
singular; an inheritance hierarchy would add a layer without removing one. The
duplication is at the **transport and render boundary**, and that is where to cut.

Four changes, in dependency order:

### R1 — Make `source_entry_to_wire` the *only* way source identity leaves the backend

Version it (`schema: "grid.citation/v1"`) and route every transport through it:

- WS `sources` — already does.
- SSE `citation_source` — already does; make `citation_use` carry the same
  payload rather than a bare URL (fixes §2.2).
- The written `## Quellen` section — keep it in the markdown for copy/paste and
  offline reading, but stop treating it as a *data* channel. Today the frontend
  parses it back into `ReportSourceEntry` and merges it with the wire in
  `answer-source-list.ts` — 300 lines of identity-matching that exists only
  because the `[N]` binding was not on the wire. It is now (`number`, `:1080`).
  Once every path carries `number`, the written-entry parser becomes a
  legacy-message adapter, not a live pathway.
- `legal_basis` cards — add `file_name`/`page`, which retires
  `resolveCorpusFileName` and the OIB-label dedup heuristic (§2.7).
- `## Trace-Lanes` — already structured; emit `kind` alongside `lane` so
  `trace-lanes.ts` stops re-deriving it.

### R2 — One frontend model, one normalizer

`CitationSource` becomes the single model; `citationFromWire` the single
producer. `ReportSourceEntry` and `TraceSourceCard` become *adapters into* it
(pure functions returning `CitationSource[]`), not parallel types with their own
render paths. `AnswerSourceRef`/`AnswerSourceItem` collapse into a single view
model computed once.

### R3 — One `<Citation>` component, three layout variants

`chip` (chat row) · `row` (report list) · `card` (thinking / Herleitung).
Tint resolution, authority badge, target resolution, click behaviour and the
copy affordance are defined once. This is what makes "every citation behaves the
same way" true rather than aspirational, and it deletes `CitationCard` and
`ReportSourcesList`'s bespoke rendering.

### R4 — One complete resolver

`resolveCitationTarget` gets all three document indexes (project · base corpus ·
**archiv**), fixing §2.3, and only deep-links pages the registry actually holds,
fixing §2.5.

### Suggested sequencing

`S1` (§2.1) is a self-contained correctness fix and should land first,
independently — it is a ~20-line change inside `_parse_knowledge_layer` reusing
the block splitter that already exists, plus a regression test with a
heterogeneous result set. `S2` and `S3` are each a bounded fix that does not
require the consolidation. `R1`–`R4` are the structural work and are best done
as one rollout, because R2/R3 are only safe once R1 guarantees every path
carries the same fields.

---

## 5. Pipeline map (as-built)

```
INGEST
  oib_sync.py            data/oib + OIB_UPLOADS_DIR → Chroma (oib_knowledge)
  project/archiv upload  → proj_* / archiv_* collections
  document_metadata_store  display_title, doc_class  (admin-editable, authoritative)

RETRIEVAL OUTPUT  (text protocol — sources/knowledge_layer/src/register.py:_format_results)
  --- Result N ---
  Source: <display_title>      always
  Collection: <coll>           conditional  ← §2.1 exposure
  Dokumentart: <class> — <de>  conditional  ← §2.1 BUG
  Page: / Citation: / Relevance Score:
  <chunk body, ≤1500 chars>
  ## Trace-Lanes {json}        side-channel for the Herleitung fan-out

CAPTURE          extract_sources_from_tool_result → SourceEntry
                 parsers: knowledge-layer | generic-URL | tool-name fallback (§2.6)
                 gate (shallow): loaded tools ∩ data_sources registry

REGISTRY         SourceRegistry — dedup: normalized URL | (filename, page)
                 session ContextVar + LRU(1000) + Dragonfly persist (ADR-0020)

VERIFY           verify_citations       identity only, removes never repairs
                 verify_quoted_spans    fuzzy, fail-open, annotates inline
                 sanitize_report        URL hygiene + renumber

CLASSIFY         lane_for_hit (doc_class ▸ collection ▸ filename ▸ url)
                 → kind_for_lane → baurecht | buero | projekt | web

WIRE             source_entry_to_wire   ← the declared contract
                 {number, content, title, citation_key, collection, source_type,
                  tool, url, origin, kind, lane, lane_label, binding_note,
                  file_name, page}

TRANSPORT        WS sources ✅        SSE citation_source ✅ / citation_use ❌ (§2.2)
                 written ## Quellen markdown ⚠️     ## Trace-Lanes JSON ⚠️
                 legal_basis cards ⚠️

FE NORMALIZE     wire-citation.ts → CitationSource
                 report-citations.ts → ReportSourceEntry
                 trace-lanes.ts → TraceSourceCard
                 answer-sources.ts → AnswerSourceRef
                 answer-source-list.ts → AnswerSourceItem

FE RENDER        SourcePreviewChip · ReportSourcesList · CitationCard ·
                 SourceCard · LegalBasisCard          ← §2.4

TELEMETRY        citation_events → POST /api/internal/citation-events
                 → platform Citation health dashboard + JSON export   (§2.9)
```

---

## 6. Resolution — what actually changed

All ten findings are fixed. Test counts moved from **2266 → 2304** (backend)
and **3086 → 3115** (frontend); typecheck and lint are clean.

### Corrections to the audit

Fixing forced two of the findings to be re-examined, and the audit was wrong
about both. Recorded here rather than quietly edited above:

- **§2.5 overstated the page problem.** The claim was that the UI deep-links an
  *unverified* page. It does not: the wire's `page` comes from the registry
  ENTRY, which is by construction a page retrieval actually returned. The real
  defect was narrower and different — `entry_for_citation_key` matched on
  filename only and returned whichever chunk was registered FIRST, so a citation
  to p.30 opened the PDF at p.12 whenever both pages had been retrieved. Fixed by
  making the lookup prefer the page the citation names.

- **§2.8 mis-identified the failure mode.** The concern was that a prose line
  mentioning a filename would validate as a citation. Those lines only ever come
  from the source section, where being a citation is the point — so that was not
  a real defect. Probing the matcher instead surfaced something far worse: two
  citation formats models routinely write were being **silently dropped**.
  `[1] Titel - datei.pdf, p.12` had its title swallowed into the "filename" by a
  greedy pattern, and `[1] Titel (datei.pdf, p.12)` had its whole locator eaten
  by the trailing-parenthetical trim meant for "(Internal)". Both produced
  "Quellenangabe entfernt" on citations to genuinely retrieved documents — very
  likely the single largest contributor to the citation-health defect rate.

### Found only while fixing

- **Stale wire citation numbers.** `sanitize_report` renumbers `[N]` to close
  the gaps that `verify_citations`' removals leave, but the `[N]`→source binding
  was captured *before* that pass. A chip could be labelled `[3]` while the prose
  pointing at it now said `[2]`, and the inline marker's anchor scrolled to a row
  that did not exist. `sanitize_report` now returns its renumber map.

- **Deep research dropped the whole taxonomy.** Beyond §2.2's cited-flag gap, the
  SSE client hand-mapped citation fields and silently dropped `kind`, `lane`,
  `lane_label`, `binding_note` and `number` — so every deep-research citation
  fell back to the pre-ADR-0026 heuristic that tints the OIB corpus as project
  material. Fixed by handing the artifact over whole to `citationFromWire`,
  which also removed three parallel hand-mappings and a replay-only defect they
  hid (buffered discovery + cited events produced two rows where the live path
  produced one).

- **The report tab's fallback source list rendered `citation.url` as a row's
  entire content** — blank for a document. Harmless only while KB sources could
  never be marked cited, so fixing §2.2 would have made it visible.

- **The German prompt contradicted itself.** §2.10 blamed the normalizer; the
  cause was the prompt's own German few-shot example writing `**References:**`.
  The normalizer's canonicalisation is deliberate and was left alone.

### Architecture: where it landed

R1/R2 are done for the paths that matter: `source_entry_to_wire` is the single
serializer and `citationFromWire` the single frontend normalizer, used by the
WS path, both SSE artifact types and both replay buffers. R3 is done as a
`variant` on one component rather than a new abstraction — the pill and the
source-list row are two layouts of one renderer, so click behaviour, tint,
authority badge and target resolution are defined once. R4 is done: the target
resolver sees project uploads, the org Archiv and the base corpus.

Deliberately **not** done, and why:

- **No abstract `Citation` class.** The backend model was already singular; an
  inheritance layer would have added a level without removing one.
- **The report's written `## Quellen` list keeps its bibliography layout.** A
  report legitimately renders its sources as a numbered list rather than chips;
  what had to match was behaviour, not shape.
- **`_append_minimal_citation` still writes an English `**References:**`
  header.** It is lifted out of the answer before display and the answer's
  language is genuinely unknowable at that point — changing it would churn tests
  for no user-visible gain.

### Still open

- The **shallow capture double-gate** (§2.10) still drops an evidence tool's
  sources at `debug` level when it is missing from `data_sources`. It wants a
  startup coverage assertion, not a behaviour change.
- **`_session_registries` LRU vs. persist race** and the **`top_k` ceiling** —
  unchanged, as ADR-0026 already accepted.
