"""Register a lightweight ``aiq_api`` package before submodule imports.

Skips ``aiq_api/__init__.py`` (plugin pulls NAT/Dask) so tests can load
``aiq_api.auth`` and peers from ``src/`` without the full runtime stack.
"""

from __future__ import annotations

import socket
import sys
import types
from pathlib import Path

import pytest

_SRC_ROOT = Path(__file__).resolve().parents[1] / "src"
_PKG_DIR = _SRC_ROOT / "aiq_api"

if _PKG_DIR.is_dir():
    if str(_SRC_ROOT) not in sys.path:
        sys.path.insert(0, str(_SRC_ROOT))

    if "aiq_api" not in sys.modules:
        _pkg = types.ModuleType("aiq_api")
        _pkg.__path__ = [str(_PKG_DIR)]
        sys.modules["aiq_api"] = _pkg


@pytest.fixture(autouse=True)
def stub_private_dns(monkeypatch):
    """Answer every hostname with a private IP, without touching real DNS.

    The ingest route's SSRF resolution guard consults ``socket.getaddrinfo``;
    letting it hit the network made the suite slow and environment-dependent
    (the reserved ``.test`` object-store host used in fixtures does not
    resolve at all). Private by default so the allowlisted-host exemption is
    exercised on every happy path — the object store legitimately resolves
    in-network in compose/Kubernetes deployments.
    """

    def fake_getaddrinfo(*args, **kwargs):
        port = args[1] if len(args) > 1 else kwargs.get("port", 0)
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.42.0.7", port or 0))]

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)
