"""Every backend role points at the same shared stores.

The backend image runs four process types, selected by ``GRID_ROLE``: ``chat``,
``api``, ``worker`` and ``ingest-worker``. Data one role writes is read by
another. A role that lacks one of the variables below silently falls back to a
process-local store (an embedded Chroma, a per-process cache, an in-memory draft
store), and the roles stop seeing each other's data. This reads the Compose
files and the Pulumi backend env, so the check runs without Docker.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parents[1]
COMPOSE_DIR = REPO / "deploy" / "compose"
COMPOSE_FILES = ["docker-compose.yaml", "docker-compose.coolify.yaml"]
PULUMI_CONFIG = REPO / "deploy" / "pulumi" / "src" / "app" / "config.ts"

ROLES = ("chat", "api", "worker", "ingest-worker")

SHARED_STORE_VARS = (
    "AIQ_CHROMA_URL",
    "REDIS_URL",
    "AIQ_CHECKPOINT_DB",
    "AIQ_DEEP_CHECKPOINT_DB",
    "NAT_JOB_STORE_DB_URL",
    "AIQ_SUMMARY_DB",
)
DSN_VARS = ("AIQ_CHECKPOINT_DB", "AIQ_DEEP_CHECKPOINT_DB", "NAT_JOB_STORE_DB_URL", "AIQ_SUMMARY_DB")

POSTGRES_URL = re.compile(r"postgres(?:ql)?(?:\+[a-z0-9_]+)?://")
WRAPPED_DEFAULT = re.compile(r"\$\{[A-Za-z_][A-Za-z0-9_]*:-(.*)\}", re.DOTALL)


def _load(name: str) -> dict:
    return yaml.safe_load((COMPOSE_DIR / name).read_text())["services"]


def _pair(item: str) -> tuple[str, str]:
    key, _, value = item.partition("=")
    return key, value


def _environment(services: dict, service: str) -> dict[str, str]:
    """A service's environment, with what it inherits through ``extends`` underneath."""
    definition = services[service]
    extends = definition.get("extends")
    parent = extends if isinstance(extends, str) else (extends or {}).get("service")
    inherited = _environment(services, parent) if parent else {}
    raw = definition.get("environment") or []
    # A list item without `=` passes the host's variable through; it has no value here.
    if isinstance(raw, dict):
        own = {k: "" if v is None else str(v) for k, v in raw.items()}
    else:
        own = dict(_pair(item) for item in raw)
    return {**inherited, **own}


def _default(value: str) -> str:
    """The default inside a Compose ``${VAR:-default}``, or the value itself."""
    match = WRAPPED_DEFAULT.fullmatch(value)
    return match.group(1) if match else value


def _backend_services(name: str) -> list[tuple[str, str, dict[str, str]]]:
    """``(service, role, resolved environment)`` for every service that runs a backend role."""
    services = _load(name)
    found = []
    for service in services:
        env = _environment(services, service)
        if env.get("GRID_ROLE") in ROLES:
            found.append((service, env["GRID_ROLE"], env))
    return found


def _backend_function(name: str) -> str:
    """The text of ``export function backendEnv(``, through its closing brace at column 0."""
    source = PULUMI_CONFIG.read_text()
    start = re.search(r"^export function backendEnv\(", source, re.MULTILINE)
    assert start, f"{PULUMI_CONFIG}: no `export function backendEnv(`; move this test with the backend env"
    end = re.search(r"^\}", source[start.end() :], re.MULTILINE)
    assert end, f"{PULUMI_CONFIG}: backendEnv has no closing brace at column 0; this test cannot find its end"
    return source[start.start() : start.end() + end.end()]


@pytest.mark.parametrize("name", COMPOSE_FILES)
def test_every_backend_role_runs_from_the_file(name):
    roles = {role for _, role, _ in _backend_services(name)}
    missing = [role for role in ROLES if role not in roles]
    assert not missing, f"{name}: no service sets GRID_ROLE to {missing}; every backend role must run from this file"


@pytest.mark.parametrize("name", COMPOSE_FILES)
def test_every_backend_role_sets_every_shared_store_variable(name):
    problems = []
    for service, role, env in _backend_services(name):
        for var in SHARED_STORE_VARS:
            if not env.get(var, "").strip():
                problems.append(
                    f"{name}: service {service} (GRID_ROLE={role}) does not set {var}; "
                    "it falls back to a process-local store and cannot see the other roles' data"
                )
    assert not problems, "\n".join(problems)


@pytest.mark.parametrize("name", COMPOSE_FILES)
def test_the_dsns_are_postgres_urls(name):
    problems = []
    for service, role, env in _backend_services(name):
        for var in DSN_VARS:
            value = _default(env.get(var, ""))
            if POSTGRES_URL.match(value):
                continue
            # Print the scheme only: the rest of a DSN carries credentials.
            scheme = value.partition("://")[0] if "://" in value else "(no scheme)"
            problems.append(
                f"{name}: service {service} (GRID_ROLE={role}) {var} is not a postgres URL (scheme {scheme!r})"
            )
    assert not problems, "\n".join(problems)


@pytest.mark.parametrize("name", COMPOSE_FILES)
def test_all_roles_point_at_one_value_per_shared_store_variable(name):
    backends = _backend_services(name)
    problems = []
    for var in SHARED_STORE_VARS:
        by_value: dict[str, list[str]] = {}
        for service, role, env in backends:
            value = env.get(var, "").strip()
            if value:  # A role that does not set it is reported by its own test.
                by_value.setdefault(value, []).append(f"{service} (GRID_ROLE={role})")
        if len(by_value) > 1:
            groups = "; ".join(", ".join(members) for members in by_value.values())
            problems.append(f"{name}: {var} differs across roles, so they do not share one store: {groups}")
    assert not problems, "\n".join(problems)


@pytest.mark.parametrize("name", COMPOSE_FILES)
def test_a_backend_that_defaults_to_requiring_auth_also_sets_the_validator(name):
    problems = []
    for service, role, env in _backend_services(name):
        if _default(env.get("REQUIRE_AUTH", "")).strip().lower() != "true":
            continue
        if not env.get("WORKOS_CLIENT_ID", "").strip():
            problems.append(
                f"{name}: service {service} (GRID_ROLE={role}) defaults REQUIRE_AUTH to true but does not "
                "set WORKOS_CLIENT_ID; the backend refuses to start with auth required and no validator"
            )
    assert not problems, "\n".join(problems)


@pytest.mark.parametrize("var", SHARED_STORE_VARS)
def test_the_pulumi_backend_env_names_every_shared_store_variable(var):
    body = _backend_function("backendEnv")
    assert f'"{var}"' in body, (
        f'{PULUMI_CONFIG}: backendEnv does not name {var} (as a quoted name or sref("{var}")); '
        "the Kubernetes backend roles would not share that store"
    )
