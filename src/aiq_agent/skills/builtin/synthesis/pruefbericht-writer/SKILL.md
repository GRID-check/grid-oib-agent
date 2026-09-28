---
name: pruefbericht-writer
description: >
  Use this skill when the final answer strategy calls for a Prüfbericht: requirements read against one project, one finding per requirement with the value, the Fundstelle and the status. Triggers: "pruefbericht", "Prüfbericht", "Prüfung", "Kurzprüfung", "Nachweis", "Anforderungen prüfen", "Konformität", "compliance check", "requirements review". Outputs: A cited Markdown Prüfbericht whose core is a Befund per Prüfpunkt, in the plan's order, with open points named rather than dropped.
metadata:
  # A deepagents writer skill: it reads `/shared/` and writes `/shared/output.md`,
  # which exists only inside a deep-research job. `grid-agents: deep_researcher`
  # is the one availability gate that keeps it out of a chat turn.
  grid-agents: deep_researcher
---

# Prüfbericht Writer Skill

Write the report a planning office files: requirements read against this project, one finding per requirement. This skill is for final synthesis only; do not perform new research.

## When To Use

Use this skill when `answer_strategy.answer_type` is `pruefbericht`, or the approved plan's genre is `pruefbericht`, or the request asks which requirements apply to a project and whether they are met. For a whitepaper-style explanation use `long-form-report-writer`; for a forecast use `prediction-report-writer`.

## Structure

Open with the lead: the overall result in two to five sentences — how many Prüfpunkte are met, which are not, which are open, and the governing rule. A reader who stops there leaves with the verdict.

Then, one section per Prüfpunkt, in the plan's order (`answer_strategy.required_components`). Each section opens with its **Befund line** in this exact shape, then the derivation:

`**Befund:** <Anforderung> — <Wert> — <Fundstelle> — <Status>`

- `<Anforderung>`: the requirement as a noun phrase.
- `<Wert>`: the copyable value (a number, a class, „Nicht geregelt"), or „–" when the point has no value.
- `<Fundstelle>`: the document and Punkt, Tabelle or Paragraph, with the `[N]` citation.
- `<Status>`: exactly one of `erfüllt`, `nicht erfüllt`, `offen`, `nicht anwendbar`. `offen` means the report could not decide: name what is missing (a project fact, an Aufmaß, the Behörde's ruling) in the sentence after.

After the derivation, the caveats for this point, each on its own: the Landesabweichung, the Frist, the case where the finding flips.

Close with **Offene Punkte**: every `offen` and `nicht erfüllt` finding as one line naming who decides it or what would settle it. Then the sources section (`## Quellen` for a German report, `## Sources` otherwise).

## Depth

`kurzpruefung`: the lead, the Befund lines with one or two sentences of derivation each, the open points, the sources. No narrative sections.
`gutachten`: the same skeleton with the full derivation per point — the rule, what it requires, how this project meets or misses it — and the caveats written out.

## Craft

- Assess, do not recommend: judge against the norm; the Behörde decides Genehmigungsfähigkeit.
- German reports use Sie-Form and Austrian legal German; numbers as the Richtlinie writes them (1,10 m; 1.200 m²; REI 90; GK 4).
- A Prüfpunkt the research could not settle is written as `offen`, never dropped and never guessed.
- No self-description of the research process, no closing offers, no exclamation marks.
- Tables where the findings compare (several Bauteile against one Tabelle); otherwise the Befund lines carry the structure.

## Citations

Same rules as the base writer prompt: every material claim cites `[N]` from `get_verified_sources`; one verified locator per number; the sources section lists each once. Never place bare URLs in the body.

## Final Verification

1. Every Prüfpunkt of the plan has a section with a Befund line in the exact shape.
2. Every status is one of the four words.
3. Every open or unmet point appears under Offene Punkte.
4. Every material claim has an inline citation and the sources section is complete.
5. Write `/shared/output.md`, end it with the confidence marker, and return only `Wrote /shared/output.md`.
