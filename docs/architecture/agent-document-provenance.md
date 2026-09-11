# Agent-document provenance

What a published Piloti document carries into retrieval, so a reader and the
model can see who wrote it — and cannot mistake it for a norm.

## The gap this fills

A document Piloti wrote and a person approved is filed like any other document:
same shelf, same folder, same ingest. Once it is in the index, nothing that
travels with a retrieved chunk says an agent wrote it, and the two axes that
look like they could say it both fail:

| Axis | Why it cannot carry authorship |
|---|---|
| `doc_class` ("Dokumentart") | A closed nine-value NORM-HIERARCHY vocabulary (`knowledge/document_classification.py`), human-set, whose fail-open lane is `baurecht_basis` — "Basisdokument", in law blue. Filing authorship here files it under authority, where an unknown value reads as a weak norm. `agent_authored` is deliberately NOT a member |
| Shelf (ADR-0047) | The shelf says WHERE the document sits, and a published Piloti document really does sit on the project or the Archiv shelf. It would render as Projektwissen or Büroarchiv, both true and both silent about the author |

So authorship is its own axis, and it beats both.

## The metadata contract

Four keys, stamped by the BFF at publish and parsed by
`src/aiq_agent/common/provenance.py`:

| Key | Value |
|---|---|
| `authored_by` | `"agent"`. Anything else, the key's absence included, is a human document and gets no provenance at all |
| `approved_by` | Display name of the person who approved it |
| `approved_at` | ISO date of that approval |
| `producer` | Which pipeline wrote the document |

`parse_agent_provenance` tolerates absence in every direction and returns
`None` for anything unmarked, so every human document stays byte-for-byte
unchanged through the whole pipeline.

## The lane

`buero_piloti`, label "Piloti-Dokument", inside the `buero` source kind
(`common/source_kinds.py`, mirrored in
`frontends/ui/src/features/chat/lib/source-kinds.ts`). It is a sub-label within
a coarse kind, never a kind of its own — the document IS office knowledge and
paints in the office colour.

`norm_registry.lane_for_hit` returns it on stated provenance **before** the
doc_class branch and before every shelf rule, which is the whole point: on the
project shelf the document would otherwise wear the Projektwissen chip, and a
doc_class stamped at ingest would place it in the norm hierarchy under the
`"Baurecht"` label fallback.

## What retrieval says

`sources/knowledge_layer/src/register.py` adds one line to a marked hit's
grounding block, and nothing to an unmarked one:

```
Herkunft: Piloti-Dokument · freigegeben von Maria Huber am 01.09.2026
```

One line, not a sentence: the block is text a model copies. The leading
`Piloti-Dokument` token is the contract — `citation_verification` reads exactly
that token back into `SourceEntry.authored_by`, the way a shelf qualifier is
read out of a citation key — and the machine-readable fields travel structured,
as `provenance` on the Trace-Lanes source entry. The `knowledge_search` tool
description carries the rule the model needs: cite such a hit for what the
office decided, never for what the OIB requires.

## The gate

`common/answer_envelope._gate_verdict` drops a verdict whose `reference`
resolves to an agent-authored source, logs why, and emits a technical
`status:verdict:dropped` event (`reason: agent_authored_reference`) so the rate
is countable. The verdict is the one place an answer names a Fundstelle for a
value the reader copies into a Nachweis, and `verify_citations` cannot help:
it proves the source is real, and this source IS real. The answer, its prose
and its citations are untouched — only the masthead goes.

## Where the keys come from

The publish path, and only it. `POST /api/documents/{id}/versions/{vid}/publish`
runs the lifecycle's `ingestPublished` effect, which dispatches the published
version's bytes to `POST /v1/ingest` with these four fields beside `file_name`,
`collection` and `folder_path`. The dispatcher refuses a machine-authored row
unless the dispatch names the row's own `published_version_id`, so a draft, an
in-review version, an approved-but-unpublished one, a superseded one and a
rejected one never reach the index; the document is filed under the
`piloti/<document id>/<name>` namespace so a model-chosen title cannot collide
with a person's upload, and migration 0083 makes that a unique index rather than
a convention. Superseding and archiving purge the chunks, and the backend's
`unregister_summary` takes the `document_metadata` row's `provenance` with them.

The BFF resolves `approved_by` through `resolvePeople`, the same lookup every
collaboration surface uses, so the grounding block and the share roster cannot
disagree about what somebody is called; an id the directory cannot resolve
yields `null` and the label degrades to the bare `Piloti-Dokument` rather than
printing a WorkOS id at an architect.

See ADR-0054 § Indexing for the door, and
[`docs/roadmap/piloti-writes-artifacts-and-approval.md`](../roadmap/piloti-writes-artifacts-and-approval.md)
§3 for the design of record.
