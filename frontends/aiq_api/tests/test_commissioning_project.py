"""Which project a run is recorded against — the half nothing tested.

``_derive_project_collection`` runs once, at submit time, and its answer is
written to ``job_access.project_collection``. Everything downstream treats that
row as the authority on where a finished report may be filed: the report route
returns it, and the BFF derives the filing destination from it and consults
nothing the reader supplied.

So this function is the only place the run's project is decided, and it had no
test at all. Three mutations survived the whole backend suite before these:
returning ``None`` unconditionally (filing stops working everywhere, silently —
no ``filed``, no ``filingFailed``, no error), accepting an ambiguous scope
instead of refusing it, and dropping the ``s_`` exclusion so a conversation's
own scoped collection is taken for the project's.
"""

from __future__ import annotations

import pytest

from aiq_api.jobs.submit import _derive_project_collection


@pytest.fixture(autouse=True)
def _base_collection(monkeypatch):
    monkeypatch.setenv("OIB_COLLECTION_NAME", "oib_knowledge")
    monkeypatch.delenv("COLLECTION_NAME", raising=False)


def test_picks_the_project_collection_out_of_a_full_scope() -> None:
    """The ordinary shape: base corpus, the conversation's own, and the project."""
    assert _derive_project_collection(["oib_knowledge", "s_conv-1", "proj_abc"]) == "proj_abc"


def test_a_conversation_scoped_collection_is_not_a_project() -> None:
    """`s_<conversation>` holds the files dropped into one chat.

    Taking it for the project would record a run against a collection no project
    owns, and the report would then be filed nowhere at all — the BFF resolves
    the collection to a project id and declines when there is none.
    """
    assert _derive_project_collection(["oib_knowledge", "s_conv-1"]) is None


def test_the_base_corpus_alone_is_not_a_project() -> None:
    assert _derive_project_collection(["oib_knowledge"]) is None


def test_the_office_archive_is_not_a_project() -> None:
    """Live chat scope is base + Archiv + project + session.

    Archiv is fail-open (`organization-archiv`). Treating it as a candidate
    left two names after the `s_` exclusion, so a normal project submit
    recorded no commissioning collection and the finished report was never
    filed. The archive is not a project; drop it the same way as `s_`.
    """
    assert _derive_project_collection(["oib_knowledge", "archiv_org1", "proj_abc", "s_conv-1"]) == "proj_abc"
    assert _derive_project_collection(["oib_knowledge", "archiv_org1", "s_conv-1"]) is None


def test_an_ambiguous_scope_is_refused_rather_than_guessed() -> None:
    """Two candidates means the request did not say which project.

    Guessing here writes a wrong project onto the run, and the cover sheet of
    the report filed from it names that project's Bundesland — the line that
    says which Bauordnung the report was checked against.
    """
    assert _derive_project_collection(["oib_knowledge", "proj_abc", "proj_xyz"]) is None


def test_no_scope_at_all() -> None:
    assert _derive_project_collection(None) is None
    assert _derive_project_collection([]) is None


def test_the_base_collection_is_read_from_the_environment(monkeypatch) -> None:
    """A deployment that renamed its corpus must not have it read as a project."""
    monkeypatch.setenv("OIB_COLLECTION_NAME", "at_normen")
    assert _derive_project_collection(["at_normen", "proj_abc"]) == "proj_abc"
    # And the default name is then just another collection, so a scope carrying
    # both is ambiguous rather than silently resolved to one of them.
    assert _derive_project_collection(["at_normen", "oib_knowledge", "proj_abc"]) is None
