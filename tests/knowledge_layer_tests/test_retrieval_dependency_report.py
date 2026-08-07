"""The LlamaIndex dependency diagnostic must describe the real environment.

Issues #330 and #331 were reported as "LlamaIndex dependencies not installed",
which was simply false: the packages were installed and one was broken —
``llama-index-core`` missing under an otherwise-populated ``llama_index``
namespace package. Every ``ImportError`` was mapped to the same "not installed"
string, so the advice (reinstall these three packages) was wrong and the real
cause, carried in the chained exception all along, went unread.

A diagnostic that misdescribes the fault is worse than none, so these tests pin
the distinction the report exists to draw.
"""

from __future__ import annotations

import builtins

import pytest
from knowledge_layer.llamaindex.adapter import _retrieval_dependency_error
from knowledge_layer.llamaindex.adapter import ensure_retrieval_dependencies
from knowledge_layer.llamaindex.adapter import retrieval_dependency_report

#: The exact failure production hit: the namespace package resolves, the piece
#: we need does not, and the error is an ImportError rather than a
#: ModuleNotFoundError.
_BROKEN_CORE = ImportError("cannot import name 'core' from 'llama_index' (unknown location)")


@pytest.fixture
def break_import(monkeypatch):
    """Make one module name fail on import with a given exception."""

    def _apply(target: str, error: BaseException):
        real = builtins.__import__

        def fake(name, *args, **kwargs):
            if name == target:
                raise error
            return real(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", fake)

    return _apply


def test_healthy_environment_reports_nothing() -> None:
    assert retrieval_dependency_report() == []


def test_a_broken_install_is_not_reported_as_missing(break_import) -> None:
    """The regression: this is the environment that produced #330/#331."""
    break_import("llama_index.core", _BROKEN_CORE)

    findings = retrieval_dependency_report()

    assert findings, "a broken llama-index-core produced no finding"
    assert "llama-index-core: installed but broken" in findings[0]
    assert "cannot import name 'core'" in findings[0]
    assert "not installed" not in findings[0]


def test_a_genuinely_absent_module_is_reported_as_missing(break_import) -> None:
    break_import("chromadb", ModuleNotFoundError("No module named 'chromadb'", name="chromadb"))

    findings = retrieval_dependency_report()

    assert any(f.startswith("chromadb: not installed") for f in findings), findings


def test_a_missing_transitive_dependency_is_not_reported_as_missing(break_import) -> None:
    """The module is there; something it imports is not.

    ``ModuleNotFoundError`` alone cannot be read as "this distribution is
    absent" -- it fires just as readily when the package imports fine and one of
    its own dependencies does not. Collapsing the two would put us back to
    telling people to install a package that is already installed.
    """
    break_import(
        "llama_index.core",
        ModuleNotFoundError("No module named 'tenacity'", name="tenacity"),
    )

    findings = retrieval_dependency_report()

    assert findings
    assert "llama-index-core: installed but broken" in findings[0]
    assert "tenacity" in findings[0]
    assert "not installed" not in findings[0]


def test_the_preflight_raises_when_any_module_is_unusable(break_import) -> None:
    """`ensure_retrieval_dependencies` is what makes "initialized" mean usable."""
    break_import("llama_index.vector_stores.chroma", _BROKEN_CORE)

    with pytest.raises(RuntimeError, match="llama-index-vector-stores-chroma: installed but broken"):
        ensure_retrieval_dependencies()


def test_the_preflight_is_silent_in_a_healthy_environment() -> None:
    ensure_retrieval_dependencies()


def test_the_error_carries_the_triggering_cause_and_the_module_status(break_import) -> None:
    """The message a developer actually reads when retrieval fails."""
    break_import("llama_index.core", _BROKEN_CORE)

    message = str(_retrieval_dependency_error(_BROKEN_CORE))

    # The cause that was previously discarded, and the per-module truth.
    assert "cannot import name 'core'" in message
    assert "llama-index-core: installed but broken" in message
    # And a remediation that matches the actual fault: reinstall the extra
    # rather than add a package that is already there.
    assert "uv sync --extra llamaindex" in message


def test_the_error_is_still_useful_when_no_module_faults(break_import) -> None:
    """A healthy probe must not produce an empty, contentless error."""
    message = str(_retrieval_dependency_error(ImportError("something else entirely")))

    assert "no per-module fault found" in message
    assert "something else entirely" in message
