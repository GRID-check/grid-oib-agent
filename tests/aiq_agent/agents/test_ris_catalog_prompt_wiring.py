"""Prompt wiring: the norm registry block reaches the researcher prompts."""

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
SHALLOW_TEMPLATE = REPO_ROOT / "src" / "aiq_agent" / "agents" / "shallow_researcher" / "prompts" / "researcher.j2"
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
        current_datetime="2026-07-16",
        user_info=None,
        tools=[],
        available_documents=[],
        project_context=None,
        execution_enabled=False,
        ris_catalog=ris_catalog,
    )


@pytest.mark.parametrize("template_path", [SHALLOW_TEMPLATE, DEEP_TEMPLATE])
def test_templates_render_registry_block_when_present(template_path):
    rendered = _render_template(template_path, "- BO Wien — Bauordnung für Wien [LrKons/NOR12345678]")

    assert _HEADING in rendered
    assert "BO Wien" in rendered


@pytest.mark.parametrize("template_path", [SHALLOW_TEMPLATE, DEEP_TEMPLATE])
def test_templates_omit_registry_block_when_absent(template_path):
    rendered = _render_template(template_path, None)

    assert _HEADING not in rendered


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
