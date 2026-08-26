# Agent onboarding files

`AGENTS.md` is the onboarding guide an agent gets instead of a colleague. There
is one at the root for what is true everywhere, and one per service for what is
true only there. This page is how they are wired, why that wiring is fragile,
and what goes in which file.

## The two-file pattern

Every scope carries two files:

```
<scope>/AGENTS.md    the guide. Every agent reads this
<scope>/CLAUDE.md    one line: @AGENTS.md
```

Claude Code reads `CLAUDE.md` and never `AGENTS.md`. `@path` is its import
syntax, so the bridge file's whole job is that `@`. Written without it, the file
is one line of prose naming a filename, the guide never loads, and nothing
anywhere reports a problem.

That is not hypothetical. The root `CLAUDE.md` in this repo contained the ten
bytes `AGENTS.md\n` for its entire life. Every Claude session ran with the root
guide, obligations table and working style included, silently absent while
`/context` showed a memory file present and healthy. It is the same failure the
skills directory had once before: a committed text file containing a path that
never resolved for anyone.

`scripts/check_agent_docs.py` now fails on a bridge without its `@`, and on an
`AGENTS.md` with no bridge beside it. Both run in `task lint:repo`.

## How the loading actually works

Verified against Claude Code's behaviour in this repo, not inferred:

| File | When it loads |
|---|---|
| Root `CLAUDE.md` and everything it imports | Session start, every session |
| `<scope>/CLAUDE.md` and its import | The first time Claude **reads a file** inside `<scope>/` |

The second row is the one that shapes the writing. A scoped guide arrives *after*
the agent has already opened something, so it cannot be where a rule lives if
that rule has to hold before the first read. It also never arrives at all for a
question answered without opening a file, and other harnesses handle nesting
differently or not at all.

So the root `AGENTS.md` carries a map of the scoped guides and tells the agent to
open the relevant one directly. One read, and the mechanism stops mattering.

## What goes where

The root file is expensive: it loads on every turn of every session, whatever the
task. The scoped files are cheap and precise. Sort by reach, not by importance.

| Put it in | When |
|---|---|
| Root `AGENTS.md` | It bears on work in any part of the repo: setup, working style, release notes, documentation obligations |
| `<scope>/AGENTS.md` | It bears only on that service: its commands, its gates, its traps |
| `docs/contributing/` or `docs/architecture/`, with a one-line pointer | It is project *knowledge* rather than a rule to act on |
| [`gotchas.md`](gotchas.md) | It is a symptom somebody will arrive with |

A rule that reaches one directory costs every session something when it sits at
the root. Move it down. This is why the UI's authorization and card obligations
live in `frontends/ui/AGENTS.md` and the `PYTHONPATH=src` trap lives in
`src/aiq_agent/AGENTS.md` and `tests/AGENTS.md`, rather than all of them at the
root where they started.

## Writing them

`skills/`'s pinned `writing-for-agents` skill is the reference, and it is
installed by `task agents:setup`. The three levers that matter most here:

- **Prune no-ops.** A line telling the agent to do what it already does by
  default spends context on every turn and changes nothing.
- **Do not cache the environment, and do not teach the tool.** `task --list`,
  `package.json` scripts and `--help` output are their own source of truth and
  cannot go stale. An agent knows how to install go-task; what it cannot know is
  that nothing in this repo installs it and that `task setup` runs first. Write
  the second, link the first. The test: if a line would be true in any repo,
  it says nothing about this one.
- **A fixed bug is history.** "Installing only the policy pack used to break a
  fresh clone" stopped being an instruction the day `task setup` installed both.
  Those belong in [gotchas.md](gotchas.md), which is indexed by symptom.
- **Say what to do, not what to avoid.** A prohibition makes the forbidden thing
  more available, not less. "Append new keys below the encrypted block" beats
  "do not reorder keys above them", and a ban earns its place only as a hard
  guardrail stated alongside the positive target.
- **A rule lives in exactly one file.** "Add an environment variable" reaches
  every scope, so it is a root obligation and appears in no service guide. A
  copy in a second guide is one more place to forget when the rule changes.
- **Every obligation names something checkable.** "Run `pytest sources -q` and
  paste the output" is an obligation; "know that no CI job runs it" is a
  feeling. The third column exists to answer *what fails you*, and "Nothing.
  That is the problem" is a legitimate and useful answer.

Keep each file short enough to stay read. Adherence falls off well before a file
gets long, and the root one competes with the actual task for the same window.
**Treat 200 lines as the root guide's ceiling**, which is Claude Code's own
guidance, and pay for a new rule by deleting a stale or duplicated one rather than by
growing the file. The service guides run 30–95 lines and have room.

One thing belongs at the root and nowhere else: **the list of one-way doors.**
"Finish the task" tells an agent not to stop for permission on reversible work,
which is only safe if the irreversible set is written down. It is a table in
`AGENTS.md`, and each row names the safe form beside the writing one.

## Keeping them honest

- A change to behaviour a guide describes updates the guide in the same commit.
  Stale guidance is worse than none: an agent acts on it.
- `task lint:repo` runs `scripts/check_agent_docs.py`, `scripts/check_adrs.py`
  and `scripts/validate_skills.py`.
- When a human has to intervene to tell an agent something this repo could have
  said, that is a failure signal, and the fix belongs in one of these files
  before the task continues. See
  [the correction ratchet](correction-ratchet.md#human-intervention-is-a-failure-signal).
