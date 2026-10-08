---
status: accepted
date: 2026-10-01
decision-makers: product owner (Matthias), Grid engineering
consulted: Grid engineering
informed: everyone working in this repo
---

# Uploads are screened locally before any model sees them, and matches wait in quarantine

## Context and Problem Statement

Offices worry that invoices, fee agreements, payroll and personnel files are
uploaded along with a project folder, and that their content then reaches a
language model and, through answers, colleagues who should never see it
(ticket „Blacklist", 2026-10-01). The product promise is stronger than a
filter: *sensitive content does not reach a model at all*.

Ingestion sends document content out of the deployment at five places, all in
`sources/knowledge_layer/src/llamaindex/adapter.py` and all through the ZDR seam
of [ADR-0074](0074-zero-data-retention-is-the-default-enforced-at-one-seam.md):
OCR of scanned pages, image captioning, VLM enrichment of embedded drawings,
summary and tag classification, and the embeddings of every chunk. Before the
first of them the pipeline has already read the file locally: the download from
the tenant's own bucket, a pdfium thumbnail, pdfplumber's text layer, and the
office and text-format extractors. The BFF calls no external model on upload
(Gotenberg and the IFC parse run in the cluster).

We asked whether the NVIDIA Agent Toolkit can do this. It cannot, as installed
or as published (evidence in `plans/2026-10-01-upload-governance-worklog.md`):
NAT 1.9's middleware hooks registered functions, not document ingestion, which
runs in our own ingestor; the optional `nvidia-nat-security` package's
`pii_defense` is Presidio with `language="en"` hard-coded and inspects function
*output* only; NeMo Guardrails' sensitive-data rail is English-only and sits on
chat and retrieval; `nvidia/gliner-PII` is trained on English. None classifies a
document as an invoice or a fee agreement.

## Decision Drivers

* Nothing that matches may reach a model, not even once, not even for a summary.
* The office defines what is sensitive, without the Piloti team, and can change it any time.
* A rule an office cannot see the effect of is a rule it will switch off: every exclusion
  says which rule caught it.
* German compound nouns: „Schlussrechnung" must match „Rechnung"; „Statische Berechnung" must not.
* One gate for every shelf and every path into the index (upload, re-ingest, re-index, Archiv,
  chat), so the next caller is screened without remembering to be.

## Considered Options

* A NAT middleware (`nvidia-nat-security` `pii_defense` or the Guardrails middleware).
* A local PII model (`nvidia/gliner-PII`, `gliner_multi_pii-v1`, Presidio with a German spaCy model).
* Two local, rule-based gates owned by us: a **name gate** before any byte leaves the browser,
  and a **content gate** inside the ingest job between local extraction and the first model call;
  matches are kept but not indexed (**quarantine**) until a reviewer releases or deletes them.

## Decision Outcome

Chosen option: the two rule-based gates with a quarantine, because they are the
only option that runs before the first model call on every path, works on
German, and explains each verdict.

- **The policy** is an organization setting, `settings.uploadScreening`
  (`lib/upload-screening/policy.ts`): name terms, name exceptions, content terms
  and detectors (`iban` with mod-97, `at_svnr` with its check digit,
  `credit_card` with Luhn). Absent means the suggested Piloti list applies, so a
  new office is protected from its first upload; the admin edits or empties it
  under Organisation → Sensible Daten. Its only writer is
  `PUT /api/organization/upload-screening` (`org:settings:manage`); the generic
  settings save refuses the key (`DEDICATED_ROUTE_SETTINGS`).
- **Name gate.** Every path segment of the file's origin path is matched,
  case- and umlaut-folded, as a substring (so compounds match), minus any
  occurrence covered by a declared exception (`Berechnung`). The browser checks
  before upload and shows what is excluded and why; the uploader may release a
  single file (the Bauvertrag in „Verträge"), which is sent as an explicit,
  audited override. The BFF repeats the check on receipt and refuses a match
  that carries no override, without storing it.
- **Content gate.** `dispatchIngest` is the one place the BFF calls
  `/v1/ingest`, and it always sends the policy's content rules as `screening`.
  The job screens the locally extracted text before OCR, captioning,
  summarising or embedding; a match ends the file as
  `quarantined:{reasons}` with masked samples, and no model call has been made.
- **Quarantine** is a document status (`quarantined`, terminal, neutral): the
  bytes stay in the tenant's bucket, nothing is indexed. Organization admins and
  the project's admins (`org:projects:administer`, `project:manage`; for the
  Büroablage `org:archiv:manage`) release it, which re-dispatches it with
  screening skipped and records who released it, or delete it. Reviewers get an
  inbox item.
- **What is not screened.** Files with no local text (images, scanned pages,
  plans without a text layer) pass on the name gate alone, and the upload
  summary says the content was not checked. The product owner chose this over
  quarantining every scan or adding local OCR.

### Consequences

* Good, because no matched file reaches an external model on any ingest path, and the next
  caller of `dispatchIngest` is screened by construction.
* Good, because every verdict names its rule, so an office can tune the list rather than
  distrust it.
* Good, because the gates are deterministic, cheap, and need no model in the image.
* Bad, because rules see words and number shapes, not meaning: a fee agreement titled
  „Vereinbarung.pdf" with no configured term in it passes. This is a filter the office
  steers, not a classifier, and the UI must not claim more.
* Bad, because scans and images are only name-checked; an office that needs more needs local
  OCR, which is a separate decision (image size, ingest time).
* Bad, because the name check in the browser is the only one that keeps bytes off our servers;
  the server-side repeat can only refuse to store, after the bytes arrived.
* Bad, because a quarantined file occupies storage quota until someone acts on it.

### Confirmation

* `tests/.../test_screening*.py` (knowledge layer) drive `_run_ingestion` with a matching
  file and assert the OCR, VLM, summary and embedding call sites were never invoked.
* `lib/upload-screening/*.spec.ts` pin the name matcher (compounds, exceptions, umlauts) and the
  server refusal without an override.
* `dispatchIngest` computes the screening rules itself from the document's organization
  (`ingestScreeningFor`, failing closed to the suggested list), so no caller can dispatch
  without them; `service.spec.ts` asserts every dispatch path sends them (5 of 6 cases fail
  with the line removed). A required argument was the first design; it would have had to be
  threaded through eleven callers that cannot know the policy.
* `settings-ownership.spec.ts` asserts the generic settings save refuses `uploadScreening`.

## Pros and Cons of the Options

### A NAT middleware

* Good, because it would be "use NAT as designed" ([ADR-0068](0068-use-nemo-agent-toolkit-as-designed.md)).
* Bad, because it hooks NAT functions; document ingestion does not run through one, so it would
  see the answer, after the model had already read the document.
* Bad, because `pii_defense` is English-only by code (`language="en"`) and output-only.

### A local PII model

* Good, because it finds names and addresses rules cannot.
* Bad, because the NVIDIA model is English-trained and the German-capable one is unevaluated
  here; adopting either means a model in the image and an evaluation first.
* Bad, because a PII detector answers "is there personal data", which every planning document
  has (the client's name, the architect's address). The office's question is "is this an
  invoice or a payroll slip", which is what its own terms answer. Worth revisiting as an
  additional detector, not as the gate.

## Amendment (2026-10-02): chat messages are screened too

### Context

The gates above screened files. What a person types or pastes into the chat
went straight to the model and into the stored history: an IBAN in a question,
a colleague's line with a social-security number in it, a typed answer to
Piloti's question. The product promise does not stop at uploads.

### Decision

Chat text is screened against the **same policy**, with no new setting: the
office's content terms and its detectors (`iban`, `at_svnr`, `credit_card`),
never the name terms, which are for file and folder names and far too broad for
prose. `enabled: false` switches chat screening off with the rest. No new
detector (e-mail, phone, names): the product owner chose the office's list
only.

- **Mask, not refuse, and the person chooses.** Before a message leaves the
  browser the composer says what it found (the office's term, or the kind of
  number with a masked sample, never the value) and offers „Maskiert senden"
  (each match replaced by its placeholder) or „Bearbeiten" (back to the editor,
  text untouched). There is no "send unmasked": the promise is that the model
  never sees it. A typed answer to Piloti's question is screened like a
  question.
- **Server backstop.** A client that skips the composer (an old tab, a script,
  the API) gets the same result without being asked. The chat socket
  (`aiq_api.chat_socket.ChatSocket._masked`) masks the text of every
  `user_message`, `context_only` colleague lines included, its
  `focus_file_name` (client-supplied, and quoted in the system prompt), and
  every typed `interaction_response`, before the agent, its checkpoint or a
  relay replica sees it. The BFF masks every message it stores, **whatever role
  the client gave it** (`createConversationMessages`, the internal persist route
  a job's prompt arrives through), the typed answer to a HITL prompt stored on
  the message (`updateMessageDetail`'s `promptState`, which also carries an
  edited plan, and a `promptState` inside a new message's metadata), and every
  turn it hands to the title model, because the stored history is what title
  generation and memory reflection later send to a model. The role is the
  client's word: a browser can label typed text `assistant`. A `user` message
  is masked in full; any other role against the number checks only
  (`maskAnswerText`), because a content term marks a kind of document while
  the sensitive data is the numbers, and Piloti's answer that names a term
  („Es gibt keine Honorarvereinbarung") should read after a reload as it did
  live. The title model gets every role masked in full. The server never
  refuses a turn for a match.
- **Text that rides into later turns.** A memory note is masked where it is
  written, in `lib/projects/memory-service.ts` (`createProjectMemoryItem`,
  and `updateProjectMemoryItem` for an edit), so the memory panel, the
  organization memory route, the agent's `remember` tool and reflection are all
  masked by construction before the note reaches the embedder or a turn's
  digest. A thumbs-down comment is masked in `submitAnswerFeedback` before it is
  stored, so memory implication's embedding, the lesson pipeline and the
  platform feedback digest read the masked text.
  The `PROPOSAL_DECISIONS` block quotes decided cards in every colleague's
  chat, and a stored card and its decision are the client's word (message
  `metadata` is an open record and the decision PATCH is the browser's), so
  `buildProposalDecisionsBlock` masks each quoted line where it reads it
  (`maskChatText`, under the policy as it stands) rather than trusting any
  writer, and takes `decidedAt` only as a real instant.
- **Placeholders** are domain data, in German, defined once in Python
  (`aiq_agent.common.content_screen.PLACEHOLDERS`) and mirrored in TypeScript:
  `[IBAN entfernt]`, `[SV-Nummer entfernt]`, `[Kartennummer entfernt]`,
  `[Begriff entfernt]`. They are protected regions: no term or detector match
  that overlaps one counts, so masking a masked text is a no-op, whatever the
  office's list holds. That is accepted by design: a text that itself
  contains a placeholder (a document quoting „[IBAN entfernt]" for an office
  whose list holds „IBAN") passes with that word unmasked. Masking repeats to
  a fixpoint, because removing one number can expose another its digits were
  hiding.
- **One matcher.** The matching moved out of the knowledge layer into
  `aiq_agent.common.content_screen` (folding, terms, detectors, spans, masks);
  the ingest screen turns its spans into a verdict, the socket into a mask. The
  chat socket could not import it where it was: anything under
  `knowledge_layer.llamaindex` loads LlamaIndex and Chroma on import (five
  seconds measured), and both consumers already import `aiq_agent.common`. The
  browser runs a TypeScript twin (`lib/upload-screening/content-screen.ts`);
  both read `tests/fixtures/content_screen_cases.json` and must produce the
  same matches, masked text and findings for every case.
- **How the policy reaches the socket: one read per connection.** The socket
  asks `GET /api/internal/chat-screening` for the organization the BFF signed
  into its envelope, once, and keeps the answer for its life; a policy change
  applies from the next connection. Not a field in the signed envelope, which
  was the first idea: the envelope is ONE header line, and the socket's
  handshake parser (`websockets`, under uvicorn's `websockets-sansio`) refuses
  any line over 8192 bytes. A policy may hold 200 terms of 80 characters, and
  the envelope already carries the project context, memory and instructions; a
  long list would have refused the upgrade, which is chat down.
- **Fail closed, twice.** The BFF answers with Piloti's suggested list when it
  cannot read the organization's settings, never with "off". The socket masks
  with every detector and no term whenever it has no answer (no signed
  organization, an older BFF without the route, an error), and asks again on
  its next message. The composer uses the suggested list until the office's has
  loaded.

### Consequences

* Good, because nothing a person types into the chat, a HITL answer, a memory
  note or a thumbs-down comment reaches a model or the stored history with a
  checksum-valid IBAN, social-security or card number, or a term the office
  named. That holds for the chat socket, every message the BFF stores, the
  title model, the memory digest and the embedder. It does not hold for the
  doors listed under "Neutral" below.
* Good, because the person sees what was found and decides, instead of a
  message silently changing.
* Bad, because masking a term hides the word, not the figures around it:
  „Honorarvereinbarung über 12.400 €" becomes „[Begriff entfernt] über
  12.400 €". Rules see words and number shapes, not meaning; the user guide
  says so.
* Bad, because the stored copy of a message from a client that skipped the
  composer differs from what that client shows locally until it reloads.
* Bad, because masking happens on write: chats, notes and comments stored
  before this change, or before the office added a term, keep the text they
  were saved with, and nothing re-masks them.
* Neutral: text a person types that reaches a model by another door is not
  screened by this change: a scheduled task's instruction, a deep-research job
  submitted over the REST API, the organization's standing instructions
  (`lib/org-instructions`), a skill's body (`lib/skills`, also sent to
  `/v1/skills/review`), the project profile (`lib/project-profile`, sent to
  `/v1/generate-summary` and `/v1/consistency-check` and into every turn), and
  a reviewer's comment on a refused draft (`buildReviewDecisionsBlock`, which
  rides the memory channel into the conversation that wrote the draft). The
  user guide names them.

### Why not NeMo Guardrails' sensitive-data rail

Its `input` rail is exactly where a chat check would sit, which is why it was
looked at again. In `nemoguardrails` 0.24.1 (the latest on PyPI, released
2026-09-16, wheel sha256 `4fcfc9d9…31680f`),
`library/sensitive_data_detection/actions.py` hard-codes `language="en"` in both
`detect_sensitive_data` and `mask_sensitive_data`; `_get_analyzer` refuses to
start without the spaCy model `en_core_web_lg`; the rail accepts only the
`input`, `output` and `retrieval` sources, so it has no hook for ingestion; and
per-tenant term lists would be one static `recognizers` entry in a deployment's
`RailsConfig`, not an office's own list. The package also declares
`Requires-Python >=3.10, <3.14`, and this repository runs 3.14. So the check sits
where the rail would, in our own socket, with the office's list and German
folding.

### Confirmation

* `tests/aiq_agent/common/test_content_screen.py` and
  `frontends/ui/src/lib/upload-screening/content-screen.spec.ts` run every case
  of the shared fixture, and assert that a masked text masks to itself. Each
  also holds its whitespace, decimal digits, character classes, fold of every
  code point and IBAN registry to the tables in that fixture, so the twins
  agree on every code point, and masks 300 generated texts twice.
* `frontends/aiq_api/tests/test_chat_socket.py` asserts what the workflow
  (text and focus file name), the agent's history
  (`append_conversation_context`) and a resumed HITL turn receive, and the
  detectors-only fallback.
* `InputArea.screening.spec.tsx` asserts the notice, both buttons, and that
  nothing is sent until one is pressed; `lib/conversations/service.spec.ts`
  asserts the stored copy for every role, the stored HITL answer, and what the
  title model receives, whatever role a turn was given.
* `lib/projects/memory-service.spec.ts` asserts a new and an edited note are
  stored and embedded masked. `lib/feedback/service.spec.ts` asserts the stored
  comment.

## More Information

* Evidence and the two NVIDIA evaluations: `plans/2026-10-01-upload-governance-worklog.md`.
* Triage of the surrounding tickets: `docs/audit/upload-and-filing-triage-2026-10.md`.
