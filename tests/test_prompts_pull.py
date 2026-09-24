"""Pulling a Langfuse version into review (`scripts/prompts_pull.py`).

Git is the platform prompt's source of truth (ADR-0060 (a)); this script only
ever reads from Langfuse and writes the committed file, which is how an edit
made there is brought into review. The cases worth pinning are the
ones a maintainer would otherwise discover by finding the wrong thing committed:
a fallback overwritten with nothing because the label does not exist, a diff
that is one trailing newline, and a run that reports success without
credentials.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]


def _load(name: str, relative: str):
    """Import a top-level script by path, the way tests/test_release_notes.py does."""
    if str(REPO_ROOT) not in sys.path:
        sys.path.insert(0, str(REPO_ROOT))
    spec = importlib.util.spec_from_file_location(name, REPO_ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


pull = _load("scripts.prompts_pull", "scripts/prompts_pull.py")

BUNDLED = REPO_ROOT / "src/aiq_agent/agents/piloti/prompts/piloti_static.md"


@pytest.fixture(autouse=True)
def _the_real_fallback_is_never_written():
    """No test in this file may touch the prompt the agent actually renders.

    Written after a run of this suite overwrote it: `write_fallback`'s path
    was a DEFAULT ARGUMENT, bound at import to the real file, so patching the
    module constant moved nothing. The path resolves at call time now, and this
    fixture is the ratchet — a test that writes the real prompt fails here
    rather than in whichever suite next reads it.
    """
    before = BUNDLED.read_bytes()
    yield
    assert BUNDLED.read_bytes() == before, "a test wrote the real bundled prompt"


class FakePrompt:
    def __init__(self, prompt: str, version: int = 12):
        self.prompt = prompt
        self.version = version


class FakeClient:
    """Answers one `get_prompt` and records how it was asked."""

    def __init__(self, *, answer=None, raises: Exception | None = None):
        self.answer = answer
        self.raises = raises
        self.calls: list[dict] = []

    def get_prompt(self, name, *, label, cache_ttl_seconds, type):
        self.calls.append({"name": name, "label": label, "cache_ttl_seconds": cache_ttl_seconds, "type": type})
        if self.raises is not None:
            raise self.raises
        return self.answer


class TestFetch:
    def test_it_reads_the_labelled_version_without_a_cache(self):
        """
        A one-shot CLI must not be answered from a cache the store warmed a
        minute ago — that is how a maintainer commits a version that is already
        superseded.
        """
        client = FakeClient(answer=FakePrompt("LIVE TEXT"))

        assert pull.fetch_text(client, label="production") == "LIVE TEXT"
        assert client.calls[0] == {
            "name": "piloti-system-static",
            "label": "production",
            "cache_ttl_seconds": 0,
            "type": "text",
        }

    def test_a_missing_prompt_is_none_rather_than_an_error(self):
        from langfuse.api import NotFoundError

        client = FakeClient(raises=NotFoundError(body="no such prompt"))

        assert pull.fetch_text(client) is None

    def test_an_unreachable_langfuse_propagates(self):
        """
        Silence here would write "could not reach Langfuse" into the fallback
        as if it were the prompt. Only a 404 is an answer; everything else is a
        failure the maintainer has to see.
        """
        client = FakeClient(raises=RuntimeError("connection refused"))

        with pytest.raises(RuntimeError):
            pull.fetch_text(client)


class TestWriteFallback:
    def test_it_writes_the_text_with_exactly_one_trailing_newline(self, tmp_path: Path):
        target = tmp_path / "piloti_static.md"

        assert pull.write_fallback("SOME PROMPT\n\n\n", target) is True
        assert target.read_text() == "SOME PROMPT\n"

    def test_an_unchanged_file_is_not_rewritten(self, tmp_path: Path):
        """
        So `git status` after a pull says something true. A no-op write would
        leave a maintainer wondering what changed.
        """
        target = tmp_path / "piloti_static.md"
        target.write_text("SOME PROMPT\n")

        assert pull.write_fallback("SOME PROMPT", target) is False

    def test_the_bundled_file_round_trips_through_a_pull(self, tmp_path: Path):
        """
        The committed fallback is already normalized, so pulling the version it
        came from must be a no-op rather than a whitespace diff on every run.
        """
        bundled = REPO_ROOT / "src/aiq_agent/agents/piloti/prompts/piloti_static.md"
        target = tmp_path / "copy.md"
        target.write_text(bundled.read_text(encoding="utf-8"), encoding="utf-8")

        assert pull.write_fallback(bundled.read_text(encoding="utf-8"), target) is False


class TestMain:
    def test_without_credentials_it_exits_two_and_touches_nothing(self, monkeypatch, capsys):
        monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
        monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)

        assert pull.main([]) == 2
        assert "not set" in capsys.readouterr().err

    def test_a_label_that_does_not_exist_exits_one_without_writing(self, monkeypatch, tmp_path, capsys):
        from langfuse.api import NotFoundError

        target = tmp_path / "piloti_static.md"
        target.write_text("BUNDLED\n")
        monkeypatch.setattr(pull, "FALLBACK_FILE", target)
        monkeypatch.setattr(pull, "build_client", lambda: FakeClient(raises=NotFoundError(body="nope")))

        assert pull.main(["--label", "experiment-a"]) == 1
        assert target.read_text() == "BUNDLED\n"
        assert "no 'experiment-a' version" in capsys.readouterr().err

    def test_a_successful_pull_rewrites_the_fallback(self, monkeypatch, tmp_path, capsys):
        target = tmp_path / "piloti_static.md"
        target.write_text("OLD\n")
        monkeypatch.setattr(pull, "FALLBACK_FILE", target)
        monkeypatch.setattr(pull, "REPO_ROOT", tmp_path)
        monkeypatch.setattr(pull, "build_client", lambda: FakeClient(answer=FakePrompt("NEW LIVE TEXT")))

        assert pull.main([]) == 0
        assert target.read_text() == "NEW LIVE TEXT\n"
        assert "updated" in capsys.readouterr().out


class TestThePullOnlyReads:
    def test_the_script_can_only_read_from_langfuse(self):
        """
        The pull brings a Langfuse version INTO review; it never writes to
        Langfuse. Publishing is `scripts/prompts_push.py`, one script with one
        guard (it never overwrites a version edited in Langfuse), so a
        `create_prompt` or `update_prompt` appearing here is a second push path.
        """
        source = (REPO_ROOT / "scripts/prompts_pull.py").read_text(encoding="utf-8")

        assert "create_prompt" not in source
        assert "update_prompt" not in source

    def test_there_is_one_push_path(self):
        assert not (REPO_ROOT / "scripts/prompts_sync.py").exists()
