"""Prompt wiring: the norm registry block reaches the deep-research prompt.

Piloti no longer renders the catalog. Its entries are RIS addresses, and
``ris_lookup`` resolves one out of the question itself (ADR-0060 (d)), so a
per-turn copy of the list below the KV-cache boundary bought the turn nothing
and cost it ~1,500 tokens. Deep research, whose researcher orchestrates RIS by
hand, still gets it — which is why the wiring is still pinned here.
"""

from pathlib import Path
from unittest.mock import MagicMock

import pytest
import yaml

from aiq_agent.agents.deep_researcher.factory import DeepResearchGraphContext
from aiq_agent.agents.deep_researcher.models import DeepResearchAgentState
from aiq_agent.common.norm_registry import ENV_NORMS_DIR
from aiq_agent.common.norm_registry import reset_registry_cache
from aiq_agent.common.prompt_utils import render_prompt_template

REPO_ROOT = Path(__file__).resolve().parents[3]
PILOTI_TEMPLATE = REPO_ROOT / "src" / "aiq_agent" / "agents" / "piloti" / "prompts" / "piloti.j2"
DEEP_TEMPLATE = REPO_ROOT / "src" / "aiq_agent" / "agents" / "deep_researcher" / "prompts" / "researcher.j2"

_HEADING = "## Normenregister (verifizierte Normen, Rang und Rolle annotiert)"

_REGISTRY = {
    "version": 1,
    "entries": [
        {
            "id": "bo-wien",
            "title": "Bauordnung für Wien",
            "short": "BO Wien",
            "rank": "landesgesetz",
            "bundesland": "Wien",
            "topics": ["bauordnung", "bauantrag"],
            "relevance": "State building code for Vienna",
            "application": "LrKons",
            "document_number": "NOR12345678",
            "citation_url": "https://www.ris.bka.gv.at/eli/lgbl/WI/1930/11",
            "full_law_url": "https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=LrW&Gesetzesnummer=1",
            "verified_at": "2026-07-16",
        }
    ],
}


@pytest.fixture(autouse=True)
def _registry_env(tmp_path, monkeypatch):
    norms_dir = tmp_path / "norms"
    country_dir = norms_dir / "at"
    country_dir.mkdir(parents=True)
    (country_dir / "registry.yml").write_text(yaml.safe_dump(_REGISTRY, allow_unicode=True), encoding="utf-8")
    monkeypatch.setenv(ENV_NORMS_DIR, str(norms_dir))
    reset_registry_cache()
    yield norms_dir
    reset_registry_cache()


def _render_template(template_path: Path, ris_catalog) -> str:
    return render_prompt_template(
        template_path.read_text(encoding="utf-8"),
        static_block="",
        current_datetime="2026-07-16",
        user_info=None,
        tools=[],
        available_documents=[],
        project_context=None,
        execution_enabled=False,
        ris_catalog=ris_catalog,
    )


def test_the_deep_template_renders_the_registry_block_when_present():
    rendered = _render_template(DEEP_TEMPLATE, "- BO Wien — Bauordnung für Wien [LrKons/NOR12345678]")

    assert _HEADING in rendered
    assert "BO Wien" in rendered


def test_the_deep_template_omits_the_registry_block_when_absent():
    rendered = _render_template(DEEP_TEMPLATE, None)

    assert _HEADING not in rendered


def test_piloti_carries_no_catalog_variable_at_all():
    """Not "renders empty": the variable is gone from the template, so a
    caller cannot reintroduce 1,500 tokens by passing one."""
    source = PILOTI_TEMPLATE.read_text(encoding="utf-8")

    assert "ris_catalog" not in source
    assert _HEADING not in source


def _graph_context(prompts: dict[str, str], project_context: str | None = None) -> DeepResearchGraphContext:
    return DeepResearchGraphContext(
        llm_provider=MagicMock(),
        state=DeepResearchAgentState(messages=[], project_context=project_context),
        prompts=prompts,
        tools=[],
        runtime=MagicMock(),
        tool_set=MagicMock(),
        middleware_set=MagicMock(),
        domain_catalog_path=None,
        current_datetime="2026-07-16",
        max_research_concurrency=1,
        enable_source_router=False,
        backend=MagicMock(),
        visibility_middleware=[],
    )


def test_deep_render_prompt_passes_registry_block():
    context = _graph_context({"researcher": "{% if ris_catalog %}RIS-BLOCK\n{{ ris_catalog }}{% endif %}"})

    rendered = context.render_prompt("researcher")

    assert "RIS-BLOCK" in rendered
    assert "BO Wien" in rendered
    assert "NOR12345678" in rendered


def test_deep_render_prompt_registry_block_empty_when_registry_missing(monkeypatch, tmp_path):
    monkeypatch.setenv(ENV_NORMS_DIR, str(tmp_path / "empty-norms"))
    reset_registry_cache()
    context = _graph_context({"researcher": "{% if ris_catalog %}RIS-BLOCK{% else %}no-catalog{% endif %}"})

    rendered = context.render_prompt("researcher")

    assert rendered == "no-catalog"
