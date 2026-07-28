# Quote-verification calibration — 2026-07

`verify_quoted_spans` checks every quoted span in an answer against retrieved
passage text. A failed span gets `[nicht wörtlich in der Quelle belegt]`
appended and caps the answer's confidence to `low` — so the expensive error is
the **false positive**, a genuine quote accused of fabrication.

Its three `TUNABLE` constants had never been measured. They were, once, against
the real OIB corpus (9 passages / 3 documents / 706 labelled cases, replayed
against the real function with 0 disagreements).

## Result: keep all three

```
at 0.90 / 20 / 6 :  0.0% false positives (0/461)   9.2% false negatives (18/195)
```

| Constant | Value | Evidence |
|---|---|---|
| `QUOTE_MATCH_THRESHOLD` | `0.90` | FP is 0% from 0.60–0.94, then 6.7% at 0.96, 43.8% at 1.00. Three grid steps below the cliff. |
| `MIN_QUOTE_LEN` | `20` | FP 0% down to 12, 1.5% at 8. 16 scores marginally better (8.7% FN) but 0.5pp on 37 sentences is noise. |
| `_QUOTE_MAX_ELIDED_GAP` | `6` | The only value clean on the expensive axis: 4 → 0.4% FP, 8 → 15.9% FN. |

## The finding that matters — negation blindness

Elision detection is a step function on the budget: splices dropping **≤6
characters are caught 0% of the time**, ≥8 characters 100%. German legal prose
inverts on short words, and the worst case family scored 13/22 wrong:

> A quote that silently drops **`nicht`** (5 chars) passes as verbatim, turning
> an OIB prohibition into a permission while the answer presents it as a
> checked quotation. Same for `kein`, `nur`, `außer`.

**Tuning cannot fix this** — gap=4 still misses a 4-char elision and starts
accusing correct answers. It needs a polarity-aware check that disqualifies
eliding a negation or quantifier regardless of length. Tracked as **T2-CIT1**.

## What this does not establish

The false-positive numbers are trustworthy: they come from real corpus text
perturbed by mechanical noise (OCR, hyphenation, whitespace, quote marks, NFKC,
casing), which is model-independent. The **false-negative** numbers rest on
assumed fabrication families and are a lower bound on a distribution we do not
know. Closing that needs real transcripts: answer text plus the `chunk_text` of
each knowledge-layer source, human-labelled per span.

The harness that produced these numbers was not kept — it was ~2000 lines, ran
in no CI, and would have rotted into a confidently wrong answer. Re-deriving it
is a day's work if the numbers are ever in doubt.
