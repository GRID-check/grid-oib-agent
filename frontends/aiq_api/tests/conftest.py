"""Register a lightweight ``aiq_api`` package before submodule imports.

Skips ``aiq_api/__init__.py`` (plugin pulls NAT/Dask) so tests can load
``aiq_api.auth`` and peers from ``src/`` without the full runtime stack.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

_SRC_ROOT = Path(__file__).resolve().parents[1] / "src"
_PKG_DIR = _SRC_ROOT / "aiq_api"

if _PKG_DIR.is_dir():
    if str(_SRC_ROOT) not in sys.path:
        sys.path.insert(0, str(_SRC_ROOT))

    if "aiq_api" not in sys.modules:
        _pkg = types.ModuleType("aiq_api")
        _pkg.__path__ = [str(_PKG_DIR)]
        sys.modules["aiq_api"] = _pkg
