#!/usr/bin/env python3
"""Held-out check for every decision-model use (ADR-0064): does the wording generalise?

WHY THIS EXISTS
---------------
The criteria and thresholds of the decision model's uses were tuned on the
labelled sets under tests/fixtures/decisions/ and the loop-eval questions
(decision_eval.py, decision_eval_offpath.py). A number measured on
the set a wording was tuned on says little about the next question. The
sets under tests/fixtures/decisions/holdout/ were written blind to the
wording — from plain label definitions, by someone who had not seen the
criteria or the tuning sets — and this script scores the CURRENT code on them
at the thresholds the code ships with.

THE RULE: NEVER TUNE ON THESE SETS
----------------------------------
Change a criterion because the tuning sets or production say so, then run
this to see whether it generalised. A change made to fix a held-out row makes
the held-out set a tuning set; when that happens, write a new held-out set.
The floors below sit just under the 2026-09-26 result so a regression fails;
they are not targets.

IT NEEDS A KEY, NOT A BACKEND
-----------------------------
OPENROUTER_API_KEY (or GRID_DECISIONS_API_KEY); a few cents. Exit 0
when every floor holds.

THE LAST RUN
------------
2026-09-26, two runs, identical: tags 24/24 types, 13 of 14 disciplines, no
false one; reflection skipped 13/13 empty passes and lost no durable one;
supersede 15/15 corrections, no wrong retirement; Dokumentart 13/13;
feedback causes 20/24 (1 wrong, 3 unlabelled); turn: needs_evidence 30/30,
self_contained 25/27, family 16/21 with one false pick on a follow-up,
skill 25/30.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT))

from aiq_agent.common import decisions  # noqa: E402
from aiq_agent.common.decisions import choice  # noqa: E402
from aiq_agent.common.decisions import decide_many  # noqa: E402
from aiq_agent.common.decisions import noul  # noqa: E402

H = ROOT / "tests" / "fixtures" / "decisions" / "holdout"
T = 0.8


def load(name):
    return yaml.safe_load((H / name).read_text(encoding="utf-8"))


async def tags():
    from aiq_agent.knowledge import document_classification as dc

    rows = load("document_tags.yaml")
    states = [{"file_name": r["file_name"], "text": r["text"][:4000]} for r in rows]
    ds = await decide_many(states, dc.tag_questions(), slot="h", timeout=15)
    type_ok = type_sure = tp = fp = fn = 0
    fps = []
    for r, d in zip(rows, ds):
        c, dist = d.choice("type")
        type_ok += c == r["type"]
        type_sure += c == r["type"] and dist.get(c, 0) >= dc.TYPE_THRESHOLD
        want = set(r.get("disciplines") or [])
        got = {
            tag
            for i, tag in enumerate(dc.DISCIPLINE_TAGS)
            if (d.noul(f"discipline_{i}") or 0) >= dc.DISCIPLINE_THRESHOLD
        }
        tp += len(got & want)
        fp += len(got - want)
        fn += len(want - got)
        fps += [(r["file_name"], t) for t in got - want]
    return {
        "rows": len(rows),
        "type_right": type_ok,
        "type_right_at_0.8": type_sure,
        "disc_tp": tp,
        "disc_fp": fp,
        "disc_fn": fn,
        "false_disciplines": fps,
    }


async def reflection():
    from aiq_agent.memory import reflection as R

    rows = load("reflection_exchanges.yaml")
    new = hasattr(R, "nothing_durable_probability")
    fn = R.nothing_durable_probability if new else R.durable_probability
    ps = [await fn(r["question"], r["answer"], organization_id=None) for r in rows]
    if new:
        skip = [p is not None and p >= R.REFLECTION_SKIP_THRESHOLD for p in ps]
    else:
        skip = [p is not None and p < R.REFLECTION_SKIP_THRESHOLD for p in ps]
    lost = [(r["question"][:50], round(p, 2)) for r, p, s in zip(rows, ps, skip) if r["durable"] and s]
    return {
        "rows": len(rows),
        "question": "nothing" if new else "durable",
        "skipped_non_durable": sum(1 for r, s in zip(rows, skip) if not r["durable"] and s),
        "non_durable": sum(1 for r in rows if not r["durable"]),
        "lost_durable": lost,
    }


async def supersede():
    from aiq_agent.memory import supersede as S

    data = load("memory_supersede.yaml")
    q = {"r": noul(S._REPLACES, true=S._REPLACES_TRUE, false=S._REPLACES_FALSE)}
    found = wrong = missed = 0
    details = []
    for f in data["findings"]:
        ds = await decide_many(
            [{"new_finding": f["finding"], "existing_entry": e} for e in data["memory"]], q, slot="h", timeout=15
        )
        ps = {e: (d.noul("r") if d else 0.0) for d, e in zip(ds, data["memory"])}
        best, p = max(ps.items(), key=lambda kv: kv[1])
        pick = best if p >= S.REPLACES_THRESHOLD else None
        exp = f["supersedes"]
        if pick and pick == exp:
            found += 1
        elif pick and pick != exp:
            wrong += 1
            details.append(("WRONG", f["finding"][:45], best[:40], round(p, 2)))
        elif exp:
            missed += 1
            details.append(("miss", f["finding"][:45], round(ps.get(exp, 0), 2)))
    return {
        "corrections": sum(1 for f in data["findings"] if f["supersedes"]),
        "found": found,
        "wrong_retirements": wrong,
        "missed": missed,
        "details": details,
    }


async def doc_class():
    from aiq_agent.knowledge import document_classification as dc

    rows = load("doc_class.yaml")
    q = {
        "doc_class": choice(
            dc.DOC_CLASS_QUESTION,
            {k: dc.DOCUMENT_CLASS_CRITERIA[k] for k in dc.DOCUMENT_CLASSES},
        )
    }
    ds = await decide_many(
        [{"file_name": r["file_name"], "text": r["text"][:4000]} for r in rows], q, slot="h", timeout=15
    )
    offered = right = wrong = 0
    bad = []
    for r, d in zip(rows, ds):
        c, dist = d.choice("doc_class")
        if c != "sonstiges" and dist.get(c, 0) >= dc.DOC_CLASS_SUGGESTION_THRESHOLD:
            offered += 1
            if c == r["doc_class"]:
                right += 1
            else:
                wrong += 1
                bad.append((r["file_name"], c, r["doc_class"]))
    return {
        "rows": len(rows),
        "non_default": sum(1 for r in rows if r["doc_class"] != "sonstiges"),
        "offered": offered,
        "right": right,
        "wrong": wrong,
        "wrong_rows": bad,
    }


async def causes():
    from aiq_agent.common import feedback_causes as fc

    rows = load("feedback_causes.yaml")
    labels_state = [
        fc._state(SimpleNamespace(question=r["question"], reason=r["reason"], comment=r["comment"])) for r in rows
    ]
    ds = await decide_many(
        labels_state,
        {
            "cause": choice(
                fc.CAUSE_QUESTION,
                fc.CAUSES,
            )
        },
        slot="h",
        timeout=15,
    )
    right = wrong = unlabelled = 0
    bad = []
    for r, d in zip(rows, ds):
        c, dist = d.choice("cause")
        if dist.get(c, 0) < fc.CAUSE_THRESHOLD:
            unlabelled += 1
            bad.append(("unlabelled", r["cause"], c, round(dist.get(c, 0), 2)))
        elif c == r["cause"]:
            right += 1
        else:
            wrong += 1
            bad.append(("wrong", r["cause"], c, round(dist.get(c, 0), 2)))
    return {"rows": len(rows), "right": right, "wrong": wrong, "unlabelled": unlabelled, "details": bad}


async def turn():
    from aiq_agent.agents.piloti import decisions as P
    from aiq_agent.cards.catalog import card_index_entries
    from aiq_agent.cards.envelope import ENVELOPE_SHAPE_TYPES
    from aiq_agent.common.norm_registry import oib_families
    from aiq_agent.skills.builtin import discover_builtin_skills
    from aiq_agent.skills.resolver import _skill_applies_to_agent
    from scripts.decision_eval import CORPUS_FILES

    fam = oib_families(CORPUS_FILES)
    cards = [e for e in card_index_entries() if e[0] not in ENVELOPE_SHAPE_TYPES]
    skills = [P.skill_option(s) for s in discover_builtin_skills() if _skill_applies_to_agent(s, "researcher")]
    rows = load("turn_questions.yaml")
    res = {
        "needs_evidence": [0, 0, []],
        "self_contained": [0, 0, []],
        "family": [0, 0, []],
        "family_false": [],
        "skill": [0, 0, []],
    }
    for r in rows:
        facts = P.TurnFacts(
            question=r["message"],
            previous_message=r.get("previous_message"),
            families=fam,
            card_types=cards,
            skills=skills,
        )
        td = await P.decide_turn(facts)
        ne = td.needs_evidence or 0
        ok = (ne >= P.NEEDS_EVIDENCE_THRESHOLD) == bool(r["needs_evidence"])
        res["needs_evidence"][0] += ok
        res["needs_evidence"][1] += 1
        if not ok:
            res["needs_evidence"][2].append((r["id"], r["needs_evidence"], round(ne, 2)))
        if r["needs_evidence"]:
            sc = td.self_contained or 0
            ok = (sc >= P.SELF_CONTAINED_THRESHOLD) == bool(r["self_contained"])
            res["self_contained"][0] += ok
            res["self_contained"][1] += 1
            if not ok:
                res["self_contained"][2].append((r["id"], r["self_contained"], round(sc, 2)))
        fps = dict(td.families)
        chosen = set(td.chosen_families())
        if r.get("family"):
            ok = str(r["family"]) in chosen
            res["family"][0] += ok
            res["family"][1] += 1
            if not ok:
                res["family"][2].append((r["id"], r["family"], round(fps.get(str(r["family"]), 0), 2)))
        res["family_false"] += [(r["id"], k, round(fps.get(k, 0), 2)) for k in chosen if k != str(r.get("family"))]
        loaded = td.chosen_skill
        exp = r.get("skill")
        ok = loaded == exp
        res["skill"][0] += ok
        res["skill"][1] += 1
        if not ok:
            res["skill"][2].append((r["id"], exp, td.skill, round(td.skill_p, 2), td.skill_veto))
    return res


FLOORS = {
    "tags": lambda r: r["type_right_at_0.8"] >= 22 and r["disc_fp"] <= 1,
    "reflection": lambda r: not r["lost_durable"] and r["skipped_non_durable"] >= 10,
    "supersede": lambda r: r["wrong_retirements"] == 0 and r["found"] >= 13,
    "doc_class": lambda r: r["wrong"] == 0 and r["right"] >= 11,
    "causes": lambda r: r["right"] >= 18 and r["wrong"] <= 2,
    "turn": lambda r: (
        r["needs_evidence"][0] >= 28
        and r["self_contained"][0] >= 23
        and r["family"][0] >= 14
        and len(r["family_false"]) <= 2
        and r["skill"][0] >= 23
    ),
}


async def main() -> int:
    ok = True
    with patch.object(decisions, "_zdr_only_blocking", return_value=False):
        for name, fn in (
            ("tags", tags),
            ("reflection", reflection),
            ("supersede", supersede),
            ("doc_class", doc_class),
            ("causes", causes),
            ("turn", turn),
        ):
            result = await fn()
            held = FLOORS[name](result)
            ok = ok and held
            print(f"{name}: {'ok' if held else 'BELOW FLOOR'}")
            print(json.dumps(result, ensure_ascii=False, default=str))
    return 0 if ok else 1


if __name__ == "__main__":
    os.environ.setdefault("OPENROUTER_API_KEY", os.environ.get("OPENROUTER_KEY", ""))
    sys.exit(asyncio.run(main()))
