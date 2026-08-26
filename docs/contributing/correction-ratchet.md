# The correction ratchet

A **ratchet** turns one way and cannot slip back. Every correction in this repo
should click it once: fix the output, then close the layer that let the output
through. A correction that changes only the output leaves the layer exactly as
it was, so the same class of error is free to recur, and the next person pays
for it again.

Recurring manual correction is waste. When the correction came from a person,
the first one is already the signal.

## Human intervention is a failure signal

The strongest evidence a layer is missing is that a person had to step in.

An intervention is not a normal part of the loop. It means the agent was about
to proceed, or had already proceeded, on something the repo could have told it
and did not. The intervention is the cheapest possible detection of that gap,
and it is also the most expensive to repeat: it costs a human's attention every
single time. So treat the first one as the signal, not the second.

The move is the same as any other correction, with one addition. **Write the
learning down before you carry on with the task.** The intervention arrives
mid-work, which is exactly when it is tempting to act on it and move on. Acting
on it fixes this run. Writing it down fixes every run.

Two questions, both answered in the same pull request:

1. What did the person know that the repo did not say?
2. Where would they have expected it to be said?

Answer two literally. If they told you to run a setup command, the answer is
"at the top of the file an agent reads first", and the fix is to put it there
rather than to remember it. A learning that lives only in the transcript is gone the
moment the session ends, which makes the next agent re-earn it from the same
human.

The worked example is this repo's own: an agent was told, mid-task, to run
`task setup` and to note it at the top of `AGENTS.md`. The underlying gap was
that `AGENTS.md` named `task verify`, `task fe:types` and a dozen other
commands without ever saying that `task` is not installed by anything in the
repo and that `task setup` has to run first. Every agent before that one had
either guessed or asked. The ratchet was a Setup section as the first thing in
the file, not a note to self.

## When to reach for this

Three moments, and only these:

1. A human intervened. A reviewer comment, a "no, not like that", a revert, or
   a mid-task instruction. See [above](#human-intervention-is-a-failure-signal):
   this one counts from the first occurrence.
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
| The same implementation error, again | An instruction, a skill, or a lint rule | `AGENTS.md`, `skills/`, ruff and eslint config |
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

## When the layer cannot be closed

Some failures have no layer you own: a bug in a third-party CLI, a rate limit on
somebody's registry, an invisible character in a file. Those go in
[gotchas.md](gotchas.md), indexed by the symptom you arrived with. That is the
weakest ratchet, because it still needs a person to read it, which is exactly
why it is the fallback rather than the default. It still beats nothing: the
second person to hit it spends a minute instead of an afternoon.

Keep the entry when you later close the layer properly, and say what closed it.
Somebody on an old branch will still meet the old symptom.

## Where it stops

Ratcheting is not an excuse to widen a pull request without limit.

- One layer per correction. If closing it properly is its own piece of work,
  open an issue that names the layer and link it from the PR.
- Do not add a rule that restates a default. A line telling the agent to do what
  it already does costs context on every turn and changes nothing. Test it by
  running the document, not by arguing about it.
- Prefer strengthening an existing layer over adding one. Sediment is what you
  get when adding always feels safer than removing.
