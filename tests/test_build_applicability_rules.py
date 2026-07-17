"""Freshness + determinism tests for the applicability codegen script (norm-registry Phase 4)."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "build_applicability_rules.py"
TS_OUT = REPO_ROOT / "frontends" / "ui" / "src" / "lib" / "oib" / "applicability-rules.generated.ts"
JSON_OUT = REPO_ROOT / "frontends" / "ui" / "src" / "lib" / "oib" / "applicability-parity.generated.json"


def _load_module():
    spec = importlib.util.spec_from_file_location("build_applicability_rules", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"failed to import {SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


mod = _load_module()


def test_generated_artifacts_are_fresh():
    assert mod.main(["--check"]) == 0, (
        "generated applicability artifacts are stale — run "
        "`uv run --frozen python scripts/build_applicability_rules.py`"
    )


def test_rendering_is_deterministic():
    registry = mod.load_registry()
    assert registry is not None
    assert mod.render_ts(registry) == mod.render_ts(registry)
    assert mod.render_parity(registry) == mod.render_parity(registry)


def test_parity_fixtures_match_shipped_json():
    payload = json.loads(JSON_OUT.read_text(encoding="utf-8"))
    assert [f["name"] for f in payload] == [name for name, _ in mod.PARITY_PROFILES]
    assert len(payload) == 12


def test_shipped_rules_cover_oib_richtlinien():
    ts = TS_OUT.read_text(encoding="utf-8")
    for rl in ("1", "2", "2.1", "2.2", "2.3", "3", "4", "5", "6"):
        assert f'"normId": "oib-rl-{rl}"' in ts
    # Trigger norms ship too (engine-only; not part of the UI catalog).
    for norm_id in ("garagengesetz-wien", "klgg-wien", "dmsg", "gewo"):
        assert f'"normId": "{norm_id}"' in ts
