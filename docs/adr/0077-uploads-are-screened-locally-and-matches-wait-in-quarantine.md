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
* `dispatchIngest` takes the screening rules as a required argument, so a caller that has none
  does not compile.
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

## More Information

* Evidence and the two NVIDIA evaluations: `plans/2026-10-01-upload-governance-worklog.md`.
* Triage of the surrounding tickets: `docs/audit/upload-and-filing-triage-2026-10.md`.
