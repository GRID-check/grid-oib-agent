"""Cross-language contract for the shelf, on the hop where it is consumed.

``X-Grid-Collection-Scope`` is written by the Next.js BFF
(``frontends/ui/src/lib/collection-scope-request.ts``) and read here. Neither
runtime imports the other's enum — ADR-0047 keeps each side's constants local
on purpose — so the only thing holding them in agreement is the shared fixture
``tests/fixtures/collection_scope/scope_header.json``.

This module proves the agent still READS what the fixture describes;
``frontends/ui/src/lib/collection-scope-contract.spec.ts`` proves the BFF still
WRITES it. Change the payload on one end and exactly one side fails.

That split matters because every defect this phase produced was invisible to
one side's own suite. The shelf was first written only to the raw header while
this module prefers the signed envelope, so it passed every header test and was
inert in production; and the citation-key reader knew three qualifiers while the
writer had grown a fourth, with both halves green. A seam is not covered by
testing each side of it.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from aiq_agent.common.source_kinds import Shelf
from aiq_agent.knowledge.scoping import _base64url_decode
from aiq_agent.knowledge.scoping import _parse_scope_payload

_FIXTURE = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "collection_scope" / "scope_header.json"


def _contract() -> dict[str, Any]:
    return json.loads(_FIXTURE.read_text(encoding="utf-8"))


def _cases() -> list[dict[str, Any]]:
    return _contract()["cases"]


def _ids() -> list[str]:
    return [case["name"] for case in _cases()]


@pytest.mark.parametrize("case", _cases(), ids=_ids())
def test_agent_reads_every_payload_the_bff_can_write(case: dict[str, Any]) -> None:
    """Each fixture header decodes to exactly the stated (collection, shelf) pairs."""
    decoded = json.loads(_base64url_decode(case["header"]).decode("utf-8"))

    entries = _parse_scope_payload(decoded)

    assert entries is not None, case["name"]
    actual = [(entry.collection, entry.shelf.value if entry.shelf else None) for entry in entries]
    expected = [(row["collection"], row["shelf"]) for row in case["parsed"]]
    assert actual == expected


def test_a_session_collection_is_its_own_shelf_not_project() -> None:
    """The defect ADR-0047 exists to remove.

    While the shelf was recovered by prefix-matching, ``s_`` had nowhere to land
    but ``projekt``, so a file attached privately to a chat was cited as
    "Projektwissen". The shelf is stated now, so it survives.
    """
    entries = _parse_scope_payload([{"collection": "s_conv_abc", "shelf": "session"}])

    assert entries is not None
    assert entries[0].shelf is Shelf.SESSION


def test_a_missing_shelf_is_unknown_and_is_never_defaulted() -> None:
    """No shelf means unattributed — not ``base``, and not the old ``baurecht``.

    The predecessor of this path failed OPEN: an unrecognised collection was
    reported as base law, which is the strongest provenance claim the product
    makes and was the fallback for anything it could not place.
    """
    entries = _parse_scope_payload([{"collection": "some_custom_corpus"}])

    assert entries is not None
    assert entries[0].shelf is None


def test_a_legacy_bare_string_payload_still_reads() -> None:
    """A BFF that has not shipped yet keeps working, with the shelf unknown."""
    entries = _parse_scope_payload(["oib_knowledge", "s_conv_abc"])

    assert entries is not None
    assert [entry.collection for entry in entries] == ["oib_knowledge", "s_conv_abc"]
    assert all(entry.shelf is None for entry in entries)


#: Shelves that name no COLLECTION and therefore cannot ride this header.
#: The Projektregister (ADR-0054) is a table on the BFF, not a vector
#: collection: a Steckbrief hit is stamped with the ``register`` shelf on the
#: citation, but there is nothing for the scope header — which authorizes
#: collections — to carry. Every other shelf must have a fixture case, so the
#: exemption is a list of one rather than a loosened assertion.
_SHELVES_THAT_NAME_NO_COLLECTION = {Shelf.REGISTER.value}


def test_the_fixture_exercises_every_shelf() -> None:
    """A shelf added to the enum without a fixture case would slip through."""
    covered = {row["shelf"] for case in _cases() for row in case["parsed"] if row["shelf"] is not None}

    assert covered == {shelf.value for shelf in Shelf} - _SHELVES_THAT_NAME_NO_COLLECTION


def test_a_register_shelf_never_authorizes_a_collection() -> None:
    """The register is navigation, not retrieval (spec PR-14/PR-15).

    Nothing may reach a project's documents by putting ``register`` on a scope
    entry: the shelf parses (it is a real member) and the entry it appears on is
    still just one collection the BFF named, so this pins the fixture's silence
    rather than the parser's behaviour — no fixture case carries it, and a
    producer that started sending one would fail the assertion above.
    """
    assert all(row["shelf"] != Shelf.REGISTER.value for case in _cases() for row in case["parsed"]), (
        "the BFF does not put the Projektregister in the collection scope; a case that does needs ADR-0054 revisited"
    )
