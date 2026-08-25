---
status: proposed
date: YYYY-MM-DD
decision-makers:
consulted:
informed:
---

<!--
MADR 4 (Markdown Any Decision Record). Copy this file to
`NNNN-short-kebab-title.md` and fill it in.

Take NNNN from `python3 scripts/check_adrs.py --next`, which reads the
directory. Four collisions in this repo (0027, 0039, 0044, 0047) came from two
people reading the README index on the same day.

`status` takes one of: proposed | rejected | accepted | deprecated |
superseded by ADR-NNNN. Qualifications belong in Consequences, not in the
field — `scripts/check_adrs.py` parses it and the index legend mirrors it.
`date` is the date of the CURRENT status, not of the first draft.

Add the row to `README.md` in the same commit; the checker fails without it.
The ADRs numbered 0001–0049 predate this template and keep their own shape.
Delete these comments as you go.
-->

# Short title, naming the problem and the chosen solution

## Context and Problem Statement

<!--
Two or three sentences, or a short story. What is true today, and what makes
the status quo untenable? If a number drove this — a cost, a latency, a failure
rate — give it here with where it was measured. A reader two years out is
deciding whether your forces still hold, and cannot do that from adjectives.
-->

## Decision Drivers

<!-- The forces that actually constrain the choice. Delete if there are none worth naming. -->

*
*

## Considered Options

<!-- Name them all here, including "do nothing" when it was a real candidate. -->

*
*

## Decision Outcome

Chosen option: "", because .

### Consequences

<!-- One bullet each, and be honest about the bad ones. An ADR with no "Bad, because" was not a decision, it was a preference. -->

* Good, because
* Bad, because

### Confirmation

<!--
REQUIRED here, and the section most often skipped. Name what will catch the
next person doing it the other way: a CHECK constraint, a coverage spec, a type
that will not compile, a CI job, a lint rule. This is the correction ratchet
applied to a decision — see docs/contributing/correction-ratchet.md.

When nothing enforces it yet, write exactly that: "Nothing enforces this yet;
review is the only gate", and open the gap under More Information. An honest
"nothing" is useful. A silent nothing reads as "enforced" to everyone after you.
-->

## Pros and Cons of the Options

<!-- One subsection per option that deserves the space. Delete the section for a decision with one obvious winner. -->

###

* Good, because
* Neutral, because
* Bad, because

## More Information

<!--
Anything left: what would make us revisit this (the falsifiable trigger — "if
write throughput passes ~2k/s", "if we add a second country profile"), open
follow-ups, links, and the discussion this came out of. A reader who sees the
trigger has fired knows to supersede this rather than work around it.
-->
