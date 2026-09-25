"""Publishing the committed platform prompt (`scripts/prompts_push.py`, ADR-0060 (a)).

The cases worth pinning are the ones that would cost somebody their work or
ship text nobody reviewed: an edit made in Langfuse overwritten by a push, a
check that writes, and a version published from a file that is in no commit.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]


def _load(name: str, relative: str):
    spec = importlib.util.spec_from_file_location(name, REPO_ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


push = _load("scripts.prompts_push", "scripts/prompts_push.py")


SHA = "b" * 40
#: What an earlier push wrote as the version's commit message.
PUBLISHED = f"git {SHA[:12]} piloti_static.md"


class FakePrompt:
    """A Langfuse version. Tags are the PROMPT's, so every version carries ``git``."""

    def __init__(self, prompt: str, *, version: int = 7, commit_message: str | None = PUBLISHED):
        self.prompt = prompt
        self.version = version
        self.tags = [push.GIT_TAG]
        self.commit_message = commit_message


class FakeClient:
    """One labelled version (or none), and a record of every version created."""

    def __init__(self, live: FakePrompt | None):
        self.live = live
        self.created: list[dict] = []

    def get_prompt(self, name, *, label, cache_ttl_seconds, type):
        if self.live is None:
            from langfuse.api import NotFoundError

            raise NotFoundError(body={"message": "not found"})
        return self.live

    def create_prompt(self, **kwargs):
        self.created.append(kwargs)
        return FakePrompt(kwargs["prompt"], version=(self.live.version + 1) if self.live else 1)


@pytest.fixture
def committed(monkeypatch, tmp_path):
    """The prompt file, in a scratch location, committed at a known sha."""
    path = tmp_path / "piloti_static.md"
    path.write_text("Regel eins.\nRegel zwei.\n", encoding="utf-8")
    monkeypatch.setattr(push, "FALLBACK_FILE", path)
    monkeypatch.setattr(push, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(push, "git_origin", lambda: ("a" * 40, False))
    # What git holds for each commit an earlier push named.
    history = {(SHA[:12], "piloti_static.md"): "Regel eins.\n"}
    monkeypatch.setattr(push, "text_at", lambda sha, relative: history.get((sha, relative)))
    return path


def _run(monkeypatch, client, *argv):
    monkeypatch.setattr(push, "build_client", lambda: client)
    return push.main(list(argv))


def test_a_label_that_already_serves_the_file_is_left_alone(monkeypatch, committed):
    # A trailing newline is not part of the prompt: the store strips it.
    client = FakeClient(FakePrompt("Regel eins.\nRegel zwei."))

    assert _run(monkeypatch, client, "--label", "production", "--apply") == push.EXIT_OK
    assert client.created == []


def test_the_check_says_what_would_change_and_writes_nothing(monkeypatch, committed, capsys):
    client = FakeClient(FakePrompt("Regel eins."))

    assert _run(monkeypatch, client) == push.EXIT_WOULD_CHANGE
    assert client.created == []
    assert "+Regel zwei." in capsys.readouterr().out


def test_apply_publishes_a_git_tagged_version_naming_its_commit(monkeypatch, committed):
    client = FakeClient(FakePrompt("Regel eins."))

    assert _run(monkeypatch, client, "--label", "staging", "--apply") == push.EXIT_OK
    [created] = client.created
    assert created["commit_message"] == "git aaaaaaaaaaaa piloti_static.md"
    assert created["prompt"] == "Regel eins.\nRegel zwei."
    assert created["labels"] == ["staging"]
    assert created["tags"] == [push.GIT_TAG]
    assert created["commit_message"].startswith("git aaaaaaaaaaaa ")


def test_an_edit_made_in_langfuse_is_never_overwritten(monkeypatch, committed, capsys):
    # Written and promoted in Langfuse. It carries the `git` tag anyway (tags
    # are the prompt's, not the version's), so the tag cannot tell; the text no
    # commit holds does. Publishing over it would discard an unreviewed edit.
    client = FakeClient(FakePrompt("Regel eins, in Langfuse verbessert.", commit_message="Tippfehler"))

    assert _run(monkeypatch, client, "--label", "production", "--apply") == push.EXIT_REFUSED
    assert client.created == []
    captured = capsys.readouterr()
    assert "task prompts:pull" in captured.err
    assert "-Regel eins, in Langfuse verbessert." in captured.out


def test_an_edit_that_kept_the_published_commit_message_is_still_refused(monkeypatch, committed):
    # The UI can carry the old message over; the commit it names does not hold this text.
    client = FakeClient(FakePrompt("Regel eins, in Langfuse verbessert."))

    assert _run(monkeypatch, client, "--label", "production", "--apply") == push.EXIT_REFUSED
    assert client.created == []


def test_apply_needs_the_label_named(monkeypatch, committed, capsys):
    client = FakeClient(FakePrompt("Regel eins."))

    assert _run(monkeypatch, client, "--apply") == push.EXIT_REFUSED
    assert client.created == []
    assert "--label" in capsys.readouterr().err


def test_a_label_with_no_version_yet_is_created(monkeypatch, committed):
    client = FakeClient(None)

    assert _run(monkeypatch, client) == push.EXIT_WOULD_CHANGE
    assert _run(monkeypatch, client, "--label", "production", "--apply") == push.EXIT_OK
    assert len(client.created) == 1


def test_an_uncommitted_file_is_not_published(monkeypatch, committed):
    monkeypatch.setattr(push, "git_origin", lambda: ("a" * 40, True))
    client = FakeClient(FakePrompt("Regel eins."))

    assert _run(monkeypatch, client, "--label", "production", "--apply") == push.EXIT_REFUSED
    assert client.created == []


def test_without_credentials_nothing_is_checked(monkeypatch, committed):
    assert _run(monkeypatch, None) == push.EXIT_UNCONFIGURED
