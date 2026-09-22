# The deep research report: anatomy, findings, and the reader's lever

A planning office commissions a Prüfung, not a whitepaper: which requirements
apply to this project, is each one met, where is that written, and what is
still open. The unit of that work is a **Befund**, and since 2026-09 the deep
report is delivered around a list of them rather than as one wall of Markdown.

## What a finished report carries

| On the message | Produced by | Rendered as |
|---|---|---|
| `content` | the writer (`prompts/writer.j2`), verified and sanitised in `finalize.py` | the prose, with `[N]` markers and the sources row |
| `answer_meta` | one structured call over the finished report (`deep_researcher/anatomy.py`), gated by `common/answer_envelope.gate_answer_meta` | the same masthead a chat answer has: verdict when there is one copyable value, summary, topic, context; takeaways and callout after the prose |
| `findings` | the same call, under `common/findings.py` | the Befundmatrix between the masthead and the prose (`FindingsMatrix.tsx`), and a table in the Word export |
| `stages.followUps` | the follow-ups stage's own handler, run in the job runner under the org flag | the follow-up chips under the report |
| `retrieval_ledger`, `skills_hidden` | recorded on the deep state; lifted by `runner._extract_answer_transparency` | the Herleitung and the skills disclosure |

The extraction is post hoc on purpose: the writer's contract and the citation
verification stay untouched, the extraction cannot change a word of the report,
and a failure costs the reader the masthead and the matrix, never the report.
It runs beside the post-hoc cards and the memory reflection, in one gather.

## The findings contract

`common/findings.py` (pydantic) and `lib/conversations/message-findings.ts`
(sanitizer) describe one shape, pinned by `tests/fixtures/findings/wire_payload.json`,
which both sides validate. One row per requirement:

- `requirement`, `value` — the noun phrase and the copyable value.
- `status` — `erfuellt | nicht_erfuellt | offen | nicht_anwendbar`; `offen`
  means the report could not decide (a missing project fact, a pending Behörde).
- `grounding` — `belegt` when a cited passage states it, `abgeleitet` when it is
  computed from cited values, `offen` when no source carries it.
- `reference`, `citations` — the document and Punkt or page, and the `[N]` the
  report attaches; the matrix links each `[N]` to the answer's sources row.
- `comment`, `area` — what qualifies the status; the Prüfpunkt it belongs to.

Every string is bounded on both sides, because the payload is jsonb and a table.

## While the run is going

Each research round's notes state claims; the run ledger fold copies them onto
the round (`RunStep.findings`), so the block shows what has been established
so far and counts it in the header. The reader has one lever, „Jetzt
schreiben": the report is written from what is there
([`docs/design/run-block.md`](../design/run-block.md), *The actions*). The run
lands `unterbrochen`, with the truncation reason `user_requested` and a banner
that names the reader's choice rather than a limit.

## Language

The sources heading follows the report's language (`## Quellen` for German,
`## Sources` otherwise), and so does the honesty banner, detected off the
report itself (`finalize._prepend_honesty_banner`).
