# Quote-verification calibration — 2026-07-28

The three `TUNABLE` constants in `src/aiq_agent/common/citation_verification.py`
had never been measured. This is that measurement.

**Verdict: keep all three. They are well chosen.** The one actionable finding is
not a constant at all — it is a structural blind spot the gap budget cannot
close (§4).

Harness: `calibration/quote_verification/` (re-run instructions in its README).

---

## 1. What was measured

Quote verification checks every quoted span in an answer against the text of a
retrieved passage. A span that fails gets `[nicht wörtlich in der Quelle belegt]`
appended to the sentence and caps the answer's surfaced confidence to `low`.

So the two errors are not symmetric:

- **False positive** — a genuine verbatim quote accused of fabrication. Publicly
  visible, damages trust in a correct answer. **The expensive one.**
- **False negative** — a fabricated quote passes. The bug the layer exists to
  catch.

| Constant | Value | Controls |
|---|---|---|
| `QUOTE_MATCH_THRESHOLD` | `0.90` | fraction of the span that must be found |
| `MIN_QUOTE_LEN` | `20` | shortest normalized span checked at all |
| `_QUOTE_MAX_ELIDED_GAP` | `6` | passage characters a verified quote may skip |

**Corpus: real.** 9 passages from 3 OIB documents, 37 quotable sentences, **706
labelled cases** (461 should-verify, 195 should-flag, 40 grey-zone, 10
attribution). A replay cross-check at the current constants found 0
disagreements, so the harness reproduces production behaviour exactly.

---

## 2. Results at the current values

```
false positive rate :   0.0%  (0/461 genuine quotes flagged)
false negative rate :   9.2%  (18/195 fabrications verified)
```

**Zero false positives.** No genuine quote — verbatim, OCR-noised, hyphen-wrapped,
mark-swapped, umlaut-transliterated, or any combination — was accused. On the
axis that matters most, the current configuration is clean on real corpus text.

Per family, everything that should verify verified:

| Family | Wrong |
|---|---|
| `verbatim`, `chunk_ocr_light`, `chunk_ocr_heavy` | 0/30 |
| `noise_safe`, `noise_risky`, `noise_combined` | 0/225 |
| `mark_style`, `interior_marks`, `restored_compound_hyphen` | 0/31 |
| `adjacent_splice`, `scattered_splice`, `paraphrase`, `fabricated` | 0/55 |

---

## 3. The sweeps

### `QUOTE_MATCH_THRESHOLD` — 0.90 is well-centred, the cliff is at 0.96

```
 thr     FP%     FN%
0.90    0.0%    9.2%   <- current
0.92    0.0%    8.7%
0.94    0.0%    8.2%
0.96    6.7%    8.2%   <- false positives begin
0.98   15.2%    8.2%
1.00   43.8%    7.7%
```

False positives are **zero from 0.60 through 0.94** and then rise steeply. 0.90
sits three grid steps below the cliff. Raising to 0.92–0.94 would buy ~1pp of
false negatives at the cost of most of that safety margin — not worth it for a
constant whose failure mode is accusing correct answers, especially on a
37-sentence corpus.

**Keep 0.90.**

### `MIN_QUOTE_LEN` — 20 is defensible; 16 is marginally better

```
 min     FP%     FN%   scanned
   8    1.5%    7.7%       705
  12    0.0%    8.2%       690
  16    0.0%    8.7%       671
  20    0.0%    9.2%       640   <- current
  40    0.0%   13.8%       541
```

Lowering to 16 checks ~30 more spans and cuts false negatives to 8.7% while
staying at zero false positives; below 12, false positives appear. So 20 is
conservative but not wrong, and 16 is a real (if small) improvement two steps
clear of the danger zone.

**Keep 20 for now.** 0.5pp of false negatives on 37 sentences is inside the
noise of a corpus this size — revisit with a larger corpus rather than tuning
a safety constant on thin evidence.

The trade-off it encodes is real, though: a fabricated quote shorter than 20
normalized characters is **never checked**. Measured directly:

```
boundary_short_fabricated  norm_len= 9   1/1 wrong
boundary_short_fabricated  norm_len=13   1/1 wrong
boundary_short_fabricated  norm_len=17   1/1 wrong
boundary_short_fabricated  norm_len=20   0/1 wrong
```

`„§ 3 Abs. 2 gilt"` fits under that bar.

### `_QUOTE_MAX_ELIDED_GAP` — 6 is optimal, and this is the strongest result

```
 gap     FP%     FN%
   4    0.4%    6.7%
   6    0.0%    9.2%   <- current
   8    0.0%   15.9%
```

Tightening to 4 introduces false positives. Loosening to 8 nearly doubles false
negatives. 6 is the only value tested that is clean on the expensive axis while
staying competitive on the other. The original comment called it "chosen
empirically" against hand-written fixtures; real corpus text agrees.

**Keep 6.**

---

## 4. The real finding: the ≤6-character elision blind spot

Detection is a step function, and it sits exactly where the constant puts it:

```
share of spliced quotes CAUGHT, by characters elided
 gap      2      4      6      8     10     12+
   6     0%     0%     0%   100%   100%   100%   <- current
```

A splice that drops **6 characters or fewer is never caught**; 8 or more is
always caught. There is no grey zone.

This matters because German legal prose inverts on short words. The worst
family in the whole run:

```
meaning_inverting_elision   13/22 wrong
```

A quote that silently drops `nicht` — **5 characters** — passes verification as
verbatim. In an OIB requirement that turns a prohibition into a permission, or
a mandate into an option, while the answer displays it as a checked, confidence-
carrying quotation. Other members of this family: `kein`, `außer`, `nur`.

**This cannot be fixed by tuning the gap.** Dropping to 4 still misses a 4-char
elision *and* introduces false positives. It needs a different mechanism — a
negation/quantifier-aware check that treats the elision of a polarity-bearing
token as disqualifying regardless of length. That is the recommended next piece
of work on this layer, and it is worth more than any constant change.

---

## 5. Second limitation: attribution is out of scope

```
attribution   10/10 wrong
```

`verify_quoted_spans` matches a span against the chunk text of **any** source in
the registry (a deliberate ADR decision — simpler than per-citation and it
catches the reported bug). So quoting document A verbatim while citing document
B passes verification.

Working as designed, but the design has a cost worth stating: quote
verification proves *the words exist somewhere in what we retrieved*, not *the
words exist in the document the citation names*. Per-citation matching would
close it and is a bounded change, since `valid_citations` already binds each
`[N]` to a specific registry entry.

---

## 6. What this method cannot establish

**The false-positive numbers are trustworthy.** They come from real OIB text
perturbed by mechanical noise — OCR, hyphenation, whitespace, quote marks,
NFKC, casing — which behaves the same regardless of which model wrote the
answer.

**The false-negative numbers are indicative only.** They depend on synthetic
fabrication families that encode an *assumption* about how models fabricate.
Real models may fabricate in ways not represented here, so 9.2% is a lower bound
on a distribution we do not actually know.

Also bounded by corpus size: 3 documents, 37 sentences. Enough to locate cliff
edges, not enough to justify a fractional constant change.

**To close the gap:** capture a sample of real answers with quoted spans plus
their retrieved passages, label them, and re-run the harness against that
corpus. Everything needed is in `calibration/quote_verification/corpus.py` —
point it at the real pairs and the rest of the pipeline is unchanged.
