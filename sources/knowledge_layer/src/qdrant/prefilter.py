"""``knowledge_search``'s narrowing, pushed into the Qdrant query instead of run after it (ADR-0114).

On the store this replaced, the human-set facts lived only in Postgres, so
``register.search`` fetched three times ``top_k`` and dropped what did not
match (``doc_class``, ``folder``), and named the files to rank by list
(``file_name $in`` for a folder, ``$nin`` for superseded Fassungen). Those
facts are copied onto every point (``payload.document_facts``), so each one
becomes a condition inside the vector search and no candidate is fetched only
to be thrown away:

=================  ====================================  ========================
Filter             Pushed down as                        Post-filter kept?
=================  ====================================  ========================
``doc_class``      ``doc_class = X``                      yes, as the backstop
``folder``         ``folder_ancestors`` contains the key  yes, as the backstop
superseded         ``superseded != true`` (user shelves)  yes, as the backstop
``title_contains`` not pushed down                        yes, and over-fetches
``file_name``      not pushed down                        yes, and over-fetches
=================  ====================================  ========================

``title_contains`` is a case-insensitive SUBSTRING of the file name or of the
display title, and Qdrant's full-text index matches tokens: ``schutz`` is in
``Brandschutzkonzept`` and is not one of its tokens. A token pre-filter would
drop documents the substring rule keeps, so it stays a post-filter.
``file_name`` likewise matches either name containing the other.

**Postgres stays the authority.** A copied fact can lag the store by a failed
copy (``writes.refresh_facts`` never raises) until the weekly vector
reconcile copies every live collection's facts again (``writes.copy_facts``,
through ``POST /v1/maintenance/refresh-document-facts``). So the rules are:

* A pre-filter only ever NARROWS: it is AND-ed onto the scope filter, never a
  replacement for one, and the Postgres post-filter still runs over what comes
  back (no over-fetch: a stale mirror costs recall, never correctness of what
  is shown). A pre-filter can therefore never admit a hit the post-filter
  refuses.
* The superseded exclusion is the one where a stale mirror would SHOW
  something wrong (a replaced Fassung back in the ranking), so the Postgres
  list still drops those hits after retrieval (:func:`without_files`).
* ``doc_class`` is human-set and beats every filename guess: the payload holds
  the stored class when there is one and the chunk's own otherwise, which is
  exactly what ``register._hit_doc_class`` resolves.

This module builds filters in the backend-neutral grammar the adapter accepts,
so every condition still goes through ``scope.scope_filter``. It imports no
``qdrant_client``.
"""

from __future__ import annotations

from collections.abc import Iterable
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

#: Payload field the folder filter matches (see :func:`folder_ancestors`).
FOLDER_FIELD = "folder_ancestors"


def folder_key(path: Any) -> str | None:
    """A folder path as the folder filter compares it: slashes trimmed, case folded; None for the root.

    The normalisation ``register._folder_matches`` applies to both sides,
    because the agent retypes the folder name from the inventory.
    """
    key = str(path or "").strip().strip("/").casefold()
    return key or None


def folder_ancestors(path: Any) -> list[str]:
    """Every folder ``path`` is filed in or beneath, spelled as :func:`folder_key` spells them.

    ``Brandschutz/Fluchtwege`` gives ``["brandschutz", "brandschutz/fluchtwege"]``,
    so "this folder and below" is one exact match on the array, and the ``/``
    boundary keeps ``Brandschutzkonzepte`` out of ``Brandschutz`` for free.
    Qdrant 1.19's keyword prefix match was the alternative; it is
    case-sensitive and crosses the ``/`` boundary, so it would need a folded
    copy of the path and two conditions to say what this says in one.
    """
    key = folder_key(path)
    if key is None:
        return []
    parts = [part for part in key.split("/") if part]
    return ["/".join(parts[: depth + 1]) for depth in range(len(parts))]


@dataclass(frozen=True)
class Pushdown:
    """The narrowing one ``knowledge_search`` call sends into the Qdrant query."""

    doc_class: str | None = None
    #: The folder as :func:`folder_key` spells it.
    folder: str | None = None
    #: False when the caller named a file: naming one is the way back to an older Fassung.
    hide_superseded: bool = True

    def clauses(self, *, user_shelf: bool) -> list[dict[str, Any]]:
        """The conditions for one collection; superseded Fassungen are hidden on user shelves only.

        The base corpus has no Fassungen: it replaces by its own hash registry.
        """
        clauses: list[dict[str, Any]] = []
        if self.doc_class:
            clauses.append({"doc_class": self.doc_class})
        if self.folder:
            clauses.append({FOLDER_FIELD: self.folder})
        if self.hide_superseded and user_shelf:
            # ``$ne`` keeps a point the mirror has not stamped yet (scope.py).
            clauses.append({"superseded": {"$ne": True}})
        return clauses

    def narrow(self, filters: dict[str, Any] | None, *, user_shelf: bool) -> dict[str, Any] | None:
        """``filters`` AND this narrowing; never wider than ``filters`` alone."""
        clauses = self.clauses(user_shelf=user_shelf)
        if not clauses:
            return filters
        parts = [filters, *clauses] if filters else clauses
        return parts[0] if len(parts) == 1 else {"$and": parts}

    def fields(self, *, user_shelves: bool) -> list[str]:
        """The payload fields this search filtered on, for the trace (names, never values)."""
        return [
            field
            for field, used in (
                ("doc_class", bool(self.doc_class)),
                (FOLDER_FIELD, bool(self.folder)),
                ("superseded", self.hide_superseded and user_shelves),
            )
            if used
        ]


def plan(*, doc_class: str | None, folder: str | None, file_name: str | None) -> Pushdown:
    """The pushdown for one search."""
    return Pushdown(doc_class=doc_class or None, folder=folder_key(folder), hide_superseded=not file_name)


def post_filtered(*, title_contains: str | None, file_name: str | None) -> bool:
    """True when a filter still drops candidates only after retrieval, so the pool must be over-fetched.

    A pushed-down filter (``doc_class``, ``folder``, the superseded exclusion)
    does not: its post-filter is a backstop over hits that already match, not
    the narrowing itself.
    """
    return bool(title_contains or file_name)


def without_files(chunks: Sequence[Any], file_names: Iterable[str]) -> list[Any]:
    """``chunks`` minus those of ``file_names``: the Postgres backstop behind ``superseded != true``."""
    hidden = set(file_names)
    return [chunk for chunk in chunks if getattr(chunk, "file_name", None) not in hidden]
