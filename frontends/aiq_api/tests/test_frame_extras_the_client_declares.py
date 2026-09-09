"""The last hop of the transparency crossing: frame → the client's schema.

``_TRANSPARENCY_EXTRA_FIELDS`` and ``_SKILLS_EXTRA_FIELDS`` are the names the
websocket handler attaches to the terminal frame. What happens to a name the
frontend has never heard of is the point: ``NATSystemResponseMessageSchema`` is
a Zod object that STRIPS undeclared keys, so such a field is parsed away at the
client with nothing raised, nothing logged and no test failing anywhere on this
side. The field is set, lifted, serialised, sent — and gone.

``test_stream_extras_reach_the_frame.py`` pins the two hops before this one
(answer → chunk → frame) and cannot see this one, because it asserts on the
frame the handler sends rather than on what survives being read. The frontend's
``research-truncated-wire.spec.ts`` does watch this hop, from the other side —
but it runs in the UI suite, which is a different CI job and not part of
``task verify``'s Python half, so a backend-only change learns about it late or
not at all. This file is that guard on the side that does the lifting.

It reads the frontend source rather than a copied list, for the reason every
parity guard in this repo does: a hand-written mirror of the truth is one more
thing that can be wrong in the same way.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from aiq_api.websocket_reconnect import _SKILLS_EXTRA_FIELDS
from aiq_api.websocket_reconnect import _TRANSPARENCY_EXTRA_FIELDS

REPO_ROOT = Path(__file__).resolve().parents[3]
CLIENT_SCHEMA = REPO_ROOT / "frontends" / "ui" / "src" / "adapters" / "api" / "schemas.ts"

#: A top-level field of the Zod object: two spaces of indentation and a name.
#: Nested fields are indented further, which is what keeps a source entry like
#: ``file_name`` from reading as a frame field.
_FIELD_RE = re.compile(r"^ {2}([A-Za-z_][A-Za-z0-9_]*):", re.MULTILINE)


def _declared_frame_fields() -> set[str]:
    """The keys ``NATSystemResponseMessageSchema`` declares, from its source."""
    source = CLIENT_SCHEMA.read_text(encoding="utf-8")
    _head, marker, body = source.partition("export const NATSystemResponseMessageSchema = z.object({")
    assert marker, f"NATSystemResponseMessageSchema not found in {CLIENT_SCHEMA}"
    return set(_FIELD_RE.findall(body.split("\n})")[0]))


def test_the_guard_is_actually_reading_the_client_schema() -> None:
    """A regex that quietly stopped matching would pass everything below."""
    declared = _declared_frame_fields()
    assert {"content", "status", "research_truncated"} <= declared
    assert len(declared) > 15


@pytest.mark.parametrize("name", [*_TRANSPARENCY_EXTRA_FIELDS, *_SKILLS_EXTRA_FIELDS])
def test_every_extra_this_handler_lifts_is_one_the_client_declares(name: str) -> None:
    assert name in _declared_frame_fields(), (
        f"{name!r} is lifted onto the websocket frame by websocket_reconnect.py but "
        f"{CLIENT_SCHEMA.name} does not declare it, so Zod strips it on arrival and the "
        f"field reaches nobody. Declare it in NATSystemResponseMessageSchema (and read it "
        f"somewhere) in the SAME change that lifts it, or do not lift it yet."
    )
