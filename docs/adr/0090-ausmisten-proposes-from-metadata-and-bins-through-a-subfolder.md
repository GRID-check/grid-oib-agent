---
status: accepted
date: 2026-10-06
decision-makers: product owner (Matthias), Grid engineering
consulted: Grid engineering
informed: everyone working in this repo
---

# „Ausmisten" proposes from metadata, and bins through a subfolder of each document's folder

## Context and Problem Statement

The product owner, 6 Oct 2026, for closing a project: "We go over documents
using AI and clean out all working copies and other stuff that isn't useful
anymore, but you can override it." Binding: Piloti proposes (working copies,
superseded drafts, duplicates, temporary files, never-published agent drafts),
the person closing reviews and can override every item, nothing is removed
without that confirmation, removal means the Papierkorb (14 days, restorable),
the proposal uses only what is already indexed and screened and sends no new
document content to a model, it is offered only among documents the closer may
read and write, it is labelled as an AI proposal (EU AI Act Art. 50), a failed
model call falls back to rules, and the decision is audited.

Two facts of the code shaped the answer. A model is reached only through the
Python backend (`/v1/generate-summary` is the pattern). And the Papierkorb holds
FOLDERS (ADR-0087, migration 0114): deleting a single document is immediate and
final, with no bin.

## Decision Drivers

* Nothing reaches a model that ingestion did not already send.
* No removal widens anyone's access, even for a moment, and none is final for 14 days.
* The proposal must survive the model being down.
* Reuse the Papierkorb's guarantees (chunks purged at once, restore re-ingests, legal holds, purge) rather than build a second bin.

## Considered Options

* **Bin through a subfolder of each document's own folder** (chosen).
* A document-level Papierkorb (a binned state on `documents`).
* Delete the chosen documents outright.

## Decision Outcome

**The proposal** (`POST /api/projects/{id}/cleanup/proposal`, `proposeCleanup`)
needs document write on the project, so a closed project has none. It is a POST
because it starts a paid model call, which a prefetch or a retried navigation
must never trigger. It considers the documents whose folder the session may
read and WRITE (`getProjectFolderAccess`, `levelOf === 'write'`), at most 2,000,
leaving out every document the content gate holds in quarantine (ADR-0085): it
waits for a reviewer, not for a clean-out. For each it takes what the index already
holds: name, folder path, type, the tags and the one-line summary ingestion
wrote (as every file listing reads them), the editorial state, the author, the
upload date. Two sources, merged per document:

* the rules (`lib/projects/cleanup-rules.ts`): Office and LibreOffice lock files,
  temporary and system files, „Kopie von"/„- Kopie"/„(1)" names, names marked
  `_alt`/`_old`, the same `content_hash` as an earlier upload, an older numbered
  version beside a newer one in the same folder, and a Piloti draft never
  published. Always computed;
* the model, through `POST /v1/cleanup-proposal` (`frontends/aiq_api`), for the
  documents whose screening passed (`clean`, or `released` by a reviewer) and no
  others: one screened partly, not at all or not yet is proposed by the rules
  alone. The endpoint takes exactly those fields (`extra="forbid"`: a document carrying anything
  else is refused) and answers ids, categories and one-sentence reasons. Ids it
  invents are dropped there, and ids the session may not write are dropped in
  the BFF. Fail-soft: no credential, an upstream error or unparseable JSON is
  an empty proposal with an error code, and the rules stand in. The response
  says which (`aiUsed`, `aiError`).

**The decision** is the person's. The close dialog lists every item, marked
„KI-Vorschlag" where the model gave the reason, with a notice saying how the
proposal was made, or that only rules made it. Everything starts selected and
every item can be deselected. Closing without removing anything is always one
button.

**Into the Papierkorb** (`POST /api/projects/{id}/cleanup`, `confirmCleanup`).
Every chosen document is checked again (in the project, readable and writable).
For each folder they are in (the root counts as one), a subfolder „Ausgemistet
<date>" is created inside it, the documents are moved there, and the subfolder
goes to the Papierkorb (`moveFolderToBin`). A subfolder that inherits has exactly
its parent's readers and retrieval collection, so the move changes nobody's
access and re-ingests nothing; the bin purges the chunks at once; a restore
puts the subfolder back in its original folder.

All or nothing. The folder, move and bin services each own their transaction,
and the bin's includes the backend's chunk purge, so no single database
transaction holds them. Everything is checked before anything changes; then
every subfolder is made and filled, then every one is binned. When a step
fails, what was done is undone in reverse: binned subfolders restored (and read
back into the index, audited as the restore it is), documents moved back to
their folders, the subfolders removed (`deleteEmptyCreatedFolder`, only a
living, empty one). The person sees that it failed; the project is as it was
and stays open. When an undo step fails too, every failed step is logged and
the person is told that files may still be in a folder „Ausgemistet <date>"
inside their folder or in the Papierkorb (`details.reason:
'cleanup-partially-undone'`, `details.folders`), with the original status.

A subfolder goes to the bin only holding exactly the documents moved into it
(`moveFolderToBin`'s `onlyDocuments`, checked inside its transaction under the
project's bin lock, which every insert or move into a folder also takes). A
file someone else filed into „Ausgemistet <date>" between the move and the bin
is therefore never binned with it: the bin answers 409
`folder-contents-changed`, and the clean-out is undone, leaving that file where
its author put it.

The audit event is written after the clean-out has committed, through
`recordAuditEvent`, which never throws (it logs a failed emit;
`lib/audit/service.spec.ts`), so a failing audit cannot turn work that happened
into an error. Audited, when it succeeded, as `project.cleanup.confirmed`: how many were removed and proposed, how many the
person removed without a proposal and kept against one, whether the model's
proposal was shown, and the ids.

### Consequences

* Good, because every guarantee of the Papierkorb applies unchanged, and no new deletion path exists.
* Good, because the model sees only what the index already holds, and the request model refuses more.
* Bad, because a restored document comes back in a subfolder „Ausgemistet <date>" of its folder, not in the folder itself; moving it back is one step.
* Bad, because one Papierkorb entry per source folder, not per document; restoring is per folder.
* Neutral: superseded versions WITHIN one document are not proposed; a version cannot go to the bin on its own.

### Confirmation

`lib/projects/cleanup.integration.spec.ts` on real Postgres (the subfolder inherits, the restricted
collection is unchanged, binned and hidden, restored into its original folder, nothing removed when
one document is not the closer's, a purge refused on the second folder leaving every document,
folder and bin entry as it was, and a subfolder holding a file nobody moved there refused by the bin), `cleanup-service.spec.ts` (only read-and-write documents whose
screening passed, and only their metadata, reach the model; quarantined ones are not proposed;
fallback; audit; undo after a failed move or bin; each subfolder binned only with what was moved
into it; the error naming the folders when the undo stops short), `cleanup-rules.spec.ts`, `close-project-dialog.spec.tsx`
(AI label, override, nothing before confirmation, the proposal asked with a POST), `frontends/aiq_api/tests/test_cleanup_proposal.py`.

## Pros and Cons of the Options

### A document-level Papierkorb

* Good, because a document would come back exactly where it was.
* Bad, because every read path — listings, search, the agent's retrieval — would have to learn a second hidden state, the risk ADR-0087 avoided by purging chunks instead.
* Bad, because it duplicates the bin, its purge, its holds and its restore.

### Delete outright

* Bad, because the product owner asked for the Papierkorb, and a wrong proposal accepted in haste would be final.

## More Information

* [ADR-0088](0088-a-closed-project-is-read-only-and-open-to-the-office.md) (closing), [ADR-0087](0087-folder-access-is-read-write-per-role.md) (folders, the Papierkorb).
* User guide: [`user-guides/projects.md`](../user-guides/projects.md#closing-a-project).
