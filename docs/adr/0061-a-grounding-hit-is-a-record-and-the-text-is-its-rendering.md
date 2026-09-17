---
status: proposed
date: 2026-09-15
decision-makers:
consulted:
informed:
---

# A grounding hit is a record, and the text a tool returns is its rendering

## Context and Problem Statement

Every evidence tool answers in one grammar: a preamble, a run of
`--- Result N ---` blocks whose header states `Source:`, `Collection:`,
`Shelf:`, `Dokumentart:`, `Punkt:`, `Citation:` and `Relevance Score:`, the
passage body under that last line, and one `## Trace-Lanes` object at the end.

Until now that grammar existed three times. Two producers wrote it out line by
line, `knowledge_layer.register._format_results` and
`ris_adapter.lookup.render._passage_block`, and
`citation_verification._parse_knowledge_layer` read it back with eleven regexes
plus five block-scoping helpers, on every live turn, inside the same process
that had just built the values.

The cost was not theoretical. The parser used to zip whole-document `findall`
lists by position, and because the producer omits `Collection:` and
`Dokumentart:` for a hit that has none, one unclassified hit shifted every later
value onto the wrong document. `doc_class` is the first signal `lane_for_hit`
reads, so a user's own project upload was presented as a binding OIB Richtlinie.
Block-scoped parsing fixed that, and then a second instance of the same class of
bug arrived: a scanned plan whose title block carries a metadata table supplied
the `Dokumentart:` line its own header had omitted, with the same user-visible
result. `_kl_block_header` fixed that one. Both fixes are correct and both are
patches on a channel that discards what the producer knew and asks a third
module to recover it.

The Punkt line is the same story from the other side. The chunker computes
`punkt_id`, measured 946 of 946 against the corpus contents pages, and for a
long release it was dropped before the citation a reader sees, because nothing
between the producer and the registry carried it.

## Decision Drivers

* The model-facing text may not change by a byte. It is the prompt, and a moved
  line or a dropped field is a silently different prompt.
* A field a producer states must reach the registry without a second derivation
  deciding what it means.
* A passage body is attacker-shaped input: it is document text the producer does
  not control, and it must not be able to supply a header field.
* The text still has to be readable by itself. A registry hydrated from the
  shared cache, a turn replayed out of Postgres and the job runner's callback
  all hold the bytes and never had the records.

## Considered Options

* Keep the text as the only channel and keep hardening the parser.
* Carry the records on `ToolMessage.artifact` with
  `response_format="content_and_artifact"`.
* Render from records, and file the records under the hash of the bytes the
  renderer produced.

## Decision Outcome

Chosen option: "render from records, and file the records under the hash of the
rendered bytes", because it makes the text a projection of data the producer
already had, while leaving that text the only thing that reaches the model.

`common/grounding_block.py` holds `GroundingHit` (frozen, one citable passage),
`GroundingBlock` (preamble, degraded banner, hits, lanes, trailer) and
`render_grounding_block`, which is the one place the grammar's line order and
spacing live. The renderer records the block under `sha256(rendered_text)` in a
per-turn `ContextVar`, opened in `PilotiAgent.run` beside `begin_lane_capture`.
Recording happens inside the renderer, so a producer cannot emit a block and
forget to make it readable back.

`extract_sources_from_tool_result` looks the block up by that hash first and
builds `SourceEntry`s by field copy, in block order. A miss falls through to the
text parsers, which stay. Their answer is final, including an empty one: a text
with no `Citation:` line states no source and registers none. The generic URL
extractor below them reads the tools that have no parser at all.

`ToolMessage.artifact` was measured on the installed versions and rejected. NAT
builds the LangChain tool itself, in `nat/plugins/langchain/tool_wrapper.py`:
`NATStructuredTool.from_function(coroutine=fn.acall_invoke, ...)` passes no
`response_format`, so the tool runs on LangChain's default `"content"` and never
splits a `(content, artifact)` pair, and `acall_invoke` has already coerced the
return value to the function's declared output type before that. Nothing put on
the artifact reaches the middleware. Forking the wrapper would change every tool
in the fleet for one of them.

### Consequences

* Good, because the header lines, the Trace-Lanes fan-out and the citation
  registry now read a hit's shelf, Dokumentart and title from one function
  (`_grounding_hit`), so they cannot disagree. RIS is the one exception, and it
  is deliberate: its fan-out names a passage by its citation (`Bauordnung für
  Wien, § 63 Abs 1`) where the `Source:` line carries the Kurztitel, because a
  Herleitung entry that showed the law's name alone would drop the § the reader
  came for (`ris_adapter.lookup.render._trace_lanes_block`).
* Good, because a passage body can no longer forge a header field on the live
  path. There is no scan for it to poison.
* Good, because RIS stopped carrying its own copy of the grammar. Adding a
  header line is now one edit in the renderer instead of two, plus a regex.
* Good, because a producer must state a score: the `Relevance Score:` line is
  also the header/body delimiter, and the type makes a block without one
  unbuildable.
* Bad, because the text parsers stay, so two readers of one format exist and can
  drift. The contract test below is what holds them together.
* Bad, because the lookup is keyed on exact bytes. A producer that decorates its
  own output after rendering falls back to the text path and nothing says so
  out loud. Both decorations are rendered inside the block for that reason: the
  requery notice as the `degraded_banner`, ahead of everything, and
  `read_passage`'s outline index as the `trailer`, after the fan-out. A new one
  has to go the same way.
* Bad, because the structured reader keeps a precision the rendered line rounds
  away: `Relevance Score:` prints two decimals and `SourceEntry.score` now
  carries what retrieval measured. No surface renders a score today.
* Good, because it surfaced a third producer nobody had registered. `read_passage` renders
  through `_format_results`, and the text parser is registered on the substring
  `knowledge`, which that tool name does not contain, so its passages fell to
  the non-URL fallback and registered one source keyed `read_passage`. Every
  citation to a passage a turn had OPENED rather than searched was dropped as
  `citation_key_not_in_registry`. The structured path would have fixed that on
  a live turn only, so the tool name is now registered with the same parser and
  both readers agree.

### Confirmation

Three gates, all in CI's backend jobs:

* `tests/aiq_agent/common/test_grounding_block.py` renders a block with every
  optional field present in one hit and absent in another, and compares it
  against `tests/fixtures/citation_pipeline/grounding_block_all_fields.txt` and
  `grounding_block_ris.txt`. Those two fixtures are the bytes the hand-written
  producers emitted before the renderer existed, captured and checked in, so a
  changed line order fails rather than ships.
* `tests/aiq_agent/common/test_citation_pipeline_contract.py` reads each
  producer's output twice, once with the capture open and once without, and
  asserts the two readers produce identical `SourceEntry` lists field by field.
  Both producers are in it, `_format_results` and RIS `format_passages`, so the
  fields only RIS states (source URL, Rechtlicher Hinweis, a Punkt that is a §)
  are covered too. That is what keeps the text parsers honest while they are
  still needed.
* `sources/ris_adapter/tests/test_ris_lookup_format.py` and
  `sources/knowledge_layer/tests/test_read_passage_outline.py` assert the
  grammar's text directly, from the real tools. The outline tests also pin that
  a `read_passage(document=…)` result is found in the capture, and its bytes
  against what the code that appended the Gliederung produced.

## More Information

Revisit this if the text parsers' callers go away. Once cached registries store
records rather than rendered bytes, and the job runner runs inside a turn's
context, `_parse_knowledge_layer` and the `_KL_*` regexes have no caller left and
should be deleted rather than maintained.

The regexes that read the MODEL'S ANSWER stay either way: `_PAGE_RE`,
`_parse_citation_ref`, the reference-section family, quote verification and
`sanitize_report`. The tool side is structured because a tool states fields; the
answer side is text because the model writes text.

NAT dropping `ToolMessage.artifact` is written up in
[`docs/contributing/gotchas.md`](../contributing/gotchas.md).
Related: ADR-0026 (source kinds), ADR-0047 (a shelf travels as data),
ADR-0049 (folders as a materialised path), ADR-0054 (agent-document provenance).
