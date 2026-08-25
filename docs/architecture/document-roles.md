# Document roles

Which file plays which part in a project.

## The gap this fills

The wizard asks the architect to "Bebauungsplan ablegen", and every feature
downstream of that question — extracting the B3 Kernset, reviewing what was
extracted, the completeness checklist, the agent's project context — needs the
answer to *which file is the Bebauungsplan*. Before roles, nothing in the repo
could hold that answer.

Three labels already existed, and each fails differently:

| Label | What it is | Why it cannot answer |
|---|---|---|
| `tags` (`document_classification.ALLOWED_TAGS`) | Content labels, LLM-guessed at ingestion, many-to-many | Three files can carry "Bebauungsplan": the real one, a scan of the neighbour's, and a PDF of the legal text. Nothing says which governs, and a guessed tag carries no user commitment |
| `doc_class` ("Dokumentart") | Single-valued and human-set | It is the norm-hierarchy axis driving retrieval lanes for the BASE corpus. A project's Bebauungsplan has no lane to sit in |
| folders | User-arranged filing | A renameable string. Reading a role out of a folder name is inference-from-a-name, the move ADR-0047 exists to delete |

A role is a fourth axis: a **declared, scoped binding** between a document and a
slot in the project model.

## Shape

`document_roles` (migration 0063) is a join table, not a column, because the
binding carries four things a column cannot:

1. One document can fill several roles — a combined Lageplan-and-Bebauungsplan
   PDF is one file and two roles.
2. One role can be filled by several documents — a Bestandsplan set is a dozen
   sheets.
3. The binding has its own provenance: who declared it, when, and whether a
   person confirmed it or a classifier guessed it.
4. The binding is **scoped**. "Bestandsplan of Bauwerk bw2" is not a project
   fact, and a project mixing a Neubau and a Bestand is what the intake concept
   exists for.

`confidence` is `declared` or `suggested`, deliberately mirroring the profile's
own `facts`/`assumptions` split. That is what makes the handover concept's
`dokument_ungeprüft` state expressible without a fourth answer mode: an
extracted value is an assumption whose evidence is a `suggested` binding.

The composite foreign key to `documents(id, project_id)` makes "a role binds a
document in its own project" a database invariant rather than a service
convention, the same pattern `documents_folder_id_project_id_fkey` uses. Both
key columns are NOT NULL, so MATCH SIMPLE never skips the check. Archiv and
session documents have no project, so they cannot hold a role without first
being filed into one — the correct rule, not a limitation.

## Where the pieces live

| Concern | Module |
|---|---|
| Vocabulary, scope and cardinality rules | `lib/project-profile/document-roles.ts` |
| Storage | `lib/db/schema/document-roles.ts`, migration `0063` |
| Queries | `lib/document-roles/repository.ts` |
| Authorization and the rules | `lib/document-roles/service.ts` |
| Routes | `app/api/projects/[id]/document-roles/` |
| The agent's block | `lib/document-roles/prompt-section.ts` (pure) and `prompt-loader.ts` (I/O) |
| Wizard field and Modul I | `features/projects/components/document-role-field.tsx`, `projektgrundlagen-step.tsx` |
| Shared client state | `features/projects/lib/use-document-roles.ts` |

## Rules the service enforces

- **Cardinality by replacement.** Declaring a second Bebauungsplan replaces the
  first rather than rejecting, because the real case is "the old one was
  superseded". What it displaced is returned, so the UI can name the document
  that stopped being the Bebauungsplan.
- **Idempotence.** Re-declaring an existing binding is a no-op, not a unique
  violation.
- **Membership before the foreign key.** The FK would reject a foreign document
  as a constraint violation; checking first answers "that file is not in this
  project", and catches the soft-deleted case the FK cannot see.

## What the agent is told

Appended to the project prompt view at read time, not baked into the stored
view, because a binding changes without the profile changing:

```
documents:
- Bebauungsplan: B-Plan 1042 · Plandokument
- Bestandspläne (Hoftrakt): 47 Dokumente, 2 davon nicht bestätigt
documents_missing:
- Schadstoffgutachten
```

### It carries the shape, never the list

One line per filled **slot** (a role at one scope instance), whatever that slot
holds: the document's name when it holds one, a count when it holds more. The
block is therefore `O(roles × scope instances)` and independent of file count —
a 1000-file project and a 3-file project produce blocks of the same order.

That distinction is the design. Knowing there are 47 Bestandspläne for the
Hoftrakt is worth its tokens on every turn; knowing *which* 47 is worth nothing
until the agent is working with them, and costs 47 lines × ~5 prompt templates ×
every turn, including chit-chat. The first version emitted a line per binding,
which is the same unbounded growth `_available_documents_limit` in the chat
researcher already exists to prevent.

A `MAX_SLOT_LINES` cap sits behind that as a backstop for an implausible number
of buildings, and a truncation says so rather than shortening silently: an agent
told "these are the documents" while some were withheld reasons as though the
withheld ones do not exist.

`documents_missing:` is the half that earns its tokens. An agent cannot notice
the absence of a line, so an unattached Bebauungsplan is named explicitly and
the answer can be conditional instead of reading as though the plan had been
consulted. Only *recommended* roles are reported missing — telling the agent
that a project with no demolition lacks a Schadstoffgutachten is noise on every
turn.

Declaring or revoking a role invalidates the prompt-view cache, so a document
attached now is not unmentioned for the five minutes the cache would otherwise
hold.

## Recommendations are data

`recommendedWhen` on a role uses the same condition language and the same
evaluator as the intake questions (`evaluateIntakeConditions`). Modul I's
adaptive checklist and its "dringend empfohlen" flag are therefore data, not
bespoke UI code, and cannot drift from what the questions believe about a
project. A `bauwerk` condition is evaluated per building, so a project with one
Bestand and one Neubau recommends Bestandspläne for the first only.

## Open

- **Extraction** (the concept's Phase 2) is not built. Its shape is decided:
  extraction rows keyed by `(document_id, question_id)`, values landing as
  profile *assumptions* whose evidence is the binding, promoted to facts by the
  review screen.
- **Retrieval** does not filter by role yet. Roles could ride the same channel
  `folder_path` already uses into chunk metadata.
- **A per-role retrieval tool.** The context deliberately tells the agent that a
  slot holds 47 documents without naming them, which leaves it no way to reach
  the 47. A NAT tool taking `(role, scope_instance?)` and returning that slot's
  documents is the missing half: the block says what exists, the tool fetches it
  when there is a reason to. Until it exists, the agent can still reach those
  files through ordinary retrieval — it just cannot ask for them *by role*.
