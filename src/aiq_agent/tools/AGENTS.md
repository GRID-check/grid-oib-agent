# Workspace tools: `src/aiq_agent/tools`

Tools that act on the user's workspace rather than retrieve from a corpus.
Evidence sources are packages under `sources/`; what lives here is the BIM
surface (`bim/`) and the conversation's working directory (`documents/`).

## The invariant

**The working directory never creates a `documents` row.** `write_file` and
`edit_file` write into a LangGraph store namespaced by conversation
(`documents/draft_store.py`). Nothing there is a project document: it is not
filed, not indexed, not citable, and it does not appear in the Files explorer.
A draft becomes a document only through the **document lifecycle API**, which a
person gates — the agent may propose, never publish. The Python tier holds no
second path to that API and must not grow one: the BFF is the single writer of
`grid_app` (ADR-0003).

The card the working directory emits (`document_draft`) reports a file; its
„Ins Projekt übernehmen" action is the lifecycle call, and until that is wired
the card offers nothing. A tool here that wrote a row directly would bypass
`requireProjectAccess`, the provenance marking and the review state in one move.

Read [`docs/roadmap/piloti-writes-artifacts-and-approval.md`](../../../docs/roadmap/piloti-writes-artifacts-and-approval.md)
before changing what a file verb may do.

## Obligations

| When you | You must | What fails you |
|---|---|---|
| Add a verb to the working directory | Add its basename to `_INTERACTION_TOOL_BASENAMES` and its action key to `common/turn_status.py` (with both dictionary strings) | The verb is charged to the research budget, and the reader's live line goes silent mid-turn |
| Change what is stored per draft | Remember DeepAgents rebuilds the stored value from `content`/`encoding` on every edit: a key not re-stamped after the operation is gone | Nothing local. The version counter silently resets to 1 |
| Take text from the model and compare it to stored text | NFC-normalise both, at the backend seam | An `edit_file` that fails with a string identical to the one in the file. [`gotchas.md`](../../../docs/contributing/gotchas.md) |
| Add a tool under here | `@register_function` plus its own `nat.plugins` entry point, like every other tool ([`src/aiq_agent/AGENTS.md`](../AGENTS.md)) | NAT never discovers it |
