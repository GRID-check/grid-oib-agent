# The correction ratchet

A **ratchet** turns one way and cannot slip back. Every correction in this repo
should click it once: fix the output, then close the layer that let the output
through. A correction that changes only the output leaves the layer exactly as
it was, so the same class of error is free to recur, and the next person pays
for it again.

One manual correction is fine. The second one is the signal, and recurring
manual correction is waste.

## When to reach for this

Three moments, and only these:

1. A human corrected you. Reviewer comment, a "no, not like that", a revert.
2. Something surprised you. The code did not do what the name said, a config
   was not where it should be, a test passed that should not have.
3. You corrected yourself twice for the same reason inside one task.

Moment two is the one people skip. Surprise is the cheapest available evidence
that a layer is missing, and it expires: an hour later you have absorbed the
oddity and it reads as normal.

## The move

Fix the immediate thing first. Then answer one question and act on the answer:

> Which layer would have had to be different for this correction to be
> unnecessary?

Name that layer, change it in the same pull request, and say in the PR body
which layer you closed. The correction is ratcheted when a **second occurrence
would be caught by something other than a person noticing**. If a person
noticing is still the only defence, the ratchet has not clicked.

## Which layer to close

| What went wrong | Layer to strengthen | Where that lives here |
|---|---|---|
| The behaviour was never pinned down | Written spec, or an up-front question instead of a guess | The task's own brief; `AskUserQuestion` when the readings diverge materially |
| Domain context was missing | Repository documentation or an ADR | `docs/architecture/`, `docs/adr/` |
| The same implementation error, again | An instruction, a skill, or a lint rule | `AGENTS.md`, `.agents/skills/`, ruff and eslint config |
| A regression nobody caught | A deterministic gate | A test in the suite `task verify` runs |
| The environment, not the code | The environment contract | `Taskfile.yml`, `.devcontainer/`, `deploy/compose/` |
| An unsafe decision was reachable at all | A boundary that refuses it | A database CHECK or foreign key, an RLS policy, a permission rule |

Prefer the lowest row that fits. A rule in `AGENTS.md` asks every future reader
to remember something. A CHECK constraint asks nobody. Both are ratchets, but
one of them holds while people are tired.

## What this repo already does

`documents.documents_session_requires_conversation`
(`frontends/ui/src/lib/db/schema/documents.ts`) is the pattern at its best. A
session-scoped document must have a conversation and must not have a project.
Nothing violated that when the constraint was written. One function was simply
careful, and the constraint exists because "one function is careful" is a
convention, not an invariant, and the next writer would have been one column
away from silently orphaning objects in two stores. The lesson was moved out of
a person's head and into the schema, where it cannot be forgotten.

Its neighbour `documents_folder_id_project_id_fkey` is the same move: a
composite foreign key so that "a folder belongs to the document's own project"
is checked by PostgreSQL rather than remembered by a service.

## Where it stops

Ratcheting is not an excuse to widen a pull request without limit.

- One layer per correction. If closing it properly is its own piece of work,
  open an issue that names the layer and link it from the PR.
- Do not add a rule that restates a default. A line telling the agent to do what
  it already does costs context on every turn and changes nothing. Test it by
  running the document, not by arguing about it.
- Prefer strengthening an existing layer over adding one. Sediment is what you
  get when adding always feels safer than removing.
