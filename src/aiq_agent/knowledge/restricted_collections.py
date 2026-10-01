"""Restricted-folder collections, as the Python side recognises them (ADR-0078).

A document filed under a restricted project folder is ingested into its own
collection, ``<project collection>_r<12 hex of the folder id>``, and the BFF
puts that collection into a turn's signed scope only for a member cleared for
the folder, and only in interactive chat. The name is minted in one place,
``restrictedCollectionName`` in ``frontends/ui/src/lib/authz/folder-access.ts``;
this module is its reader and must agree with it.

Retrieval needs nothing from here: every read path stays inside the signed
scope. Two other kinds of reader do:

- whoever derives the project from a scope (``aiq_api.jobs.submit``), which must
  read a restricted collection as its base project collection rather than as a
  second, competing project;
- whoever writes something that outlives the turn and is read by people the
  restriction excludes. Project memory is that (ADR-0078, "indirect leaks"):
  a turn that could read restricted content writes none.

Prefix readers need nothing either: the name keeps its ``proj_`` prefix, so
:func:`aiq_agent.common.source_kinds.legacy_shelf_for_collection_name` already
reads it as the project shelf.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

#: ``<base>_r`` and exactly twelve hex digits at the end. Case-insensitive on
#: purpose: the BFF writes lowercase, and a reader that lowercases or uppercases
#: names on the way must not turn a restricted collection into an open one.
_RESTRICTED_NAME = re.compile(r"^(?P<base>.+)_r[0-9a-f]{12}$", re.IGNORECASE)


def is_restricted_collection(name: str | None) -> bool:
    """Whether ``name`` is the collection of a restricted folder."""
    return bool(name) and _RESTRICTED_NAME.match(name.strip()) is not None


def base_collection_of(name: str) -> str:
    """The project collection a restricted collection belongs to; any other name unchanged."""
    match = _RESTRICTED_NAME.match(name.strip())
    return match.group("base") if match else name


def restricted_collections_in(names: Iterable[str | None] | None) -> list[str]:
    """The restricted collections among ``names``, in order; empty for ``None``."""
    return [name for name in names or () if is_restricted_collection(name)]
