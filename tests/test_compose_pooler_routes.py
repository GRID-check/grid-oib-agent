"""Both Compose files route Postgres the way Kubernetes does (ADR-0083).

The pooled DSNs go through ``pgbouncer``; LISTEN, the session locks and the
owner's migrations go straight to ``postgres``. Every Python tier on Postgres
must be given both direct DSNs, because ``require_direct_dsns`` refuses to start
a process without them: a service added here that forgets one does not degrade,
it fails to boot. This reads the files, so the check runs without Docker.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

COMPOSE_DIR = Path(__file__).resolve().parents[1] / "deploy" / "compose"
FILES = ["docker-compose.yaml", "docker-compose.coolify.yaml"]

POOLED = ("NAT_JOB_STORE_DB_URL", "AIQ_CHECKPOINT_DB", "AIQ_SUMMARY_DB")
DIRECT = ("AIQ_LISTEN_DB_URL", "AIQ_LOCK_DB_URL")


def _services(name: str) -> dict:
    return yaml.safe_load((COMPOSE_DIR / name).read_text())["services"]


def _pair(item: str) -> tuple[str, str]:
    key, _, value = item.partition("=")
    return key, value


def _environment(services: dict, service: str) -> dict[str, str]:
    """A service's environment, with what it inherits through ``extends`` underneath."""
    definition = services[service]
    inherited: dict[str, str] = {}
    parent = (definition.get("extends") or {}).get("service")
    if parent:
        inherited = _environment(services, parent)
    raw = definition.get("environment") or []
    # A list item without `=` is a pass-through of the host's variable.
    own = {k: str(v) for k, v in raw.items()} if isinstance(raw, dict) else dict(_pair(item) for item in raw)
    return {**inherited, **own}


def _host(value: str) -> str:
    """The host of a DSN, through a compose ``${VAR:-default}`` wrapper."""
    match = re.search(r"@([a-z0-9-]+):5432/", value)
    assert match, f"no host in {value}"
    return match.group(1)


def _python_tiers(name: str) -> list[str]:
    services = _services(name)
    return [s for s in services if "NAT_JOB_STORE_DB_URL" in _environment(services, s)]


@pytest.mark.parametrize("name", FILES)
def test_the_files_have_a_pgbouncer_in_transaction_mode(name):
    env = _services(name)["pgbouncer"]["environment"]

    assert env["POOL_MODE"] == "transaction"
    assert int(env["MAX_PREPARED_STATEMENTS"]) > 0
    assert "@sha256:" in _services(name)["pgbouncer"]["image"]


@pytest.mark.parametrize("name", FILES)
def test_there_are_python_tiers_to_check(name):
    assert _python_tiers(name), "no service sets NAT_JOB_STORE_DB_URL; the checks below would pass for nothing"


@pytest.mark.parametrize("name", FILES)
def test_every_python_tier_pools_the_pooled_dsns_and_connects_directly_for_the_rest(name):
    services = _services(name)
    for service in _python_tiers(name):
        env = _environment(services, service)
        for key in POOLED:
            assert _host(env[key]) == "pgbouncer", f"{name}: {service} {key} must go through the pooler"
        for key in DIRECT:
            assert key in env, (
                f"{name}: {service} has Postgres but no {key}; require_direct_dsns would refuse to boot it"
            )
            assert _host(env[key]) == "postgres", f"{name}: {service} {key} must connect directly"


@pytest.mark.parametrize("name", FILES)
def test_the_bff_pools_its_runtime_role_and_migrates_directly(name):
    services = _services(name)
    for service in services:
        env = _environment(services, service)
        if "GRID_APP_DATABASE_URL" in env:
            assert _host(env["GRID_APP_DATABASE_URL"]) == "pgbouncer", f"{name}: {service}"
        if "GRID_APP_MIGRATION_DATABASE_URL" in env:
            assert _host(env["GRID_APP_MIGRATION_DATABASE_URL"]) == "postgres", f"{name}: {service}"


@pytest.mark.parametrize("name", FILES)
def test_every_service_that_connects_through_the_pooler_waits_for_it(name):
    services = _services(name)
    for service, definition in services.items():
        env = _environment(services, service)
        pooled = [k for k, v in env.items() if "@pgbouncer:" in v]
        if pooled and service != "grid-migrate":
            depends = definition.get("depends_on") or {}
            assert "pgbouncer" in depends, f"{name}: {service} uses the pooler ({pooled[0]}) but does not wait for it"
