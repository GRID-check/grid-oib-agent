---
status: accepted
date: 2026-10-13
decision-makers: Grid engineering, on the product owner's delegation (2026-10-13)
consulted: product owner
informed: everyone working in this repo
---

# A document is a timeline of Fassungen, and approval is a separate round

## Context and Problem Statement

One document in Piloti carries seven state dimensions today, spread across
three stores and joined by file name: the reading status (`documents.status`,
open text, 14 declared values, five of them meaning "indexed"), the content
check (recorded in five places), the Freigabe state (`document_versions.state`),
the item lifecycle, the same-name history (BFF, by document id), the history
across file names (`document_metadata.superseded_by` in the knowledge database,
by file name, with `document_fassung_retained` so a purge does not lose it), and
whether the document is in the index at all (derived from authorship, a
`piloti/` name prefix and the `stored` status). A Piloti report in its third
version with an older linked document shows nine indicators at once in the
preview. People cannot tell which one answers the question they have.

The cause is one key and one fused column:

* **The index knows a file only by its name.** Chunks and the metadata row are
  keyed by `(collection, filename)`. Two Fassungen under one name cannot both be
  indexed, so publishing purges the old chunks and reads the new bytes again
  (ADR-0054). A link across names can only live where the name key lives, in the
  knowledge database (ADR-0099). Piloti's own files need a name prefix so they
  do not collide.
* **History and approval share one state.** ADR-0054 put "which bytes are live"
  and "who vouched for them" into `document_versions.state`, so every person's
  upload is born `approved` by its uploader, and a Fassung under another file
  name can have no state at all.

The fused model also produced bugs that were each fixed on their own: an agent
refusing a revision because its cached copy of the state said `in_review`, an
archived document still shown as citable, a published Piloti report shown as
„nicht in der Wissensbasis“. ADR-0054 and ADR-0099 were both right about the
problem they had. Together they give one idea, "this is a newer state of that
document", two incompatible homes.

The office's own model is simpler. A document has Fassungen. One of them is
current. The older ones are there on request. Some Fassungen need a colleague's
sign-off before they count.

## Decision Drivers

* The guarantee from ADR-0054 must survive: nothing Piloti wrote answers a
  question until a person approved it, held by the database.
* Citations, shares, assignments, chat subjects and folder placement bind a
  `documents.id` and must keep resolving (ADR-0099's driver).
* A wrong link between two files must be cheap to undo (ADR-0099's driver).
* No file is read twice for bookkeeping. Reading is the expensive step.
* Held documents never reach a model or a reader who may not see them (ADR-0086,
  ADR-0087).
* One word per concept on every surface, and at most three indicators on a
  document at once.
* The agent must be able to say what changed between two Fassungen, from the
  same facts the UI shows.

## Considered Options

* **Keep both models and polish the UI.** Rename words, merge badges, leave the
  storage as it is.
* **Make the cross-name link a BFF table** and keep ADR-0054's fused state.
* **Three nouns, an index keyed by Fassung, and approval as a separate round**
  (this record).

## Decision Outcome

Chosen option: "Three nouns, an index keyed by Fassung, and approval as a
separate round", because it is the only option that removes the second history
model instead of hiding it. Polishing the UI leaves every bug above one refactor
away from coming back. A BFF link table moves the link but still needs the purge
and re-read, the `stored` special case and the synthetic approval on uploads.

### The model

| Noun | Table | Holds | Does not hold |
|---|---|---|---|
| **Dokument** | `documents` | identity, name, folder, Dokumentart, roles, shares, assignments; `current_version_id`; `archived_at` | bytes, reading status, screening |
| **Fassung** | `document_versions` (kept, extended) | one immutable set of bytes; `seq` within the document; the file name it arrived under; Stand (Index or date); origin (`upload`, `draft`); reading status; screening verdict | approval |
| **Freigabe** | `document_version_reviews` | one review round on one Fassung: who asked, whom, outcome (`requested`, `approved`, `changes_requested`, `rejected`), comment | the history |

Names in code are English (repository rule), so the tables keep the names
`document_versions` and `document_version_reviews`; „Fassung“ and „Freigabe“
are the words a reader sees.

### The rules

1. **Current is a pointer, not a state.** `documents.current_version_id` names
   the Fassung Piloti answers from. Older and newer are read from `seq` against
   it. There is no `superseded` state and no `superseded_by` link.
2. **Every Fassung that is read stays in the index, keyed by its id.** Being
   read and being found are two things. A person's upload is read when it
   arrives; a `draft` Fassung only once a person approved it (rule 4); a
   Fassung kept out on purpose stays `not_read` (rule 8). Once read, its
   chunks stay, whether or not it is current. Chunks and the
   knowledge layer's metadata row carry `version_id` and `document_id`. Search
   filters to current Fassungen by default; naming a file or a Fassung reads an
   older one, as `read_passage` already allows. Making a Fassung current flips
   that filter, so nothing is purged or read again, and switching back is
   instant. The chunks of a Fassung go with an archive or a delete of the
   document, and nowhere else.
3. **A person's upload becomes current once it is read**, not when it lands.
   Until then the previous Fassung keeps answering, and the UI says so. A failed
   read leaves the previous Fassung current.
4. **A Fassung that began as a draft becomes current only through an approved
   review.** Its origin is `draft`: Piloti wrote it, or a person forked it to
   revise through review. A person's upload is `upload`. The origin records how
   the Fassung began, not who typed the bytes, because a person's fork is
   reviewed exactly like Piloti's draft. A CHECK plus the guarded
   `UPDATE … WHERE` that sets the pointer refuse a `draft` Fassung without an
   `approved` round. This is ADR-0054's chain ("indexed ⟹ published ⟹ approved
   by a person") restated for the new tables: a `draft` Fassung is indexed only
   while it is current or was current.
5. **Freigabe is one step.** „Freigeben“ approves the Fassung and makes it
   current. ADR-0054 kept `approved` and `published` apart for "approve on
   Tuesday, issue with the Einreichung on Friday"; in practice an approved file
   that Piloti does not use confused people, because „freigegeben“ means usable.
   Issuing to an authority is a different act (sending, Einreichung) and gets
   its own feature when an office asks for it.
6. **A person's upload has no review unless somebody asks for one.** „Zur
   Freigabe vorlegen“ is available on any Fassung; an organization may later
   require it for chosen Dokumentarten. No upload carries an approval nobody
   gave.
7. **A file under another name is attached, not linked.** Confirming „B ist eine
   neuere Fassung von A“ moves B's Fassungen into A's timeline (new `seq`
   numbers after A's) and makes the newest of them current under rule 3. B's
   `documents` row stays as an alias (`merged_into_id = A`), out of every
   listing, so a citation, share or chat subject naming B resolves to A for a
   reader who may open A. B's shares and assignments move to A. Nothing is read
   again, because chunks belong to the Fassung.

   The attach writes one `document_attachments` row that keeps what the inverse
   needs: B, the Fassungen moved with their `seq` on B, B's and A's
   `current_version_id` before the attach, and the shares and assignments moved
   from B. Detaching applies that row backwards in one transaction: the
   Fassungen return to B with their old `seq`, B's pointer is restored, A's
   saved pointer is restored only while A still points at the Fassung the
   attach made current (a Fassung that became current on A since stays
   current), the moved shares and assignments return to B unless a person changed them on A since, the
   alias is lifted, and the row is closed. Only the latest attach of B can be
   detached; a Fassung added to A after the attach stays on A.
8. **The reading status is a closed set on the Fassung,** with a CHECK:
   `waiting`, `reading`, `ready`, `failed`, `held`, `not_read`. `held` is the
   content check's hold and the only place it is recorded; the verdict columns
   say why. `not_read` is a Fassung deliberately kept out of the index (a Piloti
   Fassung under review, a deep-research PDF, an archived document).
9. **Piloti's text before filing is an Arbeitsdatei**, not an Entwurf. Filing it
   creates a `draft` Fassung with an open review round, through one route that
   the agent and the browser both call (ADR-0055). The agent reads the live
   state from that route; it keeps no copy of it.

### Comparing two Fassungen, for the agent and the UI

A compare is a workspace primitive with one implementation (ADR-0055). It lives
in the knowledge layer as a pure module, `fassung_diff`, over facts already
stored, and has two clients: the agent, through `list_files(fassungen_of=…,
compare_to=…)`, which calls the module in-process the way the chain itself is
read (a mode of the browser rather than a tool of its own, because every bound
tool's schema rides on every turn, the reason ADR-0099 gave), and a route the
BFF calls for the UI.

It answers in rising cost, and stops where the caller asks it to:

| Layer | Reads | Says | Model call |
|---|---|---|---|
| Title block | `revision_facts` of both | Index, date, scale, title, document number: what moved | No |
| Pages | the indexed text of both, page by page (`collection_pages.read_pages`) | pages added, removed, changed, unchanged; for a changed page the changed lines; values that changed („Fluchtweglänge 38 m → 42 m“) | No |
| Words | both descriptions | the change summary that ingestion or a confirmation already writes | Already paid |
| Marks | one page of both, rendered | boxes on what changed, with a sentence each (`fassung_compare`, today's route) | One vision call per page, cached |

Pages are aligned by page label first and by order second, so a sheet inserted
in the middle shifts nothing after it. The deterministic layers are cached by
the pair of Fassung ids; the marks keep today's cache. The agent gets a bounded
report (pages and values first, the summary after, the marks only when it names
a page), labelled as a comparison of indexed text, not of the drawing itself.

The tool can ship before the index is keyed by Fassung: Fassungen under
different file names are both indexed today. Same-name Fassungen join it once
rule 2 lands.

### What a person sees

| Concept | Word | Shown |
|---|---|---|
| One state of a document | Fassung („Fassung 3 von 3“, its Index or Stand) | always, in the header and the timeline |
| The one Piloti answers from | aktuell | on that row; the header says which one while a newer one waits |
| Reading | Wird gelesen · Lesen fehlgeschlagen · Zurückgehalten | only while it is not `ready` |
| A review round | Wartet auf Freigabe durch …, Änderungen angefordert, Abgelehnt | only while a round is open or was the last thing that happened |
| Out of the working set | Archiviert | in place of everything else |

Retired from the surfaces: Veröffentlicht, Ersetzt and Stillgelegt as state
words, Abgelegt as a status, Entwurf for the chat file, Quarantäne and
Ausgeschlossen in copy, and every one of the internal status spellings.

### Consequences

* Good, because one history model remains, in one database, joined by id.
  `superseded_by`, `document_fassung_retained`, the name-keyed joins, the purge
  and re-read on publish and the `piloti/` filename namespace are deleted.
* Good, because "what did it say in March" and every compare work without
  reading a file again.
* Good, because the agent can answer "what changed between B and C" from page
  text and title blocks, cheaply and the same way the UI does.
* Good, because no upload carries an approval nobody gave, and „freigegeben“
  means what it says.
* Bad, because every Fassung stays in the vector store. A project re-uploading
  large drawings often grows its index; archive and delete stay the only purge.
  If storage becomes the limit, older Fassungen can drop their embeddings and
  keep their text, without changing the model.
* Bad, because the knowledge layer has to learn a second key. The chunk
  metadata, the metadata row, the lexical mirror and every purge change, and the
  backfill must map each existing row to its current Fassung exactly once.
* Bad, because rule 7 adds an alias row, and every resolver of a document id has
  to follow it. This is the cost of attaching instead of linking.
* Bad, because dropping the two-step publish removes a state some guides
  describe. A later need for scheduled issue gets its own record.

### Confirmation

Each rule lands with the gate that keeps it, slice by slice:

* Rule 4: a CHECK and a guarded pointer update, exercised by `task db:test:rls`
  and a spec that tries to make an unapproved `draft` Fassung current.
* Rule 8: a CHECK on the reading status; `document-status.spec.ts` keeps
  failing for an undeclared writer until the column cannot hold one.
* Rule 2: a knowledge-layer test that a search without a file name returns only
  current Fassungen, and one that a purge on publish no longer happens.
* Rule 7: a spec that every document-id resolver follows `merged_into_id`
  (`document-visibility.spec.ts` grows the case).
* The compare: planted changes in a two-Fassung fixture, scored for pages and
  values found; the marks keep their Langfuse generation.

Until a slice lands, its rule has no gate of its own: Nothing enforces this
yet; review is the only gate. The gap per rule closes with the slice named
under More Information, and each slice's PR names the gate it adds.

## Pros and Cons of the Options

### Keep both models and polish the UI

* Good, because it is cheap and touches no data.
* Bad, because the seven dimensions stay in storage, and every one of the bugs
  listed above came from storage, not from copy.

### A BFF link table, ADR-0054 kept

* Good, because history across names moves into one database.
* Neutral, because the timeline query gets simpler.
* Bad, because two kinds of history remain, and publish still purges and reads
  again, since the index key is still the file name.

## More Information

Supersedes in part:

* ADR-0054: the fused `state` column, the born-approved upload, the separate
  publish step and purge on publish. Kept: the database-held guarantee, the
  actor rule on the transition table, superseded bytes stay.
* ADR-0099: the link on the knowledge layer's row, and the "older Fassungen
  are left out of search by a link" mechanism. Kept: a person confirms every
  Fassung across names, and the suggestions (name grammar, title block, judge)
  are only suggestions.

Both are marked superseded when the first slice that replaces their mechanism
lands, not before.

Slices, each shippable on its own:

1. Fix what the fused model broke (an agent revision refused on a cached state,
   an archived document shown as citable, a failed file never retried, a
   published Piloti report shown as unindexed).
2. The compare over the layers above (`list_files(compare_to=…)`), for
   Fassungen under different names.
3. The closed reading status with its CHECK, over today's seven spellings on
   `documents.status` (`uploaded`, `pending`, `processing`, `completed`,
   `failed`, `quarantined`, `stored`). The names in rule 8 arrive with slice 4,
   when the status moves onto the Fassung, so the column is renamed once.
4. `document_versions` gains the bytes' reading status and screening, and
   `document_version_reviews` takes the review rounds; the item drops its
   mirrored byte columns; the synthetic approval on uploads goes.
5. The index keyed by Fassung; the backfill; search filters to current.
6. Attach instead of link; `superseded_by` and `document_fassung_retained` go.
   The vector payload's `superseded` flag is computed from `superseded_by`
   (ADR-0114); this slice recomputes it from the timeline in the same change.
7. One filing door, the Arbeitsdatei, and the surfaces and words above.

Revisit rule 2 if vector storage per organization becomes a cost driver, and
rule 5 when an office asks to approve and issue on different days.

[`docs/architecture/fassungen.md`](../architecture/fassungen.md) describes what
runs today and points here; it changes with each slice.
