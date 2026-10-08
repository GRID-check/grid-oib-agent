---
status: proposed
date: 2026-10-08
decision-makers: Matthias Bigl
consulted:
informed:
---

# Comments state the present; history lives in commits and ADRs

## Context and Problem Statement

Most of this repository is written and read by agents, and an agent acts on the
comment in front of it. Across the tree, comments and docstrings narrated how
the code got here: what it used to do, which review found a defect, the PR or
ticket that changed it, the day a rule took effect. A sweep over every tracked
source file rewrote or removed history in 933 of them.

A history sentence costs the reader twice. It competes with what is true for
attention, and it is stale the moment the next change lands, because nobody
updates a story about the past. Where it carried a reason that still holds, the
reason was buried inside the story.

Where does the account of how code got to its present shape belong?

## Decision Drivers

* A comment is read as an instruction about the code now; anything else in it
  is noise an agent may act on.
* History is needed sometimes, and has homes that keep it accurate: the commit
  that made the change, and the ADR that made the decision.
* The rule has to hold without anyone remembering it.

## Considered Options

* Comments state the present and the reason; history lives in commits and ADRs,
  enforced by a hook
* The same rule as a convention only
* Allow history in comments, dated

## Decision Outcome

Chosen option: "Comments state the present and the reason; history lives in
commits and ADRs, enforced by a hook", because the convention alone had already
failed at the scale above, and a dated story is still a story the reader has to
filter out.

* A comment or docstring says what the code does and why it is that way. A
  still-true reason stays; the story around it goes.
* The change itself is told in its commit message. A decision is told in its
  ADR, and a comment may point at that ADR by number.
* Not history: a date that is a domain or fixture fact, an example in quotes or
  backticks, a file path, a measurement that justifies a current bound, stored
  data that live code still reads ("a legacy row").
* A test's name states the behaviour it pins, by the same rule.

### Consequences

* Good, because a comment can be taken at its word, and a correction to the code
  cannot leave a contradicting story behind.
* Good, because the reason for a choice is stated plainly instead of inside an
  anecdote.
* Bad, because the gate reads phrasing, not meaning: it refuses only
  unmistakable history ("used to", a change date, "found by a review", a PR
  number), so a story told without those words passes and review catches it.
* Bad, because a measured number stays in a comment without the date it was
  measured on; the commit that recorded it holds the date.

### Confirmation

* `scripts/check_history_comments.py`, run by the `history-comments`
  pre-commit hook and therefore by `task lint:repo` and CI's repo-lint. It reads
  comments and docstrings of Python, TypeScript, JavaScript, YAML, shell and
  TOML, never strings or code. `--broad` adds the phrases that are history only
  sometimes, for a person sweeping files.
* `tests/test_check_history_comments.py` pins what it refuses and what it
  leaves alone.
* Test names are not checked; review holds them to the rule.

## More Information

The rule for contributors:
[`docs/contributing/code-conventions.md`](../contributing/code-conventions.md#comments-say-what-is-true-now).
