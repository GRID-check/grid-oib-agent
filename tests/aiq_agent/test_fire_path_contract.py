"""The Python half of the job fire path's header contract (ledger item 10).

ADR-0046's Risks section is the whole reason this file exists, and it names its
own remedy: the internal submit route's guard read ``x-internal-token`` while
every caller in the repo sent ``x-grid-internal-token``, so **every scheduled
run 403'd in a real deployment**, and nothing caught it "because the two sides
are tested separately and each test pinned its own spelling". The lesson got
written down; the test did not. A fire path has no human on it, so a silent 403
is indistinguishable from a quiet week.

The contract is `tests/fixtures/job_fire_headers.json`. This module asserts that
every set the BACKEND requires is a subset of it, reading each set off the
module that owns it rather than restating the names — a restated list is a
third thing that agrees with itself. The BFF half
(`frontends/ui/tests/lib/jobs/fire-headers.test.ts`) fires a real submit through
the real client and asserts the headers that go out cover the same file. Neither
side can move a name alone.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import HTTPException

from aiq_agent.project_context import REQUEST_CONTEXT_ENVELOPE_HEADER
from aiq_agent.project_context import REQUEST_CONTEXT_ENVELOPE_SIG_HEADER
from aiq_api.context_envelope import _INTERNAL_TOKEN_HEADER_NAMES
from aiq_api.context_envelope import ENFORCED_HTTP_PATH_PREFIXES
from aiq_api.jobs.runner import WORKER_IDENTITY_HEADERS
from aiq_api.routes.internal_auth import _TOKEN_HEADERS
from aiq_api.routes.internal_auth import _require_internal_token

REPO = Path(__file__).resolve().parents[2]
FIXTURE_PATH = REPO / "tests" / "fixtures" / "job_fire_headers.json"
#: The frontend's typecheck/test Docker context is scoped to `frontends/ui` and
#: cannot COPY from outside it, so the fixture is duplicated there — the same
#: arrangement `grid_request_context.json` uses. A duplicate nothing compares is
#: a duplicate that drifts, which is the failure mode this whole file is about.
TWIN_PATH = REPO / "frontends" / "ui" / "tests" / "fixtures" / "job_fire_headers.json"


@pytest.fixture(scope="module")
def contract() -> dict:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def _lower(names) -> set[str]:
    return {str(name).lower() for name in names}


def test_the_frontend_twin_is_byte_identical() -> None:
    assert TWIN_PATH.read_bytes() == FIXTURE_PATH.read_bytes(), (
        f"{TWIN_PATH.relative_to(REPO)} has drifted from {FIXTURE_PATH.relative_to(REPO)}. "
        "Copy the repo-root file over it; the two halves of this contract must read the same names."
    )


def test_the_route_guard_accepts_only_spellings_the_contract_names(contract: dict) -> None:
    """`_TOKEN_HEADERS` is the exact list whose contents caused the 403."""
    assert _lower(_TOKEN_HEADERS) <= _lower(contract["internalTokenAcceptedSpellings"])


def test_the_envelope_middleware_agrees_with_the_route_guard(contract: dict) -> None:
    """Two independent lists of the same header, one bytes and one str.

    They disagreed once — the middleware accepted both spellings and the route
    guard only one, which is why a request got far enough to look healthy before
    being refused.
    """
    middleware = _lower(name.decode("ascii") for name in _INTERNAL_TOKEN_HEADER_NAMES)
    assert middleware <= _lower(contract["internalTokenAcceptedSpellings"])
    assert middleware == _lower(_TOKEN_HEADERS)


def test_what_the_route_requires_is_something_the_bff_actually_sends(contract: dict) -> None:
    """The floor is reachable: every required name is in what the BFF sends.

    This is the assertion that would have failed in 2026-08. The guard's
    accepted set and the BFF's sent set were each internally consistent; their
    INTERSECTION was empty, and only a test that reads both can see that.
    """
    required = _lower(contract["requiredOnEveryFire"])
    assert required <= _lower(contract["sentByBff"])
    assert required <= _lower(_TOKEN_HEADERS), (
        "the fire path's required header is not one the backend guard reads — this is ADR-0046's 403"
    )


def test_the_guard_admits_a_request_carrying_exactly_the_contract_headers(
    contract: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    """End to end on the guard itself, with the contract's own header names.

    A subset assertion can be satisfied by two empty sets; this cannot. It runs
    `_require_internal_token` against a request built from the fixture, so the
    contract is exercised rather than merely compared.
    """
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "a-real-deployment-token")
    monkeypatch.setenv("APP_ENV", "production")

    class _Request:
        def __init__(self, headers: dict[str, str]) -> None:
            self.headers = {k.lower(): v for k, v in headers.items()}

    fired = _Request({name: "a-real-deployment-token" for name in contract["requiredOnEveryFire"]})
    _require_internal_token(fired)  # must not raise

    with pytest.raises(HTTPException) as refused:
        _require_internal_token(_Request({"x-grid-organization-id": "org_1"}))
    assert refused.value.status_code == 403


def test_the_worker_identity_headers_are_the_ones_on_the_wire(contract: dict) -> None:
    """`WORKER_IDENTITY_HEADERS` must be spelled as the BFF spells them.

    The worker synthesises these onto the tool context from the run's identity
    so a project-scoped tool inside an unattended run reads the same names a
    chat turn does. `remember` answered "no project in scope" on every
    deep-research run while they were absent; a rename made on one side only
    produces the same silence.
    """
    worker = _lower(WORKER_IDENTITY_HEADERS)
    assert worker == _lower(contract["workerIdentityHeaders"])
    assert worker <= _lower(contract["sentByBff"])


def test_the_signed_envelope_headers_match_what_the_bff_signs(contract: dict) -> None:
    envelope = _lower({REQUEST_CONTEXT_ENVELOPE_HEADER, REQUEST_CONTEXT_ENVELOPE_SIG_HEADER})
    assert envelope == _lower(contract["contextEnvelope"])
    assert envelope <= _lower(contract["sentByBff"])


def test_the_contract_covers_the_route_the_middleware_enforces(contract: dict) -> None:
    """The fixture names a path, and it must be a path this tier actually guards."""
    assert contract["route"] in ENFORCED_HTTP_PATH_PREFIXES


def test_every_backend_requirement_is_inside_the_contract(contract: dict) -> None:
    """The subset property the ledger row asks for, stated once over everything.

    A backend requirement outside this file is a header the BFF has never been
    asked to send, which is the class of defect the whole fixture exists for.
    """
    named = _lower(contract["sentByBff"]) | _lower(contract["internalTokenAcceptedSpellings"])
    backend_requires = (
        _lower(_TOKEN_HEADERS)
        | _lower(name.decode("ascii") for name in _INTERNAL_TOKEN_HEADER_NAMES)
        | _lower(WORKER_IDENTITY_HEADERS)
        | _lower({REQUEST_CONTEXT_ENVELOPE_HEADER, REQUEST_CONTEXT_ENVELOPE_SIG_HEADER})
    )
    unnamed = sorted(backend_requires - named)
    assert unnamed == [], (
        f"the backend requires headers the contract does not name: {unnamed}. "
        "Add them to tests/fixtures/job_fire_headers.json AND make the BFF send them."
    )
