"""Every registered tool says how it keeps a restricted folder's content from the model unadmitted (ADR-0081).

The admission (``restricted_use.admit_tool_results``) works on what a tool call
REPORTS it read (``note_collections_read``) and, as a backstop, on restricted
collection names in the result's text. A new tool that returns a restricted
folder's content without reporting it, and without naming the collection,
would pass both. So every NAT function this deployment registers is classified
here, and the classification names the test that pins it: a new tool fails
this file until somebody decides which kind it is and points at the proof.

The kinds:

- ``reports``: returns content of the collections it reads and reports each
  one, directly or through ``render_grounding_block``;
- ``lists_nothing_restricted``: names files, never one of a restricted folder
  (listing is not use);
- ``no_collection_content``: returns nothing read from a collection;
- ``external``: returns content from outside the corpus (law, the web);
- ``agent``: an agent or workflow; its tools are classified one by one.
"""

from __future__ import annotations

import importlib.metadata
from pathlib import Path

import pytest

from nat.cli.type_registry import GlobalTypeRegistry

_ROOT = Path(__file__).resolve().parents[3]

#: tool type -> (kind, the test that pins it, or why nothing needs to)
TOOLS: dict[str, tuple[str, str]] = {
    # Evidence and reading tools: what they return is reported.
    "knowledge_retrieval": (
        "reports",
        "tests/knowledge_layer_tests/test_restricted_reads.py::test_exact_search_reports_every_collection_its_match_table_names",
    ),
    "read_passage": (
        "reports",
        "tests/knowledge_layer_tests/test_restricted_reads.py::test_read_passage_reports_a_restricted_passage_and_it_is_admitted",
    ),
    "view_knowledge_image": (
        "reports",
        "tests/knowledge_layer_tests/test_restricted_reads.py::test_view_image_of_a_drawable_restricted_folder_is_reported_and_admitted",
    ),
    # Listings: never a restricted folder's file.
    "list_files": (
        "lists_nothing_restricted",
        "tests/knowledge_layer_tests/test_restricted_reads.py::test_list_files_never_lists_a_restricted_file_when_the_inventory_failed",
    ),
    "surface_documents": (
        "lists_nothing_restricted",
        "tests/aiq_agent/cards/test_surface_documents.py::test_a_restricted_folders_collection_is_never_listed",
    ),
    "propose_file_change": (
        "lists_nothing_restricted",
        "resolves names only against the turn's inventory rows, which conversation_register loads "
        "from without_restricted(scope)",
    ),
    # Nothing read from a collection reaches the result.
    "ask_user": ("no_collection_content", "asks the reader; returns the reader's answer"),
    "emit_card": ("no_collection_content", "pushes a card the model composed from what it already read"),
    "describe_card": ("no_collection_content", "returns a card type's schema"),
    "file_draft": ("no_collection_content", "files the conversation's own draft; returns the filing outcome"),
    "create_task": ("no_collection_content", "queues work; returns the task it created"),
    "project_memory_remember": (
        "no_collection_content",
        "writes a note; restricted memory is served into a prompt only after the BFF admits its folders",
    ),
    "ifc_query": (
        "no_collection_content",
        "BIM data is keyed by project, and IFC models are refused in "
        "restricted folders (lib/projects/ifc-folder-guard.ts, ADR-0080)",
    ),
    "ifc_measure": ("no_collection_content", "same model data as ifc_query"),
    "data_source_registry": ("no_collection_content", "configuration only"),
    "deep_research_skills": ("no_collection_content", "configuration only"),
    "deep_research_sandbox": ("no_collection_content", "configuration only"),
    # Outside the corpus.
    "ris_search": ("external", "the Austrian legal information system"),
    "ris_catalog_lookup": ("external", "the RIS catalog"),
    "ris_fetch_document": ("external", "the Austrian legal information system"),
    "ris_lookup": ("external", "the Austrian legal information system"),
    "tavily_web_search": ("external", "the web"),
    # Agents and workflows: their tools are the rows above.
    "research_agent": ("agent", "Piloti; admits every tool round in its tools node"),
    "research_workflow": ("agent", "wraps research_agent"),
    "chat_deepresearcher_agent": ("agent", "the chat workflow around Piloti"),
    "deep_research_agent": ("agent", "a restricted collection is never signed into a run's scope (ADR-0080)"),
    "deep_research_workflow": ("agent", "wraps deep_research_agent"),
}

_KINDS = {"reports", "lists_nothing_restricted", "no_collection_content", "external", "agent"}


def _registered_tool_types() -> set[str]:
    for entry_point in importlib.metadata.entry_points(group="nat.plugins"):
        entry_point.load()
    return {
        info.config_type.static_type()
        for info in GlobalTypeRegistry.get().get_registered_functions()
        if not info.config_type.static_type().startswith("grid_test_")
    }


def test_every_registered_tool_is_classified():
    registered = _registered_tool_types()

    unclassified = sorted(registered - TOOLS.keys())
    assert not unclassified, (
        f"{unclassified}: say how each keeps a restricted folder's content from the model unadmitted "
        "(see this module's docstring), and name the test that pins it"
    )
    assert not sorted(TOOLS.keys() - registered), "a classified tool is no longer registered: drop its row"


@pytest.mark.parametrize("tool", sorted(TOOLS))
def test_every_classification_names_a_kind_and_its_proof(tool):
    kind, proof = TOOLS[tool]
    assert kind in _KINDS
    if kind not in ("reports", "lists_nothing_restricted") or "::" not in proof:
        assert proof.strip(), "say why nothing needs to be pinned"
        return
    path, test_name = proof.split("::")
    source = (_ROOT / path).read_text(encoding="utf-8")
    assert f"def {test_name}(" in source, f"{proof} does not exist"


def test_a_tool_that_reports_is_pinned_by_a_test_not_by_a_sentence():
    for tool, (kind, proof) in TOOLS.items():
        if kind == "reports":
            assert "::" in proof, f"{tool} reports what it read: name the test that proves it"
