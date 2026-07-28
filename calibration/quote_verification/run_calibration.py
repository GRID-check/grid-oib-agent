"""Entry point: calibrate QUOTE_MATCH_THRESHOLD / MIN_QUOTE_LEN / _QUOTE_MAX_ELIDED_GAP.

    PYTHONPATH=src:. .venv/bin/python -m calibration.quote_verification.run_calibration

See ``README.md`` in this directory for options and for how to re-run the same
harness against real transcripts once they exist.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import defaultdict

from calibration.quote_verification import sweep
from calibration.quote_verification.corpus import load_passages
from calibration.quote_verification.corpus import sentences

THRESHOLD_GRID = [round(0.60 + 0.02 * step, 2) for step in range(21)]  # 0.60 … 1.00
MIN_LEN_GRID = [4, 8, 12, 16, 18, 20, 24, 28, 32, 40, 48, 60]
GAP_GRID = [2, 4, 5, 6, 7, 8, 10, 16, 40]

# The sentence pool drives every noise family, so it dominates runtime. Ten
# sentences (round-robin across all documents) is enough for stable rates while
# keeping a full run to roughly ten minutes on four cores.
DEFAULT_MAX_SENTENCES = 10


def _bar(value: float, width: int = 24) -> str:
    filled = int(round(value * width))
    return "█" * filled + "·" * (width - filled)


def main(argv: list[str] | None = None) -> int:  # noqa: PLR0915 - a report script is linear by nature
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--synthetic", action="store_true", help="force the synthetic fallback corpus")
    parser.add_argument("--quick", action="store_true", help="coarse gap grid (fast smoke run)")
    parser.add_argument(
        "--max-sentences",
        type=int,
        default=DEFAULT_MAX_SENTENCES,
        help=f"cap the source-sentence pool (default {DEFAULT_MAX_SENTENCES}; 0 = no cap)",
    )
    parser.add_argument("--jobs", type=int, default=os.cpu_count() or 1, help="worker processes")
    parser.add_argument("--json", dest="json_path", help="also write the full grid as JSON")
    parser.add_argument("--no-crosscheck", action="store_true", help="skip the replay-vs-real assertion")
    args = parser.parse_args(argv)

    corpus = load_passages(force_synthetic=args.synthetic)
    cases, registries = sweep.build_everything(corpus, max_sentences=args.max_sentences or None)

    print("=" * 78)
    print("QUOTE-VERIFICATION CALIBRATION")
    print("=" * 78)
    print(f"corpus provenance : {corpus.provenance}")
    print(f"passages          : {len(corpus.passages)} ({len({p.doc for p in corpus.passages})} documents)")
    print(f"quotable sentences: {sum(len(sentences(p)) for p in corpus.passages)}")
    print(f"cases             : {len(cases)}")
    label_counts: dict[str, int] = defaultdict(int)
    for case in cases:
        label_counts[case.label] += 1
    print(f"labels            : {dict(sorted(label_counts.items()))}")
    print(
        f"current constants : QUOTE_MATCH_THRESHOLD={sweep.CURRENT_THRESHOLD} "
        f"MIN_QUOTE_LEN={sweep.CURRENT_MIN_LEN} _QUOTE_MAX_ELIDED_GAP={sweep.CURRENT_GAP}"
    )
    print()

    gap_grid = [4, 6, 8] if args.quick else GAP_GRID
    if sweep.CURRENT_GAP not in gap_grid:
        gap_grid = sorted({*gap_grid, sweep.CURRENT_GAP})

    observations_by_gap = {}
    for gap in gap_grid:
        started = time.monotonic()
        observations_by_gap[gap] = sweep.observe(cases, registries, gap, jobs=args.jobs)
        print(f"  observed gap={gap} in {time.monotonic() - started:.0f}s", flush=True)

    current = observations_by_gap[sweep.CURRENT_GAP]

    if not args.no_crosscheck:
        checked, disagreements = sweep.verify_replay_matches_real(
            cases,
            registries,
            current,
            threshold=sweep.CURRENT_THRESHOLD,
            min_len=sweep.CURRENT_MIN_LEN,
            gap=sweep.CURRENT_GAP,
            jobs=args.jobs,
        )
        print(f"\nreplay cross-check at the current constants: {checked} cases, {len(disagreements)} disagreements")
        if disagreements:
            print("  DISAGREEMENTS:", disagreements[:10])
            return 2

    # ---------------------------------------------------------------- current
    baseline = sweep.score(
        current, threshold=sweep.CURRENT_THRESHOLD, min_len=sweep.CURRENT_MIN_LEN, gap=sweep.CURRENT_GAP
    )
    print()
    print("-" * 78)
    print("AT THE CURRENT VALUES")
    print("-" * 78)
    print(
        f"false positive rate : {baseline.fp_rate:6.1%}  "
        f"({baseline.false_positives}/{baseline.verify_total} genuine quotes flagged)"
    )
    # The aggregate is NOT a prevalence estimate — it depends entirely on how
    # many cases each noise class contributed. `length_vs_divergence` is a
    # controlled probe of the decision boundary, deliberately including
    # divergence magnitudes that no real transcript need contain; quoting it
    # inside one headline number would be misleading in both directions.
    probe_families = {"length_vs_divergence"}
    observed_fp = sum(
        1
        for observation in current
        if observation.case.label == "verify"
        and observation.case.family not in probe_families
        and observation.flagged(sweep.CURRENT_THRESHOLD, sweep.CURRENT_MIN_LEN)
    )
    observed_total = sum(
        1
        for observation in current
        if observation.case.label == "verify" and observation.case.family not in probe_families
    )
    print(
        f"  ├─ transcript-shaped noise only : {observed_fp / max(1, observed_total):6.1%} "
        f"({observed_fp}/{observed_total}) — excludes the controlled length×divergence probe"
    )
    print(
        f"false negative rate : {baseline.fn_rate:6.1%}  "
        f"({baseline.false_negatives}/{baseline.flag_total} fabrications verified)"
    )
    print(
        f"attribution misses  : {baseline.attribution_missed}/{baseline.attribution_total} "
        "(right text, wrong document — out of scope by design)"
    )
    print(f"grey-zone flagged   : {baseline.grey_flagged}/{baseline.grey_total}")

    print("\nper family (cases, wrong outcomes):")
    for family, (total, wrong) in sweep.per_family(
        current, threshold=sweep.CURRENT_THRESHOLD, min_len=sweep.CURRENT_MIN_LEN
    ).items():
        marker = "  " if wrong == 0 else "!!"
        print(f"  {marker} {family:32s} {wrong:3d}/{total:<4d} wrong")

    print("\ngenuine quotes with the LOWEST coverage (closest to being falsely accused).")
    print("`margin` is how many MORE unmatched characters the span could absorb before flipping:")
    for case_id, noise_class, norm_len, coverage in sweep.worst_verify_cases(
        current, threshold=sweep.CURRENT_THRESHOLD, min_len=sweep.CURRENT_MIN_LEN
    ):
        verdict = "FLAGGED" if coverage < sweep.CURRENT_THRESHOLD else "ok"
        margin = (coverage - sweep.CURRENT_THRESHOLD) * norm_len
        print(
            f"  cov={coverage:5.3f} len={norm_len:4d} margin={margin:+6.1f} chars  "
            f"{verdict:8s} {noise_class:28s} {case_id}"
        )

    print("\nHEADROOM BY QUOTE LENGTH — unmatched characters tolerated at the current threshold:")
    for length in (20, 24, 30, 40, 60, 80, 120, 200, 300):
        print(f"  norm_len={length:4d}  tolerates {int(length * (1 - sweep.CURRENT_THRESHOLD))} unmatched chars")

    # ---------------------------------------------------------------- threshold
    print()
    print("-" * 78)
    print(f"THRESHOLD SWEEP  (MIN_QUOTE_LEN={sweep.CURRENT_MIN_LEN}, gap={sweep.CURRENT_GAP})")
    print("-" * 78)
    print(f"{'thr':>5}  {'FP%':>6}  {'FN%':>6}   FP bar")
    for threshold in THRESHOLD_GRID:
        row = sweep.score(current, threshold=threshold, min_len=sweep.CURRENT_MIN_LEN, gap=sweep.CURRENT_GAP)
        mark = " <- current" if abs(threshold - sweep.CURRENT_THRESHOLD) < 1e-9 else ""
        print(f"{threshold:5.2f}  {row.fp_rate:6.1%}  {row.fn_rate:6.1%}   {_bar(row.fp_rate)}{mark}")

    # ---------------------------------------------------------------- min length
    print()
    print("-" * 78)
    print(f"MIN_QUOTE_LEN SWEEP  (threshold={sweep.CURRENT_THRESHOLD}, gap={sweep.CURRENT_GAP})")
    print("-" * 78)
    print(f"{'min':>5}  {'FP%':>6}  {'FN%':>6}  {'scanned':>8}")
    for min_len in MIN_LEN_GRID:
        row = sweep.score(current, threshold=sweep.CURRENT_THRESHOLD, min_len=min_len, gap=sweep.CURRENT_GAP)
        scanned = sum(1 for observation in current if observation.scanned(min_len))
        mark = " <- current" if min_len == sweep.CURRENT_MIN_LEN else ""
        print(f"{min_len:5d}  {row.fp_rate:6.1%}  {row.fn_rate:6.1%}  {scanned:8d}{mark}")

    # ---------------------------------------------------------------- gap
    print()
    print("-" * 78)
    print(f"_QUOTE_MAX_ELIDED_GAP SWEEP  (threshold={sweep.CURRENT_THRESHOLD}, min_len={sweep.CURRENT_MIN_LEN})")
    print("-" * 78)
    print(f"{'gap':>5}  {'FP%':>6}  {'FN%':>6}")
    for gap in gap_grid:
        row = sweep.score(
            observations_by_gap[gap],
            threshold=sweep.CURRENT_THRESHOLD,
            min_len=sweep.CURRENT_MIN_LEN,
            gap=gap,
        )
        mark = " <- current" if gap == sweep.CURRENT_GAP else ""
        culprits = sorted(
            {
                observation.case.noise_class
                for observation in observations_by_gap[gap]
                if observation.case.label == "verify"
                and observation.flagged(sweep.CURRENT_THRESHOLD, sweep.CURRENT_MIN_LEN)
            }
        )
        detail = f"   FP from: {', '.join(culprits)}" if culprits else ""
        print(f"{gap:5d}  {row.fp_rate:6.1%}  {row.fn_rate:6.1%}{mark}{detail}")

    # ---------------------------------------------------------------- elision detail
    print()
    print("-" * 78)
    print("ELISION DETECTION  (share of spliced quotes CAUGHT, by elided chars)")
    print("-" * 78)
    sizes = sorted({int(case.noise_class.split("_")[1]) for case in cases if case.family == "elision_sweep"})
    header = "  gap  " + "".join(f"{size:>7}" for size in sizes)
    print(header)
    for gap in gap_grid:
        caught: dict[int, list[int]] = defaultdict(lambda: [0, 0])
        for observation in observations_by_gap[gap]:
            if observation.case.family != "elision_sweep":
                continue
            size = int(observation.case.noise_class.split("_")[1])
            caught[size][1] += 1
            if observation.flagged(sweep.CURRENT_THRESHOLD, sweep.CURRENT_MIN_LEN):
                caught[size][0] += 1
        cells = "".join(f"{caught[size][0] / max(1, caught[size][1]):>7.0%}" for size in sizes)
        mark = " <- current" if gap == sweep.CURRENT_GAP else ""
        print(f"{gap:5d}  {cells}{mark}")

    # ---------------------------------------------------------------- length x divergence
    print()
    print("-" * 78)
    print("LENGTH × DIVERGENCE  (genuine quotes: share FALSELY FLAGGED, current constants)")
    print("-" * 78)
    surface: dict[tuple[int, int], list[int]] = defaultdict(lambda: [0, 0])
    for observation in current:
        if observation.case.family != "length_vs_divergence":
            continue
        parts = observation.case.noise_class.split("_")
        key = (int(parts[1]), int(parts[3]))
        surface[key][1] += 1
        if observation.flagged(sweep.CURRENT_THRESHOLD, sweep.CURRENT_MIN_LEN):
            surface[key][0] += 1
    lengths = sorted({length for length, _ in surface})
    divergences = sorted({count for _, count in surface})
    print("  unmatched chars →" + "".join(f"{count:>7}" for count in divergences))
    for length in lengths:
        cells = "".join(
            f"{surface[(length, count)][0] / surface[(length, count)][1]:>7.0%}"
            if surface[(length, count)][1]
            else f"{'-':>7}"
            for count in divergences
        )
        skipped = " (below MIN_QUOTE_LEN)" if length < sweep.CURRENT_MIN_LEN else ""
        print(f"  quote len {length:4d}    {cells}{skipped}")

    print()
    print("SHORT-QUOTE GERMAN ORTHOGRAPHY (genuine quotes: share falsely flagged):")
    orthography: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for observation in current:
        if observation.case.family != "short_german_orthography":
            continue
        orthography[observation.case.noise_class][1] += 1
        if observation.flagged(sweep.CURRENT_THRESHOLD, sweep.CURRENT_MIN_LEN):
            orthography[observation.case.noise_class][0] += 1
    for noise_class, (wrong, total) in sorted(orthography.items()):
        marker = "  " if wrong == 0 else "!!"
        print(f"  {marker} {noise_class:40s} {wrong}/{total} falsely flagged")

    # ---------------------------------------------------------------- length detail
    print()
    print("-" * 78)
    print("SHORT-QUOTE BOUNDARY  (normalized length vs outcome, current constants)")
    print("-" * 78)
    buckets: dict[tuple[str, int], list[int]] = defaultdict(lambda: [0, 0])
    for observation in current:
        if not observation.case.family.startswith("boundary_"):
            continue
        span_lengths = [span.norm_len for span in observation.spans]
        if not span_lengths:
            continue
        bucket = (observation.case.family, max(span_lengths))
        buckets[bucket][1] += 1
        expected_flag = observation.case.label == "flag"
        if observation.flagged(sweep.CURRENT_THRESHOLD, sweep.CURRENT_MIN_LEN) != expected_flag:
            buckets[bucket][0] += 1
    for (family, length), (wrong, total) in sorted(buckets.items()):
        marker = "  " if wrong == 0 else "!!"
        print(f"  {marker} {family:34s} norm_len={length:4d}  {wrong}/{total} wrong")

    if args.json_path:
        payload = {
            "provenance": corpus.provenance,
            "cases": len(cases),
            "current": {
                "threshold": sweep.CURRENT_THRESHOLD,
                "min_quote_len": sweep.CURRENT_MIN_LEN,
                "max_elided_gap": sweep.CURRENT_GAP,
                "fp_rate": baseline.fp_rate,
                "fn_rate": baseline.fn_rate,
            },
            "grid": [
                {
                    "threshold": threshold,
                    "min_len": min_len,
                    "gap": gap,
                    **{
                        key: getattr(row, key)
                        for key in ("false_positives", "verify_total", "false_negatives", "flag_total")
                    },
                    "fp_rate": row.fp_rate,
                    "fn_rate": row.fn_rate,
                }
                for gap in gap_grid
                for min_len in MIN_LEN_GRID
                for threshold in THRESHOLD_GRID
                if (row := sweep.score(observations_by_gap[gap], threshold=threshold, min_len=min_len, gap=gap))
            ],
        }
        with open(args.json_path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
        print(f"\nwrote {args.json_path}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
