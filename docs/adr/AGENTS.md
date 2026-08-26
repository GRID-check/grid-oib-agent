# Writing a decision record: `docs/adr`

An ADR captures one architecturally significant decision with the forces that
produced it, so the rationale outlives the people and the branch. Costly to
reverse is the bar: a new service or datastore, an external dependency, the
auth/tenancy/security model, a data-model change, a cross-cutting pattern, or
anything that changes a public contract.

## Writing one

```bash
python3 scripts/check_adrs.py --next     # the next free number, read from disk
cp docs/adr/0000-template.md docs/adr/NNNN-short-kebab-title.md
python3 scripts/check_adrs.py            # what `task lint:repo` runs
```

New ADRs use [MADR 4](0000-template.md): YAML frontmatter, then *Context and
Problem Statement*, *Considered Options*, *Decision Outcome*. ADRs 0001–0049
predate it and keep the shape they were written in; the checker knows which is
which and does not ask you to convert them.

## Obligations

| When you | You must | What fails you |
|---|---|---|
| Number an ADR | Take it from `--next`, which reads the directory | The index lags reality. Two people reading it on the same day is how 0027, 0039, 0044 and 0047 each ended up used twice |
| Add an ADR | Add its row to [`README.md`](README.md) in the same commit | `check_adrs.py`. An ADR nobody can find from the index is one nobody reads |
| Change a status | Change it in the file **and** the index row | `check_adrs.py`. The two drifted apart for 0021 and 0045, and the index was the one people trusted |
| Supersede an ADR | Set the new one's status, and set the old one's to `superseded by ADR-NNNN` | A reader lands on the old decision with nothing saying it was replaced |
| Accept an ADR | Fill in **Confirmation**, the gate that keeps the decision true, or an explicit "nothing enforces this yet" | Review. An unenforced decision decays quietly and reads as enforced |

## Rules that need more than a row

**A status field holds one of five values and nothing else.** `proposed`,
`rejected`, `accepted`, `deprecated`, `superseded by ADR-NNNN`. Qualifications
belong in Consequences: they are where a reader looks for them, and a status
carrying a paragraph cannot be read by the index, the checker, or a person
scanning for what is in force.

**An accepted ADR is superseded, not rewritten.** Typos and clarifications are
fine. Changing what was decided means a new ADR that supersedes this one, because
the value of the record is that it says what was true *then*.

**One decision per record.** "And we will also" is almost always a second ADR.

## Reference

- The index, the status legend and the four recorded number collisions:
  [`README.md`](README.md).
- The template's own comments carry the section-by-section guidance.
- Ratcheting a decision so it stays true:
  [`../contributing/correction-ratchet.md`](../contributing/correction-ratchet.md).
