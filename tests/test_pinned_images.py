"""trivy scans every digest pin the Pulumi program has, and a change only the ones it adds.

`ci/pinned_images.py` finds the pins by shape rather than from a list of names,
so a new image is scanned the day it is pinned.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DIGEST = "a" * 64


@pytest.fixture(scope="module")
def mod():
    spec = importlib.util.spec_from_file_location("pinned_images", ROOT / "ci" / "pinned_images.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_every_quoted_digest_pin_counts_whatever_its_name(mod):
    text = f"""
      image: "ghcr.io/cloudnative-pg/pgbouncer:1.26.0@sha256:{DIGEST}",
      other: 'redis@sha256:{DIGEST}',
      tpl: `mcr.microsoft.com/dotnet/aspire-dashboard@sha256:{DIGEST}`,
      // a comment naming nginx@sha256:{DIGEST} unquoted is not a pin
      short: "busybox@sha256:abc",
    """
    assert mod.pins_in(text) == {
        f"ghcr.io/cloudnative-pg/pgbouncer:1.26.0@sha256:{DIGEST}",
        f"redis@sha256:{DIGEST}",
        f"mcr.microsoft.com/dotnet/aspire-dashboard@sha256:{DIGEST}",
    }


def test_the_program_pins_the_images_adr_0029_and_0044_name(mod):
    names = {pin.split("@")[0].split(":")[0] for pin in mod.pins_at(None)}

    assert {
        "ghcr.io/langfuse/langfuse",
        "ghcr.io/langfuse/langfuse-worker",
        "clickhouse/clickhouse-server",
        "mcr.microsoft.com/dotnet/aspire-dashboard",
        "otel/opentelemetry-collector-contrib",
        "ghcr.io/cloudnative-pg/pgbouncer",
    } <= names
