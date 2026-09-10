# Workspace tools: `src/aiq_agent/tools`

Tools that act on the user's workspace rather than retrieve from a corpus.
Evidence sources are packages under `sources/`; what lives here is the BIM
surface (`bim/`), the conversation's working directory (`documents/`) and the
write-side workspace verbs (`files/`).

## The invariant

**The working directory never creates a `documents` row.** `write_file` and
`edit_file` write into a LangGraph store namespaced by conversation
(`documents/draft_store.py`). Nothing there is a project document: it is not
filed, not indexed, not citable, and it does not appear in the Files explorer.
A draft becomes a document only through the **document lifecycle API**, which a
person gates — the agent may propose, never publish. The Python tier holds no
second path to that API and must not grow one: the BFF is the single writer of
`grid_app` (ADR-0003).

The card the working directory emits (`document_draft`) reports a file. Once
`file_draft` has run it also names the project document, and its two controls —
„Im Projekt öffnen", „Zur Freigabe einreichen" — go through the routes the Files
pane already uses, in the reader's own session. A tool here that wrote a row
directly would bypass `requireProjectAccess`, the provenance marking and the
review state in one move.

Read [`docs/roadmap/piloti-writes-artifacts-and-approval.md`](../../../docs/roadmap/piloti-writes-artifacts-and-approval.md)
before changing what a file verb may do.

## Filing ECHOES the BFF's envelope; it never signs one

`file_draft` and `submit_draft` (`documents/register.py`) are the exception to
the paragraph above and the only two tools here that change the project. They
reach `POST /api/internal/document-versions` — one route, ops `create`, `update`
and `submit`, closed on the BFF side by the transition table's `actor` field, so
approve, publish, reject and archive have no machine path at all.

**The identity is not this tier's to choose.** The BFF minted a signed
request-context envelope at the start of the turn, from a real session
(`lib/request-context.ts`, ADR-0054 §4). `GridRequestContext` keeps the raw
header and signature exactly as they arrived, and the tool forwards those two
strings unchanged beside `GRID_INTERNAL_API_TOKEN`. The BFF verifies them with
the same secret, reads the acting user out of the verified payload, and builds
that person's pinned session — so every permission check, every `created_by` and
every audit actor is the human who asked.

Re-signing a payload here would work, which is the danger: the internal token
and the signing secret are the same secret, so a Python tier that built its own
envelope would be CHOOSING the user id with a credential that only authenticates
the service. Hence the rule, in three words: **echo, never sign.** A run with no
envelope (CLI, eval, job worker) has no acting person, and the tool refuses
rather than falling back to the unsigned individual headers, which a caller could
have set.

The BFF decides identity and permission. This tier decides only *which bytes* and
*which reference*, and the reference is the conversation's
(`{conversationId}-{slug}`) so two turns writing one document produce two
versions rather than two documents.

## A write-side tool PROPOSES; acceptance executes in the user's session

The same invariant, stated as the rule the next tool has to follow. The five
verbs under `files/` — `move_document`, `rename_document`, `create_folder`,
`set_doc_class`, `assign_document` — all change the user's workspace, and not
one of them changes anything. Each resolves its arguments against what the turn
can already see, emits ONE `file_operation_proposal` card, and returns text
whose first words are that nothing has happened.

Accepting the card runs the operation from the browser, as the signed-in user,
through the routes the Files pane already uses — `PATCH /api/documents/[id]`,
`PATCH /api/documents/[id]/folder`, `POST /api/projects/[id]/folders`,
`POST /api/assignments/document/[id]`. No route is added for the agent and none
is called that a person could not call themselves, so `requireProjectAccess`,
the audit trail and the feature gates are the ones that were already there —
which is ADR-0055 read from this side: one HTTP surface per primitive, and this
tier is a client of it like everybody else, never a second implementation.

Three consequences worth knowing before writing the sixth verb:

- **Nothing is resolved that the turn cannot see.** A document is matched
  against the turn's inventory rows (`knowledge/inventory.get_turn_documents`),
  a folder against the paths those rows carry, a Dokumentart against the closed
  vocabulary. A name that matches two files comes back as a question and never
  as a proposal naming one of them. A PERSON is the exception and is not
  resolved here at all: this tier has no member roster, so the card carries the
  name as the user said it and the reader's own session resolves it — inventing
  a match here would be exactly the guess the rest of the module prevents.
- **A card carries several operations of one kind.** „Räum die
  Einreichunterlagen zusammen" is four moves, and four cards would be four
  decisions for one intention. Repeated calls of the same verb extend the open
  card (`files/cards.py`) up to `MAX_FILE_OPERATIONS`; accepting applies them in
  order and reports each one, so a batch where the third fails says three
  landed and one did not.
- **A verb with no route behind it says so.** `set_doc_class` is that verb
  today: the Dokumentart is settable only on the platform corpus, and a project
  document has no such route. The card shows the proposal and draws no control,
  with the reason where the buttons would be
  (`grid-cards/lib/file-operations.UNAVAILABLE_OPERATIONS`). Inventing a route
  would put the write back on this side of the door.

## Obligations

| When you | You must | What fails you |
|---|---|---|
| Add a verb to the working directory | Add its basename to `_INTERACTION_TOOL_BASENAMES` and its action key to `common/turn_status.py` (with both dictionary strings) | The verb is charged to the research budget, and the reader's live line goes silent mid-turn |
| Change what is stored per draft | Remember DeepAgents rebuilds the stored value from `content`/`encoding` on every edit: a key not re-stamped after the operation is gone | Nothing local. The version counter silently resets to 1 |
| Take text from the model and compare it to stored text | NFC-normalise both, at the backend seam | An `edit_file` that fails with a string identical to the one in the file. [`gotchas.md`](../../../docs/contributing/gotchas.md) |
| Add a tool under here | `@register_function` plus its own `nat.plugins` entry point, like every other tool ([`src/aiq_agent/AGENTS.md`](../AGENTS.md)) | NAT never discovers it |
| Add a verb that WRITES | Make it propose: a `file_operation_proposal` card and a result saying nothing changed. Then its basename in `_INTERACTION_TOOL_BASENAMES`, its action key in `common/turn_status.py`, its row in `TOOL_CONTEXT_REQUIREMENTS`, and its executor in `grid-cards/lib/file-operations.ts` | Nothing local — which is the point. A tool that wrote directly would pass every test and bypass `requireProjectAccess`, the audit trail and the reader's consent in one call |
| Call the BFF from a tool that acts as a PERSON | Echo `GridRequestContext.envelope_header` / `envelope_signature` unchanged. Never build or sign an envelope here, and never read the acting user off the unsigned `x-grid-user-id` header | Nothing local, and everything downstream: the internal token is the signing secret, so a self-signed envelope is a tool choosing whose permissions it runs under |
| Change the shape of a lifecycle request or response | Nothing by hand — the contract is `frontends/ui/tests/fixtures/document-lifecycle.schema.json`, generated from the BFF's zod (ADR-0055). There is no Pydantic twin | `tests/aiq_agent/tools/documents/test_wire_contract.py`, which validates the payloads the tool really builds against that file |
