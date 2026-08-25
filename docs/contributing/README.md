# Working practices

How we work on Grid: the conventions, obligations and quirks that are not
visible from the code. [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) is the
entry point for setup, branching, commits and the merge gate. This directory
holds the depth behind it.

| Page | What it covers |
|---|---|
| [working-style.md](working-style.md) | The cases behind the four rules in `AGENTS.md`: what each one cost before it was written down |
| [testing-and-verification.md](testing-and-verification.md) | `task verify` as the merge gate, which task to run while iterating, and the traps the task list cannot tell you about |
| [code-conventions.md](code-conventions.md) | House rules with a history: the `any` ban, coercing raw `sql<T>` results, where a shared helper belongs, the capability doctrine |
| [release-notes.md](release-notes.md) | reno mechanics, what makes a note customer copy, publishing and the translation cache |
| [correction-ratchet.md](correction-ratchet.md) | Closing the layer that allowed an error, instead of only fixing the output |
| [documentation.md](documentation.md) | Which doc to update for which kind of change, and why that is part of the change |

## Adding to this directory

A practice belongs here when it is true of *how we work* rather than of *how the
system is built*. System behaviour goes to `docs/architecture/`; a decision with
consequences goes to `docs/adr/`.

The test that something belongs here: you explained it to somebody, or you would
have to explain it again next month. Write it down once, link it from
[`../../AGENTS.md`](../../AGENTS.md) only if an agent must act on it mid-task,
and keep the pointer to one line.
