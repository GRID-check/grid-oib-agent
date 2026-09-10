"""The filing wire, validated against the schema the BFF generated from its own zod.

ADR-0055's rule read from this side: there is **no hand-written Pydantic twin**
of the request body. The contract is
``frontends/ui/tests/fixtures/document-lifecycle.schema.json``, serialised from
``lib/documents/lifecycle-types.ts`` and refreshed by
``lifecycle-schema.spec.ts``, and what this file asserts is that the payloads
``tools/documents/register.py`` actually builds validate against it — so a field
renamed on the TS side fails here rather than at runtime with a 400 the reader
sees as „Piloti konnte nicht ablegen".

The three ops are exercised through the tool itself rather than through a
literal dict, because a literal would be the second description of the contract
this file exists to prevent.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator

from aiq_agent.cards.models import DocumentVersionState
from aiq_agent.tools.documents import register as filing_tools

from .conftest import DRAFT
from .conftest import _edit
from .conftest import _responder
from .conftest import _version
from .conftest import _write

SCHEMA_PATH = (
    Path(__file__).resolve().parents[4] / "frontends" / "ui" / "tests" / "fixtures" / "document-lifecycle.schema.json"
)


@pytest.fixture(scope="module")
def schema() -> dict[str, Any]:
    with SCHEMA_PATH.open(encoding="utf-8") as handle:
        return json.load(handle)


def _validator(schema: dict[str, Any], name: str) -> Draft202012Validator:
    """A validator for one named definition, resolving ``$ref`` against the whole file."""
    return Draft202012Validator({**schema["$defs"][name], "$defs": schema["$defs"]})


class TestTheRequestBodies:
    """Every payload the tool posts is one the route's own schema accepts."""

    async def test_the_fixture_is_where_the_contract_lives(self, schema: dict[str, Any]) -> None:
        """A guard on the guard: a moved fixture must fail loudly, not silently pass."""
        assert "internalDocumentVersionRequest" in schema["$defs"]

    async def test_create_validates(self, schema, _one_store, monkeypatch, calls) -> None:
        await _write(_one_store)
        monkeypatch.setattr(
            filing_tools,
            "post_document_version",
            _responder([{"documentId": "doc-1", "version": _version("ver-1", "draft", "h1")}], calls),
        )
        await filing_tools.run_file_draft(DRAFT)

        _validator(schema, "internalDocumentVersionRequest").validate(calls[0][0])

    async def test_update_validates(self, schema, _one_store, monkeypatch, calls) -> None:
        await _write(_one_store)
        monkeypatch.setattr(
            filing_tools,
            "post_document_version",
            _responder(
                [
                    {"documentId": "doc-1", "version": _version("ver-1", "draft", "h1")},
                    {"documentId": "doc-1", "version": _version("ver-1", "draft", "h2")},
                ],
                calls,
            ),
        )
        await filing_tools.run_file_draft(DRAFT)
        await _edit(_one_store, "42 m", "38 m")
        await filing_tools.run_file_draft(DRAFT)

        assert calls[1][0]["op"] == "update"
        _validator(schema, "internalDocumentVersionRequest").validate(calls[1][0])

    async def test_submit_validates(self, schema, _one_store, monkeypatch, calls) -> None:
        await _write(_one_store)
        monkeypatch.setattr(
            filing_tools,
            "post_document_version",
            _responder(
                [
                    {"documentId": "doc-1", "version": _version("ver-1", "draft", "h1")},
                    {"documentId": "doc-1", "version": _version("ver-1", "in_review", "h1")},
                ],
                calls,
            ),
        )
        await filing_tools.run_file_draft(DRAFT)
        await filing_tools.run_submit_draft(DRAFT)

        assert calls[1][0]["op"] == "submit"
        _validator(schema, "internalDocumentVersionRequest").validate(calls[1][0])


class TestTheResponseShape:
    """What the tool reads back out of the answer is what the schema promises."""

    def test_every_field_the_tool_reads_is_in_the_version_view(self, schema: dict[str, Any]) -> None:
        properties = schema["$defs"]["documentVersionView"]["properties"]
        for field in ("id", "documentId", "state", "contentHash"):
            assert field in properties, field

    def test_the_card_knows_exactly_the_states_the_schema_does(self, schema: dict[str, Any]) -> None:
        """`DocumentVersionState` is mirrored, not imported; the fixture is the pin.

        A state added on the TS side and not here would arrive on a card that
        refuses to validate, so the reader would lose the whole card rather than
        one badge.
        """
        from typing import get_args

        wire = schema["$defs"]["documentVersionView"]["properties"]["state"]["enum"]
        assert set(get_args(DocumentVersionState)) == set(wire)
