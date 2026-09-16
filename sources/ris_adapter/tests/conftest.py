"""Shared fixtures for the RIS adapter tests."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from ris_adapter.client import RisDocument
from ris_adapter.client import RisSearchResult

from nat.builder.function import LambdaFunction
from nat.data_models.function import FunctionBaseConfig


@pytest.fixture(autouse=True)
def _isolate_shared_cache():
    """Reset the shared cache around every test.

    ``ris_search`` / ``ris_fetch_document`` now read/write the fail-open shared
    cache (``aiq_agent.common.cache``, ADR-0020). Its in-process fallback store
    is a module global, so without this a document/search cached in one test
    would be served in the next. No-op when the agent package is absent (the
    adapter used standalone), where the cache is a safe no-op anyway.
    """
    try:
        from aiq_agent.common.cache import reset_local_store
    except Exception:
        yield
        return
    reset_local_store()
    yield
    reset_local_store()


# ---------------------------------------------------------------------------
# ris_lookup: one fake client, one fake catalog, one consolidated law
#
# Everything here is reached through FIXTURES rather than imported: these test
# modules live in a package called ``tests``, and so does the repo root's, so a
# ``from .conftest import …`` resolves to whichever one sys.path found first.
# ---------------------------------------------------------------------------

#: A consolidated law in the shape RIS's HTML actually converts to: one line
#: per §, the Absätze run into the section head or starting their own line, and
#: the Überschrift on the line above. Every extraction test cuts out of THIS,
#: so a change in the grammar fails the tests rather than the reader.
_BO_WIEN_TEXT = """Bauordnung für Wien

Bauansuchen
§ 63. (1) Dem Ansuchen um Baubewilligung sind anzuschließen:
a) der Nachweis des Eigentums,
b) die Baupläne in dreifacher Ausfertigung.
(2) Die Baupläne müssen von einem hierzu Befugten verfasst sein.
(3) Die Behörde kann weitere Unterlagen verlangen.

Bauverhandlung
§ 64. (1) Über das Bauansuchen ist eine Bauverhandlung anzuberaumen.
(2) Die Nachbarn sind zu laden.

Gebäudehöhe
§ 75. (1) Die Gebäudehöhe ergibt sich aus der Bauklasse.
(2) In der Bauklasse I darf die Gebäudehöhe 9 m nicht überschreiten.
"""

_BO_TIROL_TEXT = """Tiroler Bauordnung 2022

Stellplätze
§ 60. (1) Bei Neubauten sind Stellplätze für Kraftfahrzeuge herzustellen.
(2) Die Zahl der Stellplätze richtet sich nach der Widmung.
"""


class FakeLookupClient:
    """Stands in for ``RisClient`` inside ``ris_lookup``.

    Class-level state, like ``test_register._FakeClient``: the tool constructs
    its own client, so a test cannot hold the instance.
    """

    search_result: RisSearchResult | Exception = RisSearchResult()
    documents: dict[str, RisDocument] = {}
    search_calls: list[dict] = []
    fetch_calls: list[str] = []

    def __init__(self, *args, **kwargs):
        pass

    async def search(self, application, params=None, page=1, page_size=20):
        FakeLookupClient.search_calls.append(
            {"application": application, "params": params, "page": page, "page_size": page_size}
        )
        if isinstance(FakeLookupClient.search_result, Exception):
            raise FakeLookupClient.search_result
        return FakeLookupClient.search_result

    async def fetch_document_text(self, url):
        FakeLookupClient.fetch_calls.append(url)
        document = FakeLookupClient.documents.get(url)
        if document is None:
            raise AssertionError(f"ris_lookup fetched an unexpected URL: {url}")
        return document

    async def aclose(self):
        pass


class _LookupProbeConfig(FunctionBaseConfig, name="test_lookup_call_probe"):
    """Dummy config so a registered tool can be invoked through the real runtime."""


class LookupHarness:
    """One place to run ``ris_lookup`` and see what it did."""

    WIEN_URL = "https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=LrW&Gesetzesnummer=20000006"
    TIROL_URL = "https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=LrT&Gesetzesnummer=20000112"

    def __init__(self, client: type[FakeLookupClient]):
        self.client = client

    async def run(self, config=None, **kwargs) -> str:
        """Invoke the tool through the real NAT runtime path (see test_register._call)."""
        from ris_adapter.lookup import RisLookupToolConfig
        from ris_adapter.lookup import ris_lookup

        async with ris_lookup(config or RisLookupToolConfig(), MagicMock()) as info:
            fn = LambdaFunction.from_info(config=_LookupProbeConfig(), info=info)
            return await fn.ainvoke(kwargs, to_type=str)

    def with_llms(self, monkeypatch, planner=None, picker=None) -> None:
        """Run the next lookup with these two internal LLMs (either may be None).

        Patching the resolver rather than the model: what a test needs to say is
        "the picker was never called", and going through `get_langchain_llm` to
        say it would test NAT's builder instead of this tool's two paths.
        """

        async def _resolve(tool_config, builder):
            return planner, picker

        monkeypatch.setattr("ris_adapter.lookup.tool._resolve_llms", _resolve)

    def set_text(self, url: str, text: str) -> None:
        self.client.documents[url].text = text

    @staticmethod
    def body_of(output: str, index: int = 1) -> str:
        """The passage body of one ``--- Result N ---`` block, as the parser sees it."""
        from aiq_agent.common.citation_verification import _extract_kl_chunk_bodies

        return _extract_kl_chunk_bodies(output)[index - 1]


@pytest.fixture
def lookup(monkeypatch):
    """``ris_lookup`` wired to a fake RIS: two consolidated laws, no catalog."""
    FakeLookupClient.search_result = RisSearchResult()
    FakeLookupClient.search_calls = []
    FakeLookupClient.fetch_calls = []
    FakeLookupClient.documents = {
        LookupHarness.WIEN_URL: RisDocument(
            url=LookupHarness.WIEN_URL, title="Bauordnung für Wien", text=_BO_WIEN_TEXT
        ),
        LookupHarness.TIROL_URL: RisDocument(
            url=LookupHarness.TIROL_URL, title="Tiroler Bauordnung 2022", text=_BO_TIROL_TEXT
        ),
    }
    monkeypatch.setattr("ris_adapter.lookup.tool.RisClient", FakeLookupClient)
    # Every test names its own catalog; the shipped registry must not decide.
    monkeypatch.setattr("ris_adapter.lookup.candidates.load_registry", lambda path=None: None)
    return LookupHarness(FakeLookupClient)


def norm_entry(**overrides):
    """One curated catalog entry, defaulted to the Wiener Bauordnung."""
    from aiq_agent.common.norm_registry import NormEntry

    data = {
        "id": "bo-wien",
        "title": "Bauordnung für Wien",
        "short": "BO Wien",
        "application": "LrKons",
        "document_number": "NOR40200001",
        "citation_url": "https://www.ris.bka.gv.at/eli/lgbl/WI/1930/11",
        "full_law_url": LookupHarness.WIEN_URL,
        "bundesland": "Wien",
        "topics": ["bauordnung", "bauansuchen", "einreichung"],
        "relevance": "State building code for Vienna",
        "verified_at": "2026-07-16",
    }
    data.update(overrides)
    return NormEntry(**data)


@pytest.fixture
def catalog(monkeypatch):
    """Install a norm registry for ``ris_lookup``; returns a setter for its entries."""
    from aiq_agent.common.norm_registry import NormRegistry

    state: dict[str, NormRegistry] = {"registry": NormRegistry(entries=[norm_entry()])}
    monkeypatch.setattr("ris_adapter.lookup.candidates.load_registry", lambda path=None: state["registry"])

    def use(*entries):
        state["registry"] = NormRegistry(entries=list(entries))
        return state["registry"]

    return use


class FakePicker:
    """The § picker, scripted. Records every call so a test can assert none."""

    def __init__(self, *sections: str):
        self.sections = list(sections)
        self.calls: list[tuple[str, str]] = []

    async def __call__(self, question: str, index: str):
        from ris_adapter.lookup.picker import RisPassagePick
        from ris_adapter.lookup.picker import RisPassagePlan

        self.calls.append((question, index))
        return RisPassagePlan(picks=[RisPassagePick(section=section) for section in self.sections])


class FakePlanner:
    """The search planner, scripted, with the same signature ris_search uses."""

    def __init__(self, application="LrKons", suchworte="Bauordnung", titel="", bundesland=""):
        from ris_adapter.register import RisSearchPlan

        self.plan = RisSearchPlan(application=application, suchworte=suchworte, titel=titel, bundesland=bundesland)
        self.calls: list[tuple] = []

    async def __call__(self, query, application, title, bundesland, date_from, date_to):
        self.calls.append((query, application, title, bundesland, date_from, date_to))
        return self.plan
