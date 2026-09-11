"""The JOIN that CrashLoopBackOff'd staging: load_config in a clean interpreter.

`test_shipped_config_wires_the_otlp_logging_method` only yaml.safe_load's the
file, and pytest has already imported the plugins. That suite stayed green
while `start_web.py` died on `_type` `otelcollector_logs` not in the NAT
registry. This file is the process that actually boots.

Full `load_config` of the shipped YAML needs every `nat.plugins` entry point
to import, which an editable install from another worktree will not do. The
JOIN we can pin here is: `start_web.load_nat_config` registers the two Grid
telemetry `_type`s before it calls `load_config`. `load_config` itself is
stubbed so this does not depend on the rest of the catalog.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tomllib
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
START_WEB = REPO / "deploy" / "start_web.py"
RUNNER = REPO / "frontends" / "aiq_api" / "src" / "aiq_api" / "jobs" / "runner.py"


def _clean_env() -> dict[str, str]:
    env = os.environ.copy()
    src = str(REPO / "src")
    existing = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = src if not existing else src + os.pathsep + existing
    env["START_WEB"] = str(START_WEB)
    return env


def test_nat_plugins_entry_points_name_the_telemetry_modules():
    data = tomllib.loads((REPO / "pyproject.toml").read_text(encoding="utf-8"))
    plugins = data["project"]["entry-points"]["nat.plugins"]
    assert plugins["aiq_otel_logs"] == "aiq_agent.observability.otlp_logging_method"
    assert plugins["aiq_otel_redaction"] == "aiq_agent.observability.otel_header_redaction_exporter"


def test_start_web_registers_grid_telemetry_before_load_config():
    src = START_WEB.read_text(encoding="utf-8")
    register_at = src.index("register_grid_telemetry")
    load_at = src.index("load_config(")
    assert register_at < load_at


def test_worker_runner_registers_grid_telemetry_before_load_config():
    src = RUNNER.read_text(encoding="utf-8")
    register_at = src.index("register_grid_telemetry")
    load_at = src.index("load_config(config_file_path)")
    assert register_at < load_at


def test_shipped_config_loads_in_a_clean_interpreter():
    """Subprocess so pytest's imports cannot hide a missing registration."""
    code = """
import importlib.util
import os
from pathlib import Path

start_web = Path(os.environ["START_WEB"])
spec = importlib.util.spec_from_file_location("start_web", start_web)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(mod)

import nat.runtime.loader as loader


def fake_load_config(path):
    return path


loader.load_config = fake_load_config
assert mod.load_nat_config("unused.yml") == "unused.yml"

from nat.cli.type_registry import GlobalTypeRegistry
from nat.data_models.component import ComponentEnum

reg = GlobalTypeRegistry.get()
logging_types = set(reg.get_registered_types_by_component_type(ComponentEnum.LOGGING))
tracing_types = set(reg.get_registered_types_by_component_type(ComponentEnum.TRACING))
missing = [name for name, pool in (
    ("otelcollector_logs", logging_types),
    ("otelcollector_redaction", tracing_types),
) if name not in pool]
if missing:
    raise SystemExit(
        f"missing {missing}; logging={sorted(logging_types)} tracing={sorted(tracing_types)}"
    )
print("OK")
"""
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=REPO,
        env=_clean_env(),
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert result.returncode == 0, result.stdout + "\n" + result.stderr
    assert "OK" in result.stdout
