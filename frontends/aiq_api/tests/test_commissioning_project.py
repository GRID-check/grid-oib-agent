"""Which project a run is recorded against — the half nothing tested.

``derive_project_collection`` runs at submit time, and its answer is
written to ``job_access.project_collection``. Everything downstream treats that
row as the authority on where a finished report may be filed: the report route
returns it, and the BFF derives the filing destination from it and consults
nothing the reader supplied. A later request asks it the same question of the
scope its envelope signed, to decide whether that request reaches the run
(ADR-0084).

So this function is the only place the run's project is decided, and it had no
test at all. Three mutations survived the whole backend suite before these:
returning ``None`` unconditionally (filing stops working everywhere, silently —
no ``filed``, no ``filingFailed``, no error), accepting an ambiguous scope
instead of refusing it, and dropping the ``s_`` exclusion so a conversation's
own scoped collection is taken for the project's.
"""

from __future__ import annotations

import pytest

from aiq_api.jobs.access import derive_project_collection


@pytest.fixture(autouse=True)
def _base_collection(monkeypatch):
    monkeypatch.setenv("OIB_COLLECTION_NAME", "oib_knowledge")
    monkeypatch.delenv("COLLECTION_NAME", raising=False)


def test_picks_the_project_collection_out_of_a_full_scope() -> None:
    """The ordinary shape: base corpus, the conversation's own, and the project."""
    assert derive_project_collection(["oib_knowledge", "s_conv-1", "proj_abc"]) == "proj_abc"


def test_a_conversation_scoped_collection_is_not_a_project() -> None:
    """`s_<conversation>` holds the files dropped into one chat.

    Taking it for the project would record a run against a collection no project
    owns, and the report would then be filed nowhere at all — the BFF resolves
    the collection to a project id and declines when there is none.
    """
    assert derive_project_collection(["oib_knowledge", "s_conv-1"]) is None


def test_the_base_corpus_alone_is_not_a_project() -> None:
    assert derive_project_collection(["oib_knowledge"]) is None


def test_the_office_archive_is_not_a_project() -> None:
    """Live chat scope is base + Archiv + project + session.

    Archiv is fail-open (`organization-archiv`). Treating it as a candidate
    left two names after the `s_` exclusion, so a normal project submit
    recorded no commissioning collection and the finished report was never
    filed. The archive is not a project; drop it the same way as `s_`.
    """
    assert derive_project_collection(["oib_knowledge", "archiv_org1", "proj_abc", "s_conv-1"]) == "proj_abc"
    assert derive_project_collection(["oib_knowledge", "archiv_org1", "s_conv-1"]) is None


def test_an_ambiguous_scope_is_refused_rather_than_guessed() -> None:
    """Two candidates means the request did not say which project.

    Guessing here writes a wrong project onto the run, and the cover sheet of
    the report filed from it names that project's Bundesland — the line that
    says which Bauordnung the report was checked against.
    """
    assert derive_project_collection(["oib_knowledge", "proj_abc", "proj_xyz"]) is None


def test_no_scope_at_all() -> None:
    assert derive_project_collection(None) is None
    assert derive_project_collection([]) is None


def test_the_base_collection_is_read_from_the_environment(monkeypatch) -> None:
    """A deployment that renamed its corpus must not have it read as a project."""
    monkeypatch.setenv("OIB_COLLECTION_NAME", "at_normen")
    assert derive_project_collection(["at_normen", "proj_abc"]) == "proj_abc"
    # And the default name is then just another collection, so a scope carrying
    # both is ambiguous rather than silently resolved to one of them.
    assert derive_project_collection(["at_normen", "oib_knowledge", "proj_abc"]) is None


# ADR-0087: a restricted folder's documents live in `<project collection>_r<12 hex>`,
# and a cleared member's chat scope carries it beside the project's own collection.
_RESTRICTED = "proj_abc_r0123456789ab"


def test_a_restricted_folder_collection_is_its_project_not_a_second_one() -> None:
    """Counted as itself it made the scope ambiguous, and the run recorded no project."""
    scope = ["oib_knowledge", "archiv_org1", "proj_abc", _RESTRICTED, "s_conv-1"]
    assert derive_project_collection(scope) == "proj_abc"


def test_a_restricted_collection_alone_records_its_base_project() -> None:
    """Recorded verbatim, the BFF would resolve it to no project and file the report nowhere."""
    assert derive_project_collection(["oib_knowledge", _RESTRICTED]) == "proj_abc"


def test_two_projects_stay_ambiguous_with_a_restricted_collection_in_scope() -> None:
    assert derive_project_collection(["oib_knowledge", "proj_xyz", _RESTRICTED]) is None


def test_only_the_exact_restricted_suffix_is_read_as_one() -> None:
    """Eleven hex digits, or a non-hex one, is an ordinary (if odd) collection name."""
    assert derive_project_collection(["oib_knowledge", "proj_abc", "proj_abc_r0123456789a"]) is None
    assert derive_project_collection(["oib_knowledge", "proj_abc", "proj_abc_r0123456789ag"]) is None
