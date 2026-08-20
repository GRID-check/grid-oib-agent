# Piloti in the File System — Design Spec

> Piloti can read the office's files. It cannot write one. This spec designs the
> write side as a substrate rather than a tool: one namespace, one write path,
> one authorization decision, one lifecycle — mounted under every agent, not
> only the deep researcher.
> Status: **DESIGN** (nothing here is built). Depends on nothing; §9 is
> deliberately sequenced so phase 0 ships alone and deletes no existing path.

## 0. The one-sentence goal

Everything Piloti produces should be an **object in the same file system the
architect already browses** — addressable, previewable, versioned, filterable,
and visibly *not yet* the office's word until a human says it is.

## 1. What exists today

Four file systems, none of which is the one the user sees, plus a fifth that
exists only as a stream.

| # | Store | Who writes | Agent's access | Durability | Visible to user |
|---|---|---|---|---|---|
| 1 | **The estate** — `documents` + `project_folders` + SeaweedFS + Chroma + `document_metadata` | the user, through the BFF | read, and only through retrieval (`knowledge_search`) or `surface_documents` | permanent | yes — the Files/Archiv panes |
| 2 | **Run scratch** — DeepAgents `StateBackend` (`deepagents_runtime.py`) | the deep researcher | full read/write | the run | no |
| 3 | **Skills mount** — `FilesystemBackend(/skills/, virtual_mode=True)` + the `skills` table | this repository / an org admin | read | permanent | partly (org rows) |
| 4 | **Memory** — `project_memory` rows | agent (`remember`), user | insert, never update | permanent | yes — memory panels |
| 5 | **Work products** — BCF export, Raumbuch, Massenermittlung, the deep-research report, every card | the agent, per request | writes them to a *stream* | **none** | for one screenful |

Three properties fall out of that table and they are the whole problem:

1. **The only store the user browses is the only one the agent cannot write.**
2. **The only store the agent can write freely dies with the run** — and is
   invisible while it lives, so a 20-minute deep-research job is a black box
   that happens to be writing an outline, notes and a draft the whole time.
3. **Everything the agent produces on purpose is store #5** — a Prüfbuch, a
   Flächenaufstellung, a 30-source research report. Each is computed
   server-side over real data, rendered once, and then unaddressable. The
   architect's response to a good one is to screenshot it.

Store #4 is the exception that proves the design: memory is durable, curated,
provenanced, supersede-able agent output — and it took a whole subsystem
(`project-memory-design.md`) to give the agent *one* durable write of *one*
shape. Every further shape of durable output would need its own table, its own
panel, its own card and its own deletion path. That is the cost this spec exists
to stop paying.

### 1.1 What the agent can see of the estate

`available_documents`: a capped, flat list of `(file_name, summary, tags,
doc_class, display_title, collection, shelf)` rendered into the prompt every
turn. No tree, no folders, no sizes, no authorship, no history — the folder
hierarchy the user builds in the sidebar does not reach the model at all. The
agent knows *that* files exist and roughly what each says. It does not know
where anything is filed, and it cannot put anything anywhere.

## 2. The design that suggests itself, and why it is wrong

The obvious move is to hand the agent `write_file(path, content)` against the
`documents` table, the way DeepAgents' `FilesystemBackend` hands it a directory.
Four things break, in increasing order of severity.

**It writes into the evidence corpus.** Ingestion is not optional in this
product: a written file becomes chunks, chunks become retrieval hits, hits
become citations. An agent that can write into `proj_<id>` can cite itself.
Turn 3 asserts a fire-compartment area; turn 9 retrieves that assertion as
project knowledge and reports it with a green *Projektwissen* badge. Nothing in
the pipeline distinguishes it from a Gutachten a Ziviltechniker stamped. This is
not a hypothetical failure of a rare prompt — it is the *default* behaviour of a
write-capable agent over its own RAG corpus, and it converts a hallucination
into a durable, cited, screenshot-able document. Call it the **ouroboros
failure**; everything in §5 exists to make it unrepresentable.

**It makes prompt injection a write.** Today the worst a malicious sentence
inside an uploaded PDF can do is steer an answer, which the user reads. With an
unqualified write tool it can file, rename, retag or overwrite the estate, and
the user reads nothing. The blast radius of injection is exactly the width of
the write surface.

**It has no undo.** `documents.filename` is the join key to the object *and*,
as `(collection_name, filename)`, to every chunk in the index — which is why the
schema already forbids renaming it and added `display_name` instead. An
in-place overwrite orphans chunks or, worse, leaves stale ones addressable under
a name whose bytes have changed. The existing code comment for `storage_bucket`
makes the same point from the other side: the identity of a stored object is not
allowed to be re-derived.

**It has no ceiling.** ADR-0042 records that nothing limits how many bytes a
tenant can store, and that the only backstops fail cluster-wide. A user uploads
at human speed. An agent in a loop does not.

So: not a tool. A substrate, with the four answers designed in.

## 3. Primitive 1 — one namespace, and the path is the address

Every readable or writable thing gets a path in **one** tenant-rooted namespace.
The path is not a convenience over ids; it is the address, the way
`buildModelHref` made every IFC view an address and thereby made links, cards,
chips and deep-links fall out of one decision (`backend-deep-dive.md` §6c).

```
/projects/<slug>/files/…              project shelf          (documents, scope='project')
/projects/<slug>/models/<name>/…      IFC models             (structured, read-only)
/projects/<slug>/work/…               NEW: Piloti's desk     (agent-authored)
/projects/<slug>/views/<name>.view    NEW: saved filters     (§7)
/projects/<slug>/memory/…             memory, projected      (read-only view of rows)
/archiv/…                             Büroarchiv shelf       (documents, scope='archiv')
/threads/<conv>/…                     chat-private shelf     (documents, scope='session')
/skills/…                             org + platform skills
/law/oib/…                            the corpus             (global, read-only)
run:/…                                this run's scratch     (StateBackend, ephemeral)
```

**The shelf becomes a path prefix.** ADR-0047 already decided that a document's
shelf must travel as data and that every prefix-guessing table gets deleted; a
path is that data in the one form the model can *name* and the UI can *route*.
The four vocabularies ADR-0047 enumerates collapse into one string that is
simultaneously the DB scope, the retrieval collection, the citation label input,
and the URL.

### 3.1 A mount is a capability, not a directory

Each mount carries explicit bits, resolved per principal from the signed request
context (`X-Grid-Request-Context`, `backend-deep-dive.md` §2b):

| Mount | list | read | search | write | organize | delete | promote |
|---|---|---|---|---|---|---|---|
| `/law/oib` | ✓ | ✓ | ✓ | — | — | — | — |
| `/projects/*/files` | ✓ | ✓ | ✓ | — | ✓¹ | trash¹ | — |
| `/archiv` | ✓ | ✓ | ✓ | — | ✓¹ | trash¹ | — |
| `/threads/<conv>` | ✓ | ✓ | ✓ | ✓ | ✓ | trash | ✓ |
| `/projects/*/work` | ✓ | ✓ | ✓ | ✓ | ✓ | trash | ✓ |
| `/projects/*/models` | ✓ | ✓ | ✓ | — | — | — | — |
| `/projects/*/memory` | ✓ | ✓ | ✓ | ✓² | — | — | — |
| `/skills` | ✓ | ✓ | — | —³ | — | — | ✓³ |
| `run:/` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

¹ organizing and trashing *user* files is a proposal, never an application (§6).
² writes land as `remember` does today — a row, through the BFF.
³ an agent may propose a skill; it may never write its own instructions (§8).

The mount table **is** the authorization decision. A path outside it does not
resolve to a 403 — it does not exist for this principal, and `fs_list` never
names it. This is the difference between a check at the leaf and a namespace
that was assembled from the caller's authority in the first place; the first is
where confused-deputy bugs live, the second has nowhere to put one. It is also
the existing doctrine one level up: the signed collection scope is already
described as *the authorization ceiling, not the turn's search set*.

## 4. Primitive 2 — nodes, versions, blobs, refs

Four things the current schema conflates into `documents.filename`, separated:

| Concept | Is | Mutable | Identity |
|---|---|---|---|
| **blob** | bytes in SeaweedFS, keyed by `sha256` | never | content |
| **version** | `(node, blob, author, message, created_at)`, append-only | never | its own id |
| **node** | the addressable thing: path, name, kind, tags, folder | yes | a uuid, stable across every rename and move |
| **ref** | node → current version | yes, by moving | — |

What this buys, none of it as a feature to build later:

- **Undo is a ref move.** "Piloti overwrote my Brandschutzkonzept" is not
  representable: the previous version is still the same immutable blob.
- **Diff is free**, which is what makes a version history worth showing, which
  is what makes an agent write reviewable at all.
- **Re-embedding is keyed by blob hash**, so a re-file, a rename or a
  no-op rewrite costs nothing in the index — the same instinct ADR-0027 already
  applied to VLM captions.
- **`display_name` stops being a special case.** It was migration 0048's
  correct answer to "identity is not label"; here the node holds the label and
  the blob holds the identity, so the general form needs no exception.

**Reads are consistent with the node store, not the index.** An agent must be
able to `fs_read` what it just wrote, in the same turn, without waiting on
chunking, VLM enrichment or embedding. Retrieval catches up asynchronously
under the existing `pending → processing → processed | error` status, and
`fs_search` says so when a node in scope is not yet searchable rather than
silently returning less. Nothing else in this design is allowed to make the
agent poll its own writes.

## 5. Primitive 3 — the write ladder, and the ouroboros rule

Three tiers. The tier decides the authorization, the durability, and — the part
that matters for this product — **whether the content may be treated as
evidence**.

| Tier | Path | Authorized by | Lives | Indexed | Citable |
|---|---|---|---|---|---|
| **scratch** | `run:/` | nobody; the agent's own desk | the run | no | no |
| **work** | `/projects/*/work`, `/threads/<c>` | the agent, inside quota | until GC or promotion | yes, provenance-tagged | **no** |
| **estate** | `/projects/*/files`, `/archiv`, `/skills`, profile, memory | **a human click** | permanent | yes | yes |

The line between *work* and *estate* is the line between "a thing Piloti made"
and "a thing the office asserts". In a product whose output ends up in an
Einreichung, that line is the entire safety story, and it is worth stating as
three invariants rather than as a policy that lives in a prompt:

> **I1 — No self-grounding.** Unpromoted agent-authored content is never
> retrieved as evidence: `fs_search` filters on `authored_by = 'agent' AND
> promoted_at IS NULL` at the retrieve site, not in a re-ranker and not in a
> prompt. Promoted agent-authored content stays retrievable and stays
> **labelled** — its chunks carry the provenance into the context block and into
> the citation chip, and it may never be the sole ground for a legal claim. The
> label is permanent; promotion changes who vouches for a document, never who
> wrote it.
>
> **I2 — Promotion is a human act, and it is recorded.** Moving a node from
> *work* to *estate* happens through the interactive-card path (ADR-0030), so
> the decision persists on the message, is idempotent, and re-renders as
> decided. The agent's tool result must say what §6 says: nothing was saved.
>
> **I3 — Promotion changes provenance, not content.** The promoted node keeps
> its version history and its `authored_by = 'agent'`, and gains
> `promoted_by`/`promoted_at`. The office asserting a document is a *separate
> fact* from Piloti having written it, and both stay true forever.

The product already has the vocabulary to render this without inventing
anything: the design language's provenance signals are the only chroma in the
app. Agent-authored work sits in `--source-auto` grey (*automatisch*); promotion
is the moment it becomes `--source-project` green (*Projektwissen*) or
`--source-office` gold (*Büroarchiv*). Colour never travels alone, so the chip
carries the word too — and the word is the honest one.

An agent that "organizes the Archiv" therefore produces a **proposal** — a batch
of moves the user applies or discards in one action — because organizing another
principal's files is an estate write.

### 5.1 Authorization is commissioned or confirmed, never absent

I2 says a human authorizes every estate write. It does not say *when*, and the
difference is the whole ergonomics of the feature.

| Invocation | Deliverable | Default destination | Authorization |
|---|---|---|---|
| **Deep research** (chat or job, `jobs.output = 'deep-research'`) | one report | **`/projects/<p>/files/`**, into a folder named on the submit form | **commissioned** — the run was requested with a form that showed where the report will land |
| Shallow / chat turn | any work product | `/projects/<p>/work/` | **confirmed** — the agent offers `fs_publish`, the user clicks |
| Compliance run, BCF export, take-off, Raumbuch | export node | `/work/` | confirmed |
| Job with `output = 'chat'` | a conversation | — | — |

The asymmetry is not an inconsistency; it is the consent following the cost.
Commissioning a deep-research run is a deliberate act with a form, minutes of
compute and a budget draw behind it — the user has already said "produce me a
report", and a modal afterwards asking whether they meant it is a dialog that is
only ever answered yes. A chat turn is cheap and continuous, so a file appearing
in the project from one is a surprise, and surprises ask.

What makes the commissioned case safe is that the destination is **shown before
the run, not after**: the submit form names the path, so the authorization is
informed, and the report arrives with its provenance chip grey (I1, I3) even
though it is filed in the project. The user's own default is settable per
project; the shipped default is the one above.

### 5.2 The deep researcher already has the file system — it is thrown away

`writer-agent` writes `/shared/output.md`; `_extract_final_markdown` reads that
file out of the run state, returns it as the answer, and the whole
`StateBackend` — the outline, the per-subagent notes, the draft, the sources
file — is discarded with the run
(`agents/deep_researcher/agent.py`, `deepagents_runtime.py`). There is even a
fallback that mines the last assistant message when the file is missing, which
is the system telling us that the file, not the message, is the real artifact.

So phase 1 is smaller than it looks:

- `run:/` **is** that `StateBackend`, mounted rather than hidden. Streaming its
  writes to the work drawer makes a 20-minute job watchable for the cost of the
  tool calls it already emits.
- `/shared/output.md` stops being extracted-and-discarded and becomes a
  **commit**: one node, one version, at the destination the submit form named.
- Everything else in the run stays in `run:/`, is browsable while the job lives,
  and is garbage-collected after — unless the user keeps it, which is one
  `fs_publish` away.

The report also stops being un-resumable. A job that dies at minute 18 today
returns nothing; a job whose desk is durable leaves a readable draft.

## 6. Primitive 4 — the tool surface

Eight verbs. The count is a design target, not an accident: SWE-agent's ACI
result is that agents fail on interfaces that are broad, chatty, or silent about
their effects, and improve measurably when a write is *validated before it
lands*.

| Tool | Signature | Notes |
|---|---|---|
| `fs_list` | `(path \| view, depth)` | tree or filtered set; one compact row per node: name, kind, tags, size, author, version, one-line description |
| `fs_read` | `(path, section \| range)` | windowed; returns the anchors it read **and the version id** |
| `fs_search` | `(view, query)` | semantic + lexical inside a selector; returns passages with citation anchors; obeys I1 |
| `fs_write` | `(path, content, message, base_version?)` | creates a new version; `base_version` **required** when the node exists |
| `fs_edit` | `(path, base_version, patches[])` | ordered exact-string replacements, each matching exactly once |
| `fs_organize` | `(ops[])` | move / rename / retag, batched; **cannot alter content** |
| `fs_publish` | `(path, target)` | proposes promotion; renders the card; applies nothing |
| `fs_trash` | `(path)` | soft, reversible; hard deletion stays the purger's (ADR-0011) |

Four properties of the surface, each answering a known failure:

**`base_version` is read-before-write, made mechanical.** Claude Code states the
invariant as a rule the model must follow; optimistic concurrency states it as a
precondition the write cannot dodge, and turns two agents in two chats editing
one node from a silent lost update into a retryable error.

**Exact-string patches** are Claude Artifacts' `update` semantics, and they are
the right primitive here for the same reason: a 40-page Prüfbuch should not be
regenerated to change one Gebäudeklasse, and a patch that matches twice is a bug
the tool can catch and a full rewrite cannot.

**Validators are guardrails, per node kind.** A `.view` must parse as a
selector; a `SKILL.md` must pass the strict skill schema the substrate already
enforces; a report carrying cards must validate against the card union. The
write is rejected *with the validator's message*, which is the ACI paper's
lint-on-edit result applied to this domain — and the repo already validates
skills strictly rather than warn-and-continue, so the posture is established.

**Every mutating tool returns the new state, not "OK".** Path, version, bytes,
what changed, what it now costs to read. Informative-but-concise feedback is the
third ACI principle and the cheapest one to get wrong.

**`fs_organize` cannot alter content — by construction.** The filesystem-memory
literature's sharpest finding is *organization degeneracy*: agents asked to
restructure a store condense it and silently drop detail, and the fix the
authors needed was an explicit "keep every fact" rule in the prompt. A rule in a
prompt is a rule that fails on a bad day. Splitting reorganization from
authorship makes the lossy reorganization unrepresentable instead.

## 7. Primitive 5 — filter, scope and view are one object

"Show me every Brandschutz-Gutachten from the last quarter" is today three
different mechanisms: an instant substring filter in `file-browser-pane.tsx`, a
`POST /api/documents/search` vector call, and — for the agent — `surface_documents`,
which returns at most three tiles and is explicitly *not* a catalogue. None of
the three produces something the user can keep.

A **selector** is one declarative object:

```jsonc
{ "shelf": "project", "under": "/projects/hofgasse/files/Gutachten",
  "tags": ["Brandschutz", "Gutachten"], "author": "user",
  "created_after": "2026-05-01", "semantic": "Fluchtweglänge",
  "order": "created_at desc", "limit": 50 }
```

with four consumers and one meaning:

1. `fs_list` / `fs_search` — the agent's window.
2. The Files pane — the chips light up; **the agent's filter becomes the user's
   filter**, editable in place. This is the artifact quality: the answer to a
   filtering question is an object you keep manipulating, not a list you re-type.
3. A URL — because every view being addressable is what already made IFC links,
   cards and chips fall out of one decision.
4. A **retrieval scope** — `ceiling ∩ selector` is exactly the shape
   `shelves_for_turn` already implements for `focus_file_name` / `focus_shelf` /
   `source_preset`. Generalizing those three ad-hoc intents into one selector is
   a simplification, not a new mechanism.

Saved to `/projects/<p>/views/<name>.view`, a selector is a **smart folder**:
durable, nameable, shareable, and usable as "answer only from this set". The
compliance-workspace vision's "one dataset, two lenses" is this primitive —
a board is a view grouped by requirement, a folder is a view grouped by path.

## 8. Primitive 6 — what may become instructions

A file the agent wrote and later reads is data. A file the agent wrote and later
*loads as instructions* is a persistence mechanism for prompt injection, and it
is the one place a filesystem for agents differs categorically from a filesystem
for people.

> **I4 — Instruction-bearing mounts are never agent-writable, and content read
> from agent-writable mounts is never treated as instructions.**

Concretely: `/skills` is proposal-only for every principal that is not a human
admin, because a skill body is injected into future turns for the whole
organization. Ditto the project profile — which is why the IFC `profile` op
already routes its suggestions through the `project_profile_patch` card rather
than writing them, and why that precedent is the right one to generalize rather
than an exception to work around.

## 9. Primitive 7 — budget, sprawl, and decay

| Failure | Control | Precedent |
|---|---|---|
| A loop writes 10⁴ nodes | per-run node + byte budget, failing loudly to the trace | the LLM usage ledger (ADR-0015) |
| A tenant fills the cluster | per-org storage quota, enforced at the write | demanded by ADR-0042, still open |
| Work products accumulate forever | TTL on unpromoted work nodes → the existing `deletion_queue`, with notice | ADR-0011 |
| The tree rots as it grows | the digest is *ranked*, not exhaustive; depth is capped | the arXiv finding that taxonomy adherence erodes with size |

On sprawl, the literature is unambiguous and worth designing for rather than
discovering: weaker models produce 114 files where stronger ones produce 16, and
store shape tracks the *model* more than the material. So the shape of Piloti's
desk must not be load-bearing. Two rules follow: retrieval into `/work` is by
selector and search, never by the agent remembering where it put something; and
the default context is a bounded digest (§10), so a sprawling desk costs disk,
not context.

## 10. What the model sees by default

`available_documents` becomes a **rendered digest** of the mounted namespace:
bounded, ranked by relevance to the turn, one line per node — path, kind, tags,
author, and a one-line description. Below that, the current view. Nothing else.

The description field is what makes a file system legible to a model at all —
it is the same L1/L2 progressive disclosure the skills substrate already uses
(`description` in the prompt, `body` only via `use_skill`). For uploads the
existing summarizer writes it; for agent-authored nodes the author writes it,
and a write without one is rejected by the validator. A file nobody can describe
in a line is a file nobody will find.

## 11. What this unifies

| Today | Becomes |
|---|---|
| `available_documents` (flat, capped, prompt-rendered) | `fs_list` over the mounted namespace + the digest |
| `surface_documents` (≤3 tiles, its own scoring constants) | `fs_list(view)` → the Files pane, filtered |
| `/api/documents/search` vs. the substring filter | one selector, two execution strategies |
| `focus_file_name` / `focus_shelf` / `source_preset` | one selector, intersected with the ceiling |
| BCF export, Raumbuch, take-off, deep-research report | nodes: `/work` by default, the project shelf when the run was commissioned for it (§5.1) |
| Per-shape write endpoints (memory, profile, tags, folders) | `fs_write` + `fs_publish` + the card |
| Deep-research `StateBackend` scratch | `run:/`, same backend, now one mount among several |
| Skills as rows *and* files, with two loaders | nodes under `/skills`, one resolver, origin as metadata |

Nothing in the middle column requires deleting the left column on day one; §12
sequences it so each phase stands alone.

## 12. Phases

**Phase 0 — read, unified (no writes).** The mount table, the selector, `fs_list`
/ `fs_read` / `fs_search` over the existing tables, and the view URL. Ships one
user-visible thing: asking Piloti to filter the file system filters *the file
system*, with the chips lit, instead of returning three tiles.
*Acceptance:* `surface_documents`' three tuned constants are deleted, not
reimplemented, and the Files pane's filter state round-trips through a URL the
agent can emit.

**Phase 1 — `/work` and the node/version/blob store.** `fs_write`, `fs_edit`,
`fs_trash`, budgets, validators, the work drawer. `run:/` is the existing
`StateBackend`, mounted and streamed. Not indexed. `/shared/output.md` is
committed as a node instead of extracted and dropped; the Prüfbuch, the BCF
export and the take-off land beside it.
*Acceptance:* a 20-minute research run is watchable as files appearing on a
desk; killing the run at minute 18 leaves a readable draft, where today it
leaves nothing.

**Phase 2 — provenance-aware retrieval, promotion, and the deep-research
default.** `/work` gets indexed under I1; `fs_publish` renders the card; version
history and one-click revert. Only now does the commissioned default of §5.1
switch on — a report may be filed straight into `/projects/<p>/files/` exactly
when the labelling that keeps it from impersonating evidence exists, and not one
phase earlier.
*Acceptance:* a hostile test in which the agent writes a false claim into
`/work` and is then asked the same question cannot produce a citation to itself;
and a commissioned report in the project corpus renders grey, never green.

**Phase 3 — organize, saved views, skills-as-nodes.** `fs_organize` as batched
proposals, `.view` nodes, `/skills` unified behind one resolver.
*Acceptance:* the two prefix tables ADR-0047 wants dead are gone, and a folder
reorganization is a single reversible action in the activity feed.

## 12b. What we should not build ourselves

The primitives in §3–§7 decompose into a layer that is generic (paths, mounts,
routing, patching, atomic-ish writes) and a layer that is entirely ours
(provenance, the ladder, tenancy-derived mounts, the ouroboros rule). Only the
second is worth writing.

| Package | Where | What it gives us | Verdict |
|---|---|---|---|
| **fsspec** — `AbstractFileSystem`, `DirFileSystem`, chained URLs (`zip://…::s3://…`), `MemoryFileSystem`, transactions, callbacks, a filesystem registry | Python. **Already in `uv.lock` at 2026.4.0**, pulled in by dask, llama-index and huggingface-hub | The backend interface and the path plumbing, including semi-atomic writes (`with fs.transaction:`) and a plugin registry we would otherwise reinvent | **Adopt.** A mount becomes an fsspec filesystem; `DirFileSystem` is the subtree wrapper; zero new dependencies |
| **deepagents backends** — `CompositeBackend`, `StateBackend`, `FilesystemBackend`, `StoreBackend`, and the `ls/read_file/write_file/edit_file/glob/grep` tool surface | Python. Already a dependency, already wired in `deepagents_runtime.py` | The agent-facing shape, sub-agent file sharing, and the route table this design's mount table already resembles | **Adopt as the agent-facing shape.** One `GridBackend` implementing the backend protocol is the whole integration for the deep researcher |
| **unstorage** (unjs) — unix-style **driver mounting**, metadata, watching, 20+ drivers, ~5 kB core | TypeScript, i.e. the BFF, which is where writes actually execute | The same mount routing on the single-writer side | **Adopt cautiously.** It is a key–value store with mountpoints, not a versioned file system: use it for routing, keep node/version/ref in Drizzle |
| **Cloudflare `computer`** — a Workspace whose authoritative state is SQLite in a Durable Object, with execution backends (container FUSE mount, isolate with workspace-backed `node:fs/promises`) as lazily-connected **projections** of it | TS / Workers; preview quality | Architectural confirmation, and the right answer for the sandbox | **Borrow the architecture.** State is authoritative in the store and every runtime is a projection — so Modal becomes a projection of a selected subtree, synced back through the version machinery, not a second world with its own disk |
| **lakeFS** — git-like commits, branches, rollback as a metadata layer over S3 | a Go server in the storage path | Commit/rollback over object storage | **Borrow, don't adopt.** The commit idea is §4; branches and merges are what §13 rejects, and a metadata server in the data path re-solves what ADR-0043's per-tenant buckets already solved |
| **PyFilesystem2** — `MountFS`, `MultiFS`, `SubFS` | Python | The cleanest naming of the mount idea | **Borrow the vocabulary**; fsspec has the ecosystem |
| **LangGraph `BaseStore` / `PostgresStore`** — namespaced persistence with semantic search | Python | Cross-session key–value persistence | **Avoid as the store of record**: no versions, no provenance, no tenancy beyond the namespace tuple. We have Postgres and RLS |
| **`jsonpatch`** (already used by `project_profile_patch`), `diff-match-patch` / `unidiff` | both | Patch application and history rendering for `fs_edit` | **Adopt.** Hand-rolled patch application is how exact-match edits become silent corruption |
| **MCP filesystem server + roots** | any | A reference tool surface and the root-scoping contract | **Borrow now, expose later.** Once the primitives exist, `gridfs` as an MCP server is how anything outside Piloti mounts the estate |
| **S3 / SeaweedFS object versioning** | infra | A server-side version chain per key | **Verify before relying on it.** ADR-0042 established that the pinned SeaweedFS *accepts* SSE headers it does not implement; the same discipline applies here. The version chain lives in Postgres regardless, so this is an optimization |

What none of them gives us, and what therefore defines the code we write:
provenance as a column, the three-tier ladder, mounts derived from a signed
tenancy envelope, I1's retrieve-site filter, and the selector that is
simultaneously a filter, a view, a URL and a retrieval scope.

## 13. Alternatives considered

**Mount the estate into the Modal sandbox and give the agent a shell.** Rejected:
the sandbox is network-blocked and job-scoped by design, a POSIX mount gives up
provenance and versioning at the moment of the write, and `rm -rf` over a
tenant's Einreichung has no undo. Copy-in / copy-out of an explicit selection is
compatible with this design and is the right shape if execution is wanted later.

**Make it a git.** Rejected as the *interface*, kept as the *idea*: content
addressing, immutable history and refs are all here. Branches and merges are
not, because an LLM resolving a merge conflict inside a Brandschutzkonzept is a
liability, and because linear per-node history is what a revision-stamped plan
set actually is.

**Let the agent write as the user.** Rejected: it is precisely the confused
deputy. The agent already holds a *narrower* principal than the user — org-wide
memory writes are denied to it by default and escalate to a card — and that
existing asymmetry is the correct precedent, not an inconvenience.

**Keep proposing everything through cards.** Rejected: it does not scale past
one write per turn, and a deep-research run that writes 30 notes would render 30
confirmations. The ladder keeps the card exactly where a card belongs — the
estate boundary — and nowhere else.

**Expose it as MCP resources.** Rejected as the primary interface: MCP resources
are application-driven and read-oriented (`resources/list`, `resources/read`),
which is the wrong half of the problem. Worth adopting from it: URI-as-identity,
resource templates, `lastModified`/`priority` annotations, and the explicit rule
that a `file://`-shaped resource need not be a physical file.

**One appendable markdown file per project ("AGENTS.md for the project").**
Rejected for the reason the memory spec already gives: an append-only blob
degrades into contradictory noise within a dozen turns. Nodes, versions and
supersession are what make dedup and provenance possible.

## 14. Prior art

| Source | Taken |
|---|---|
| SWE-agent, *Agent-Computer Interfaces* (arXiv 2405.15793) | few, compact verbs; informative-but-concise feedback; **guardrails that reject a bad write** — their lint ablation is worth ~3 points |
| Claude Artifacts | create / update / rewrite; exact-string replacement matching exactly once; private-by-default with publishing as a separate act |
| Claude Code's file tools | read-before-write as a hard precondition; windowed reads with anchors |
| DeepAgents backends | `CompositeBackend` route table — the mount table is this idea with capability bits and a tenancy story |
| Letta Filesystem / MemFS | folders as an org-wide taxonomy attachable per agent; a *window* into a file rather than the whole file; git-backed memory |
| *Filesystem-Based Memory for LLM Agents* (arXiv 2607.26637) | organization degeneracy; file sprawl tracking model capability; organization pays for search cost, not answer quality — hence §9's "shape must not be load-bearing" |
| Cloudflare `computer` | the store is authoritative and every execution environment is a *projection* of it, connected lazily — which is why the sandbox stops being a second file system |
| MCP resources | URI-as-identity; templates; annotations; resources need not be files |

## 15. Open questions

1. **Does memory become files?** Recommendation: no. Memory's value is dedup,
   supersession and salience — row machinery — and §13's blob argument applies.
   Project it read-only under `/memory` so one namespace still answers "what does
   Piloti know", and leave the writes where they are.
2. **German paths?** The UI is German; paths are ASCII and stable. A node's
   `display_name` is already the localized label. Probably right, unconfirmed.
3. **Two chats writing one node.** `base_version` makes it an error rather than
   a loss, but the UX of that error is undesigned.
4. **Does an evidence link (file ↔ requirement) belong on the node or beside
   it?** The compliance-workspace vision needs it many-to-many; this spec does
   not decide it.
5. **What is the GC notice?** An unpromoted work node expiring silently is a
   small betrayal; expiring loudly is a notification nobody asked for.

## 16. How we would know it worked

- A deep-research run is watchable, resumable and leaves a durable, linkable
  object behind — measured as: the report is still openable a week later,
  by URL.
- The ouroboros test (§12 phase 2) fails closed, in CI, forever.
- `surface_documents`' scoring constants, the two ADR-0047 prefix tables, and
  the split between substring and semantic search are **deleted** — the
  acceptance test for a unification is that the thing it unified is gone.
- Asking for a filtered set of files produces a filter, not a list.
