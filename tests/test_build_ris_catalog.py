"""The norm catalog's builder still imports.

It loads ``norm_registry`` standalone, without the ``aiq_agent`` package, so
every import that module gains has to be loaded by hand. Nothing ran it, and it
died on ``source_kinds`` until a catalog change needed it (2026-09-24). This
imports it and reads the real catalog, with no network.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def test_the_builder_imports_and_reads_the_catalog():
    spec = importlib.util.spec_from_file_location("build_ris_catalog", REPO_ROOT / "scripts" / "build_ris_catalog.py")
    module = importlib.util.module_from_spec(spec)
    saved = dict(sys.modules)
    # As a bare `python scripts/build_ris_catalog.py` starts: no aiq_agent yet.
    for name in [name for name in sys.modules if name == "aiq_agent" or name.startswith("aiq_agent.")]:
        del sys.modules[name]
    try:
        spec.loader.exec_module(module)
        module._nr.reset_registry_cache()
        registry = module._nr.load_registry(str(module.NORMS_ROOT))
    finally:
        for name in set(sys.modules) - set(saved):
            del sys.modules[name]
        sys.modules.update(saved)
    ids = {entry.id for entry in registry.entries}
    assert {"bo-wien", "bo-sbg", "baupolg-sbg"} <= ids
