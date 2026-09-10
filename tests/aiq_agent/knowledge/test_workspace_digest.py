"""The workspace (Büro) digest client and the block it renders.

Two things are worth a test here and nothing else is: that EVERY way the call
can fail comes back as ``None`` (the turn must proceed on the frozen
connection-time context — losing register recall costs recall, never
correctness), and that the rendered block is deterministic and bounded, because
it is read by a model on every office turn and an unbounded one grows with the
size of the organization.
"""

import contextlib
import io
import json

from aiq_agent.knowledge import project_memory as pm
from aiq_agent.knowledge import workspace_digest as wd


class _FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@contextlib.contextmanager
def _patched_opener(monkeypatch, *, body=None, raw=None, error=None):
    captured = {}

    class _Opener:
        def open(self, request, timeout=None):  # noqa: ANN001
            captured["url"] = request.full_url
            captured["headers"] = request.headers
            captured["method"] = request.get_method()
            captured["timeout"] = timeout
            if error is not None:
                raise error
            payload = raw if raw is not None else json.dumps(body).encode("utf-8")
            return _FakeResponse(payload)

    # The client reuses the memory client's opener, so patching it there is
    # patching the one socket both digests go through.
    monkeypatch.setattr(pm, "_opener", _Opener())
    monkeypatch.setattr(wd, "_opener", _Opener())
    yield captured


_BODY = {
    "digest": "ORG_MEMORY v1\n- Das Büro plant überwiegend Wohnbau",
    "projects": [
        {
            "id": "proj_1",
            "name": "Seestadt Baufeld D",
            "steckbrief": "Wohnbau, GK5, Wien, in Einreichung",
            "score": 0.9,
        },
        {"id": "proj_2", "name": "Volksschule Krems", "steckbrief": "Bildungsbau, NÖ, Vorentwurf", "score": 0.4},
    ],
}


class TestFetch:
    def test_returns_none_without_an_organization(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
        assert wd.fetch_workspace_digest(organization_id=None, membership_id="om_1", query="x") is None

    def test_returns_none_without_a_token(self, monkeypatch):
        """A deployment gap must not raise on the critical path — unlike the
        memory digest, this one has a fallback of exactly nothing to lose."""
        monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
        assert wd.fetch_workspace_digest(organization_id="org_1", membership_id="om_1", query="x") is None

    def test_parses_both_halves(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
        with _patched_opener(monkeypatch, body=_BODY) as captured:
            result = wd.fetch_workspace_digest(organization_id="org_1", membership_id="om_1", query="Holzbau GK5")

        assert result is not None
        assert result.digest.startswith("ORG_MEMORY v1")
        assert [p.id for p in result.projects] == ["proj_1", "proj_2"]
        assert result.projects[0].name == "Seestadt Baufeld D"
        assert result.projects[0].score == 0.9
        assert "/api/internal/workspace/digest?" in captured["url"]
        assert "organizationId=org_1" in captured["url"]
        assert "membershipId=om_1" in captured["url"]
        assert "q=Holzbau+GK5" in captured["url"]
        assert captured["method"] == "GET"

    def test_rides_the_same_critical_path_timeout_as_the_memory_digest(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
        with _patched_opener(monkeypatch, body=_BODY) as captured:
            wd.fetch_workspace_digest(organization_id="org_1", membership_id="om_1", query="x")
        assert captured["timeout"] == pm._DIGEST_TIMEOUT_SECONDS

    def test_the_limit_is_clamped_to_what_the_endpoint_accepts(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
        with _patched_opener(monkeypatch, body=_BODY) as captured:
            wd.fetch_workspace_digest(organization_id="org_1", membership_id="om_1", query="x", limit=99)
        assert "limit=10" in captured["url"]

    def test_a_missing_membership_still_asks(self, monkeypatch):
        """Without a membership the endpoint serves the digest and no projects —
        that is ITS rule (readability is a BFF fact), so the client still asks
        instead of deciding the answer here."""
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
        with _patched_opener(monkeypatch, body={"digest": "d", "projects": []}) as captured:
            result = wd.fetch_workspace_digest(organization_id="org_1", membership_id=None, query="x")
        assert result is not None
        assert result.projects == ()
        assert "membershipId" not in captured["url"]

    def test_a_timeout_fails_open(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
        with _patched_opener(monkeypatch, error=TimeoutError("timed out")):
            assert wd.fetch_workspace_digest(organization_id="org_1", membership_id="om_1", query="x") is None

    def test_a_transport_failure_fails_open(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
        with _patched_opener(monkeypatch, error=OSError("connection refused")):
            assert wd.fetch_workspace_digest(organization_id="org_1", membership_id="om_1", query="x") is None

    def test_a_500_fails_open(self, monkeypatch):
        import urllib.error

        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
        error = urllib.error.HTTPError("http://f/x", 500, "boom", {}, None)
        with _patched_opener(monkeypatch, error=error):
            assert wd.fetch_workspace_digest(organization_id="org_1", membership_id="om_1", query="x") is None

    def test_malformed_json_fails_open(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
        with _patched_opener(monkeypatch, raw=b"<html>not json</html>"):
            assert wd.fetch_workspace_digest(organization_id="org_1", membership_id="om_1", query="x") is None

    def test_an_empty_body_fails_open(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
        with _patched_opener(monkeypatch, raw=b""):
            assert wd.fetch_workspace_digest(organization_id="org_1", membership_id="om_1", query="x") is None

    def test_a_json_array_is_not_a_response(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
        with _patched_opener(monkeypatch, body=[1, 2, 3]):
            assert wd.fetch_workspace_digest(organization_id="org_1", membership_id="om_1", query="x") is None

    def test_a_malformed_entry_is_dropped_and_the_rest_survives(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
        body = {
            "digest": None,
            "projects": [
                {"id": "", "name": "nameless id"},
                {"name": "no id at all"},
                "not an object",
                {"id": "proj_ok", "name": "Gut", "steckbrief": None, "score": "high"},
            ],
        }
        with _patched_opener(monkeypatch, body=body):
            result = wd.fetch_workspace_digest(organization_id="org_1", membership_id="om_1", query="x")
        assert result is not None
        assert result.digest is None
        assert [p.id for p in result.projects] == ["proj_ok"]
        assert result.projects[0].steckbrief == ""
        assert result.projects[0].score == 0.0

    def test_more_projects_than_the_block_shows_are_cut_at_the_source(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
        body = {"digest": None, "projects": [{"id": f"p{i}", "name": f"P{i}"} for i in range(12)]}
        with _patched_opener(monkeypatch, body=body):
            result = wd.fetch_workspace_digest(organization_id="org_1", membership_id="om_1", query="x")
        assert len(result.projects) == wd.MAX_PROJECT_ENTRIES

    def test_the_office_digest_reports_what_it_carried(self, monkeypatch):
        """ADR-0055 contract C2, on the Büro's one round trip.

        The office reads organization memory on every turn and told nobody which
        notes those were; the same three fields the project digest gained ride
        this response too, so the office marker is fed from the read that
        actually happened.
        """
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
        body = {
            "digest": "ORG_MEMORY v1",
            "projects": [],
            "carried": [{"id": "m1", "kind": "preference", "content": "Wir zeichnen in ArchiCAD"}],
            "omitted": 2,
            "total": 11,
        }
        with _patched_opener(monkeypatch, body=body):
            result = wd.fetch_workspace_digest(organization_id="org_1", membership_id="om_1", query="x")
        assert result is not None
        assert [note.id for note in result.carry.carried] == ["m1"]
        assert (result.carry.omitted, result.carry.total) == (2, 11)

    def test_an_older_bff_without_the_carry_fields_costs_the_office_turn_nothing(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
        with _patched_opener(monkeypatch, body={"digest": "ORG_MEMORY v1", "projects": []}):
            result = wd.fetch_workspace_digest(organization_id="org_1", membership_id="om_1", query="x")
        assert result is not None
        assert result.digest == "ORG_MEMORY v1"
        assert not result.carry


class TestRenderWorkspaceContext:
    def test_names_every_project_with_its_id_and_says_it_is_bounded(self):
        digest = wd.WorkspaceDigest(
            digest="ORG_MEMORY v1\n- Wohnbau",
            projects=(
                wd.WorkspaceProject(id="proj_1", name="Seestadt", steckbrief="Wohnbau, GK5", score=0.9),
                wd.WorkspaceProject(id="proj_2", name="Krems", steckbrief="Bildungsbau", score=0.4),
            ),
        )
        block = wd.render_workspace_context(digest)

        assert block.startswith("WORKSPACE_CONTEXT v1")
        assert "ORG_MEMORY v1" in block
        assert "Seestadt" in block and "proj_1" in block
        assert "Krems" in block and "proj_2" in block
        # Bounded, and it says so in the text the model reads (AGENTS.md).
        assert "BEGRENZTE" in block
        assert "nicht die Liste aller Projekte" in block
        # And it says what a Steckbrief does not license (spec PR-15).
        assert "KEINE Dokumentinhalte" in block

    def test_it_is_deterministic(self):
        digest = wd.WorkspaceDigest(
            digest="d", projects=(wd.WorkspaceProject(id="p", name="n", steckbrief="s", score=0.1),)
        )
        assert wd.render_workspace_context(digest) == wd.render_workspace_context(digest)

    def test_a_long_steckbrief_is_cut(self):
        digest = wd.WorkspaceDigest(projects=(wd.WorkspaceProject(id="p", name="n", steckbrief="x" * 5000, score=0.1),))
        block = wd.render_workspace_context(digest)
        assert len(block) < wd.STECKBRIEF_MAX_CHARS + 1500
        assert "…" in block

    def test_five_full_steckbriefe_stay_within_the_block_ceiling(self):
        """The worst realistic office turn: five 3000-character Steckbriefe (the
        ADR's own ceiling) and an organization digest. The per-entry bound alone
        must keep that inside the block ceiling, so the global cut below is a
        backstop rather than the mechanism."""
        digest = wd.WorkspaceDigest(
            digest="ORG " * 200,
            projects=tuple(
                wd.WorkspaceProject(id=f"p{i}", name=f"Projekt {i}", steckbrief="y" * 3000, score=0.5) for i in range(5)
            ),
        )
        block = wd.render_workspace_context(digest)
        assert len(block) <= wd.BLOCK_MAX_CHARS
        for i in range(5):
            assert f"Projekt {i}" in block, "an entry was silently dropped by the per-entry bound"

    def test_the_block_ceiling_cuts_and_says_it_cut(self):
        """Belt to the per-entry braces: whatever else grows — a longer memory
        digest, mounted project views — the block still cannot run away, and a
        cut block says it is a cut block."""
        digest = wd.WorkspaceDigest(digest="ORG " * 4000, projects=())
        block = wd.render_workspace_context(digest)
        assert len(block) <= wd.BLOCK_MAX_CHARS + 200
        assert "gekürzt" in block

    def test_no_recall_still_states_the_turn_is_in_the_office(self):
        """A failed fetch must not read as "this office has no matching
        projects" — that is a claim, and the turn cannot make it."""
        block = wd.render_workspace_context(None)
        assert block.startswith("WORKSPACE_CONTEXT v1")
        assert "im Büro" in block
        assert "nicht erreichbar" in block
        assert "find_projects" in block

    def test_an_empty_register_says_so_without_claiming_the_office_is_empty(self):
        block = wd.render_workspace_context(wd.WorkspaceDigest(digest="d", projects=()))
        assert "Keine passenden Projekte" in block
        assert "nicht, dass es keine gibt" in block

    def test_a_mounted_project_view_is_labelled_with_its_name_and_id(self):
        """Phase 3 passes these; the shape is pinned now so the office block
        does not grow a second, differently-labelled way to name a project."""
        block = wd.render_workspace_context(
            wd.WorkspaceDigest(projects=()),
            [("Seestadt", "proj_1", "PROJECT_CONTEXT v1\nconfirmed:\n- gk=5")],
        )
        assert "Eingeblendetes Projekt: Seestadt (id: proj_1)" in block
        assert "gk=5" in block


class TestIsWorkspaceTurn:
    """Which turns are in the office. One rule, in one place."""

    def test_an_organization_without_a_project_is_the_office(self):
        assert wd.is_workspace_turn(organization_id="org_1", project_id=None) is True

    def test_a_project_turn_is_not(self):
        assert wd.is_workspace_turn(organization_id="org_1", project_id="proj_1") is False

    def test_an_anonymous_turn_is_not(self):
        """No organization means no office to read — not an empty one."""
        assert wd.is_workspace_turn(organization_id=None, project_id=None) is False

    def test_a_blank_organization_is_no_organization(self):
        assert wd.is_workspace_turn(organization_id="", project_id=None) is False


class TestClampedLimit:
    """How many Steckbriefe a caller gets to ask for.

    One number, three callers (this client, the `find_projects` tool, a
    portfolio run's readable set) and one endpoint ceiling behind all of them.
    The clamp is honesty rather than defence: what it returns is what the caller
    will actually be able to read, so a block rendered from it can say how many
    of how many it names without lying.
    """

    def test_an_ordinary_request_passes_through(self):
        assert wd.clamped_limit(3) == 3
        assert wd.clamped_limit(wd.RECALL_MAX_LIMIT) == wd.RECALL_MAX_LIMIT

    def test_more_than_the_endpoint_serves_is_cut_to_what_it_serves(self):
        """Asking for forty returns ten anyway. Passing forty on would only let
        the result block claim a completeness it never had."""
        assert wd.clamped_limit(40) == wd.RECALL_MAX_LIMIT

    def test_no_request_at_all_is_the_callers_own_default(self):
        assert wd.clamped_limit(None) == wd.MAX_PROJECT_ENTRIES
        assert wd.clamped_limit(None, default=2) == 2

    def test_a_size_that_is_not_a_size_is_the_default_and_never_one(self):
        """Zero, a negative and a non-number are one statement — "no particular
        number" — and one project is not what that means anywhere here: it would
        answer „alle Projekte in Wien" with a single Steckbrief and read, to the
        model, as an office with one project in it."""
        for garbage in (0, -3, "sieben", object(), [], True, False):
            assert wd.clamped_limit(garbage, default=4) == 4, garbage

    def test_a_numeric_string_is_a_number(self):
        """The model writes JSON; a quoted count is the same ask."""
        assert wd.clamped_limit("8") == 8

    def test_the_default_is_clamped_too(self):
        """A misconfigured `max_results` must not become a request the endpoint
        silently truncates — the caller would still print the number it asked
        for."""
        assert wd.clamped_limit(None, default=99) == wd.RECALL_MAX_LIMIT
        assert wd.clamped_limit(None, default=0) == 1


class TestBoundedProjectIds:
    """The model's own list of project ids, on its way into an expensive run.

    It is written by a language model into a JSON envelope, so every shape a
    model gets wrong arrives here: a string instead of a list, a blank entry,
    the same project twice, forty of them. What comes out is what a portfolio
    run can actually read, or ``None`` — and ``None`` is an instruction, not a
    failure: read every project the caller may read.
    """

    def test_the_ids_survive_in_the_order_they_were_named(self):
        assert wd.bounded_project_ids(["proj_b", "proj_a"]) == ["proj_b", "proj_a"]

    def test_blanks_non_strings_and_repeats_are_dropped(self):
        assert wd.bounded_project_ids(["proj_a", "  ", None, 7, "proj_a", " proj_b "]) == [
            "proj_a",
            "proj_b",
        ]

    def test_more_than_a_run_can_read_is_cut_to_what_it_can(self):
        many = [f"proj_{i}" for i in range(40)]
        assert wd.bounded_project_ids(many) == many[: wd.RECALL_MAX_LIMIT]

    def test_nothing_usable_reads_as_named_nothing(self):
        for value in ([], ["", "   "], "proj_a", None, {"id": "proj_a"}):
            assert wd.bounded_project_ids(value) is None, value
