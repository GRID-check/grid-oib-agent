"""Tests for the ris_search and ris_fetch_document NAT tools."""

from unittest.mock import MagicMock

import pytest
from ris_adapter.client import RisDocument
from ris_adapter.client import RisError
from ris_adapter.client import RisHit
from ris_adapter.client import RisSearchResult
from ris_adapter.register import RisCatalogLookupToolConfig
from ris_adapter.register import RisFetchDocumentToolConfig
from ris_adapter.register import RisSearchToolConfig
from ris_adapter.register import _build_search_params
from ris_adapter.register import _format_catalog_entry
from ris_adapter.register import _format_hit
from ris_adapter.register import _safe_document_name
from ris_adapter.register import ris_catalog_lookup
from ris_adapter.register import ris_fetch_document
from ris_adapter.register import ris_search

from aiq_agent.common.norm_registry import NormEntry
from aiq_agent.common.norm_registry import NormRegistry
from nat.builder.function import LambdaFunction
from nat.data_models.function import FunctionBaseConfig


def _sample_hit() -> RisHit:
    return RisHit(
        application="BrKons",
        document_number="NOR40217157",
        title="Garagengesetz",
        citation_url="https://www.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40217157/NOR40217157.html",
        content_urls={"Html": "https://www.ris.bka.gv.at/x/NOR40217157.html"},
        full_law_url="https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=20000123",
        metadata={"Paragraph/Artikel": "§ 5", "In Kraft seit": "2020-01-01"},
    )


class TestConfigs:
    def test_search_defaults(self):
        config = RisSearchToolConfig()

        assert config.base_url == "https://data.bka.gv.at/ris/api/v2.6"
        assert config.timeout == 30.0
        assert config.page_size == 20
        assert config.max_results == 10
        assert config.catalog_shortcut is True
        assert config.catalog_path == ""

    def test_fetch_defaults(self):
        config = RisFetchDocumentToolConfig()

        assert config.max_chars == 40_000
        assert config.ingest_into_knowledge is True
        assert config.timeout == 60.0

    def test_inherit_from_function_base_config(self):
        assert issubclass(RisSearchToolConfig, FunctionBaseConfig)
        assert issubclass(RisFetchDocumentToolConfig, FunctionBaseConfig)


class TestBuildSearchParams:
    def test_query_and_title(self):
        params = _build_search_params("BrKons", "Garage", "Garagengesetz", "", "", "")

        assert params == {"Suchworte": "Garage", "Titel": "Garagengesetz"}

    def test_bundesland_filter_for_landesrecht(self):
        params = _build_search_params("LrKons", "Bauordnung", "", "Wien", "", "")

        assert params["Bundesland.SucheInWien"] == "true"

    def test_bundesland_umlauts_normalized(self):
        params = _build_search_params("LrKons", "Bauordnung", "", "Kärnten", "", "")

        assert params["Bundesland.SucheInKaernten"] == "true"

    def test_bundesland_ignored_for_bundesrecht(self):
        params = _build_search_params("BrKons", "Bauordnung", "", "Wien", "", "")

        assert not any(key.startswith("Bundesland") for key in params)

    def test_judikatur_date_range(self):
        params = _build_search_params("Vwgh", "Stellplatz", "", "", "2020-01-01", "2021-12-31")

        assert params["EntscheidungsdatumVon"] == "2020-01-01"
        assert params["EntscheidungsdatumBis"] == "2021-12-31"

    def test_brkons_fassung_vom(self):
        params = _build_search_params("BrKons", "Garage", "", "", "2023-06-01", "")

        assert params["Fassung.FassungVom"] == "2023-06-01"

    def test_bgbl_auth_kundmachung_range(self):
        params = _build_search_params("BgblAuth", "Novelle", "", "", "2024-01-01", "2024-12-31")

        assert params["Kundmachung.Von"] == "2024-01-01"
        assert params["Kundmachung.Bis"] == "2024-12-31"

    def test_invalid_date_raises(self):
        with pytest.raises(RisError, match="YYYY-MM-DD"):
            _build_search_params("Vwgh", "x", "", "", "01.01.2020", "")


class TestFormatHit:
    def test_contains_citation_and_fetch_hint(self):
        output = _format_hit(1, _sample_hit())

        assert "--- Result 1 ---" in output
        assert "Title: Garagengesetz" in output
        assert "Document number: NOR40217157" in output
        assert "Source: https://www.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40217157/NOR40217157.html" in output
        assert "ris_fetch_document with 'NOR40217157'" in output
        assert "Entire consolidated law" in output
        assert "§ 5" in output


class _FakeClient:
    """Stands in for RisClient inside the registered tools."""

    search_result: RisSearchResult | Exception = RisSearchResult()
    fetch_result: RisDocument | Exception = RisDocument(url="", title="", text="")
    search_calls: list[dict] = []
    fetch_calls: list[str] = []

    def __init__(self, *args, **kwargs):
        pass

    async def search(self, application, params=None, page=1, page_size=20):
        _FakeClient.search_calls.append(
            {"application": application, "params": params, "page": page, "page_size": page_size}
        )
        if isinstance(_FakeClient.search_result, Exception):
            raise _FakeClient.search_result
        return _FakeClient.search_result

    async def fetch_document_text(self, url):
        _FakeClient.fetch_calls.append(url)
        if isinstance(_FakeClient.fetch_result, Exception):
            raise _FakeClient.fetch_result
        return _FakeClient.fetch_result

    async def aclose(self):
        pass


class _CallProbeToolConfig(FunctionBaseConfig, name="test_register_call_probe"):
    """Dummy config so _call can wrap a FunctionInfo in the real runtime Function."""


async def _call(info, **kwargs):
    """Invoke a registered NAT tool through the real runtime path.

    LambdaFunction.ainvoke converts the kwargs into the tool's input schema and
    unpacks it per the function's arity — calling info.single_fn(...) directly
    would hand SINGLE-argument tools (ris_catalog_lookup) the whole schema
    object instead of the value, which production never does.
    """
    fn = LambdaFunction.from_info(config=_CallProbeToolConfig(), info=info)
    return await fn.ainvoke(kwargs, to_type=str)


@pytest.fixture
def fake_client(monkeypatch):
    _FakeClient.search_result = RisSearchResult()
    _FakeClient.fetch_result = RisDocument(url="", title="", text="")
    _FakeClient.search_calls = []
    _FakeClient.fetch_calls = []
    monkeypatch.setattr("ris_adapter.register.RisClient", _FakeClient)
    # Keep every live-search test on the live path even when a shipped catalog exists.
    monkeypatch.setattr("ris_adapter.register.load_registry", lambda path=None: None)
    return _FakeClient


def _catalog_entry(**overrides) -> NormEntry:
    data = {
        "id": "bo-wien",
        "title": "Bauordnung für Wien",
        "short": "BO Wien",
        "application": "LrKons",
        "document_number": "NOR12345678",
        "citation_url": "https://www.ris.bka.gv.at/eli/lgbl/WI/1930/11",
        "full_law_url": "https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=LrW&Gesetzesnummer=20000123",
        "bundesland": "Wien",
        "topics": ["bauordnung", "bauantrag"],
        "relevance": "State building code for Vienna",
        "verified_at": "2026-07-16",
    }
    data.update(overrides)
    return NormEntry(**data)


@pytest.fixture
def fake_catalog(monkeypatch):
    catalog = NormRegistry(entries=[_catalog_entry()])
    monkeypatch.setattr("ris_adapter.register.load_registry", lambda path=None: catalog)
    return catalog


class TestRisSearchTool:
    async def test_formats_results(self, fake_client):
        fake_client.search_result = RisSearchResult(hits=[_sample_hit()], total=42, page=1, page_size=20)

        async with ris_search(RisSearchToolConfig(), MagicMock()) as info:
            output = await _call(info, query="Garage Stellplatz")

        assert "Found 42 RIS document(s)" in output
        assert "Garagengesetz" in output
        assert "ris_fetch_document" in output
        assert fake_client.search_calls[0]["application"] == "BrKons"
        assert fake_client.search_calls[0]["params"] == {"Suchworte": "Garage Stellplatz"}

    async def test_repeat_search_is_served_from_cache(self, fake_client):
        fake_client.search_result = RisSearchResult(hits=[_sample_hit()], total=1, page=1, page_size=20)

        async with ris_search(RisSearchToolConfig(), MagicMock()) as info:
            first = await _call(info, query="Garage Stellplatz")
            second = await _call(info, query="Garage Stellplatz")

        assert "Garagengesetz" in first and first == second
        # The second identical search hit the shared cache — no second API call
        # (and, when a planner is configured, no second planner-LLM call either).
        assert len(fake_client.search_calls) == 1

    async def test_no_results_message(self, fake_client):
        fake_client.search_result = RisSearchResult(hits=[], total=0)

        async with ris_search(RisSearchToolConfig(), MagicMock()) as info:
            output = await _call(info, query="xyzzy", application="LrKons")

        assert "No RIS documents found" in output
        assert "LrKons" in output

    async def test_api_error_returned_as_string(self, fake_client):
        fake_client.search_result = RisError("OGD-RIS API error (Landesnormen): Seitennummer zu hoch")

        async with ris_search(RisSearchToolConfig(), MagicMock()) as info:
            output = await _call(info, query="Bauordnung")

        assert output.startswith("Error: RIS search failed")
        assert "Seitennummer" in output

    async def test_invalid_date_becomes_error_string(self, fake_client):
        async with ris_search(RisSearchToolConfig(), MagicMock()) as info:
            output = await _call(info, query="Garage", application="Vwgh", date_from="bogus")

        assert output.startswith("Error: RIS search failed")
        assert fake_client.search_calls == []

    async def test_max_results_limits_output(self, fake_client):
        hits = [
            RisHit(document_number=f"NOR{i}", title=f"Hit {i}", citation_url=f"https://www.ris.bka.gv.at/{i}")
            for i in range(5)
        ]
        fake_client.search_result = RisSearchResult(hits=hits, total=5, page=1, page_size=20)

        async with ris_search(RisSearchToolConfig(max_results=2), MagicMock()) as info:
            output = await _call(info, query="Garage")

        assert "Hit 0" in output
        assert "Hit 1" in output
        assert "Hit 4" not in output
        assert "showing 2" in output


class _FakeStructuredLLM:
    """Mimics a LangChain chat model with .with_structured_output(...).ainvoke(...)."""

    def __init__(self, plan):
        self.plan = plan
        self.structured_kwargs = None
        self.invocations = []

    def with_structured_output(self, schema, **kwargs):
        self.structured_kwargs = {"schema": schema, **kwargs}
        outer = self

        class _Structured:
            async def ainvoke(self, messages):
                outer.invocations.append(messages)
                if isinstance(outer.plan, Exception):
                    raise outer.plan
                return outer.plan

        return _Structured()


class _SequenceStructuredLLM:
    """Structured LLM whose successive ainvoke calls return/raise a scripted sequence."""

    def __init__(self, sequence):
        self.sequence = list(sequence)
        self.structured_kwargs = None
        self.invocations = []

    def with_structured_output(self, schema, **kwargs):
        self.structured_kwargs = {"schema": schema, **kwargs}
        outer = self

        class _Structured:
            async def ainvoke(self, messages):
                outer.invocations.append(messages)
                item = outer.sequence.pop(0)
                if isinstance(item, Exception):
                    raise item
                return item

        return _Structured()


def _builder_with_planner(llm):
    from unittest.mock import AsyncMock

    builder = MagicMock()
    builder.get_llm = AsyncMock(return_value=llm)
    return builder


class TestRisSearchPlanner:
    async def test_planner_output_drives_the_search(self, fake_client):
        from ris_adapter.register import RisSearchPlan

        fake_client.search_result = RisSearchResult(hits=[_sample_hit()], total=1, page=1, page_size=20)
        plan = RisSearchPlan(
            application="LrKons",
            suchworte="Stellplatzverpflichtung",
            bundesland="Wien",
            reasoning="Bauordnung questions are state law",
        )
        llm = _FakeStructuredLLM(plan)

        config = RisSearchToolConfig(planner_llm="ris_planner_llm")
        async with ris_search(config, _builder_with_planner(llm)) as info:
            output = await _call(info, query="Wie viele Stellplätze brauche ich in Wien?")

        # Strict structured outputs (OpenRouter response_format json_schema) requested.
        assert llm.structured_kwargs["method"] == "json_schema"
        assert llm.structured_kwargs["strict"] is True
        # The plan, not the raw caller args, reached the API.
        call = fake_client.search_calls[0]
        assert call["application"] == "LrKons"
        assert call["params"]["Suchworte"] == "Stellplatzverpflichtung"
        assert call["params"]["Bundesland.SucheInWien"] == "true"
        assert "Found 1 RIS document(s)" in output

    async def test_planner_failure_falls_back_to_caller_args(self, fake_client):
        fake_client.search_result = RisSearchResult(hits=[_sample_hit()], total=1, page=1, page_size=20)
        llm = _FakeStructuredLLM(RuntimeError("provider down"))

        config = RisSearchToolConfig(planner_llm="ris_planner_llm")
        async with ris_search(config, _builder_with_planner(llm)) as info:
            output = await _call(info, query="Garagengesetz", application="BrKons")

        call = fake_client.search_calls[0]
        assert call["application"] == "BrKons"
        assert call["params"] == {"Suchworte": "Garagengesetz"}
        assert "Found 1 RIS document(s)" in output

    async def test_empty_plan_falls_back_to_caller_args(self, fake_client):
        from ris_adapter.register import RisSearchPlan

        fake_client.search_result = RisSearchResult(hits=[_sample_hit()], total=1, page=1, page_size=20)
        llm = _FakeStructuredLLM(RisSearchPlan(application="BrKons", suchworte="   "))

        config = RisSearchToolConfig(planner_llm="ris_planner_llm")
        async with ris_search(config, _builder_with_planner(llm)) as info:
            await _call(info, query="Garagengesetz", bundesland="Tirol", application="LrKons")

        call = fake_client.search_calls[0]
        assert call["application"] == "LrKons"
        assert call["params"]["Suchworte"] == "Garagengesetz"

    async def test_planner_retries_once_on_validation_error_then_succeeds(self, fake_client):
        from pydantic import ValidationError
        from ris_adapter.register import RisSearchPlan

        fake_client.search_result = RisSearchResult(hits=[_sample_hit()], total=1, page=1, page_size=20)
        try:
            RisSearchPlan.model_validate({})  # missing required fields
        except ValidationError as exc:
            validation_error = exc
        good_plan = RisSearchPlan(
            application="LrKons",
            suchworte="Stellplatzverpflichtung",
            bundesland="Wien",
        )
        llm = _SequenceStructuredLLM([validation_error, good_plan])

        config = RisSearchToolConfig(planner_llm="ris_planner_llm")
        async with ris_search(config, _builder_with_planner(llm)) as info:
            output = await _call(info, query="Wie viele Stellplätze brauche ich in Wien?", application="BrKons")

        # Retried exactly once, and the corrective instruction was appended.
        assert len(llm.invocations) == 2
        corrective_texts = [m["content"] for m in llm.invocations[1] if m["role"] == "user"]
        assert any("invalid JSON" in text for text in corrective_texts)
        # The successful second-attempt plan drove the search, not the caller args.
        call = fake_client.search_calls[0]
        assert call["application"] == "LrKons"
        assert call["params"]["Suchworte"] == "Stellplatzverpflichtung"
        assert "Found 1 RIS document(s)" in output

    async def test_planner_double_validation_error_falls_back_to_caller_args(self, fake_client):
        from pydantic import ValidationError
        from ris_adapter.register import RisSearchPlan

        fake_client.search_result = RisSearchResult(hits=[_sample_hit()], total=1, page=1, page_size=20)
        try:
            RisSearchPlan.model_validate({})
        except ValidationError as exc:
            validation_error = exc
        llm = _SequenceStructuredLLM([validation_error, validation_error])

        config = RisSearchToolConfig(planner_llm="ris_planner_llm")
        async with ris_search(config, _builder_with_planner(llm)) as info:
            output = await _call(info, query="Garagengesetz", application="BrKons")

        # Retried once (two invocations), both failed -> outer fail-open uses caller args.
        assert len(llm.invocations) == 2
        call = fake_client.search_calls[0]
        assert call["application"] == "BrKons"
        assert call["params"] == {"Suchworte": "Garagengesetz"}
        assert "Found 1 RIS document(s)" in output

    async def test_unresolvable_planner_llm_disables_planner(self, fake_client):
        from unittest.mock import AsyncMock

        fake_client.search_result = RisSearchResult(hits=[_sample_hit()], total=1, page=1, page_size=20)
        builder = MagicMock()
        builder.get_llm = AsyncMock(side_effect=RuntimeError("no such llm"))

        config = RisSearchToolConfig(planner_llm="missing_llm")
        async with ris_search(config, builder) as info:
            output = await _call(info, query="Garagengesetz")

        assert "Found 1 RIS document(s)" in output
        assert fake_client.search_calls[0]["params"] == {"Suchworte": "Garagengesetz"}


class TestSafeDocumentName:
    """The name becomes a CITATION KEY the reader sees, so it must be legible AND stable."""

    def test_prefers_title_and_anchors_it_with_the_document_number(self):
        assert _safe_document_name("NOR1", "Bauordnung für Wien §5") == "RIS_Bauordnung_für_Wien__5_NOR1.txt"

    def test_falls_back_to_reference(self):
        assert _safe_document_name("NOR40217157", "") == "RIS_NOR40217157.txt"

    def test_truncates_long_titles(self):
        name = _safe_document_name("NOR1", "x" * 300)

        assert len(name) <= len("RIS_.txt") + 80

    def test_the_ris_title_prefix_is_not_doubled(self):
        """RIS titles start with "RIS - "; prefixing our own gave "RIS_RIS_-_…"."""
        name = _safe_document_name("LWI40010002", "RIS - Wiener Garagengesetz 2008")

        assert name.startswith("RIS_Wiener_Garagengesetz")
        assert "RIS_RIS" not in name

    def test_the_same_law_keeps_ONE_name_across_days(self):
        """A RIS title carries "Fassung vom <retrieval date>".

        Leaving it in meant the same law ingested as a NEW document every day:
        a session accumulated near-duplicate snapshots and a citation pointed at
        whichever day's copy happened to be retrieved.
        """
        title = "RIS - Wiener Garagengesetz 2008 - Landesrecht konsolidiert Wien, Fassung vom {date}"
        monday = _safe_document_name("LWI40010002", title.format(date="28.07.2026"))
        tuesday = _safe_document_name("LWI40010002", title.format(date="29.07.2026"))

        assert monday == tuesday
        assert "Fassung" not in monday
        assert "2026" not in monday

    def test_truncation_never_leaves_a_dot_against_the_extension(self):
        """Cutting mid-token used to produce "…vom_28..txt"."""
        name = _safe_document_name("NOR1", "Ein sehr langer Titel " * 10 + "28.07.2026")

        assert ".." not in name
        assert name.endswith(".txt")

    def test_a_url_and_its_document_number_name_ONE_document(self):
        """`ris_fetch_document` takes either form for the same document.

        Sanitizing the whole URL made the two forms two documents. The ingest
        marker is keyed on the fetched URL, so the second form skipped ingestion
        and told the agent about a filename that was never stored.
        """
        by_number = _safe_document_name("NOR40217157", "RIS - Garagengesetz")
        by_url = _safe_document_name(
            "https://www.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40217157/NOR40217157.html",
            "RIS - Garagengesetz",
        )

        assert by_number == by_url
        assert "NOR40217157" in by_number

    def test_a_consolidated_law_url_is_anchored_by_its_Gesetzesnummer(self):
        name = _safe_document_name(
            "https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10008935",
            "RIS - Garagengesetz",
        )

        assert name == "RIS_Garagengesetz_10008935.txt"

    def test_a_url_urlparse_refuses_still_yields_a_name(self):
        """Naming the document must not fail a fetch that already succeeded."""
        assert _safe_document_name("http://[", "RIS - Garagengesetz") == "RIS_Garagengesetz.txt"

    def test_an_unreadable_url_contributes_no_anchor(self):
        """The title alone is stable; a sanitized URL is neither stable nor legible."""
        name = _safe_document_name("https://www.ris.bka.gv.at/Suche?query=garagen", "RIS - Garagengesetz")

        assert name == "RIS_Garagengesetz.txt"

    def test_two_different_laws_never_collide(self):
        assert _safe_document_name("LWI40010002", "RIS - Garagengesetz") != _safe_document_name(
            "LWI40000225", "RIS - Garagengesetz"
        )


class TestRisFetchDocumentTool:
    async def test_fetches_by_url(self, fake_client):
        fake_client.fetch_result = RisDocument(
            url="https://www.ris.bka.gv.at/Dokumente/Bundesnormen/NOR1/NOR1.html",
            title="Garagengesetz",
            text="§ 1 Text des Gesetzes",
        )

        config = RisFetchDocumentToolConfig(ingest_into_knowledge=False)
        async with ris_fetch_document(config, MagicMock()) as info:
            output = await _call(info, reference="https://www.ris.bka.gv.at/Dokumente/Bundesnormen/NOR1/NOR1.html")

        assert output.startswith("Source: https://www.ris.bka.gv.at/Dokumente/Bundesnormen/NOR1/NOR1.html")
        assert "Title: Garagengesetz" in output
        assert "§ 1 Text des Gesetzes" in output

    async def test_fetches_by_document_number(self, fake_client):
        fake_client.fetch_result = RisDocument(url="https://x", title="", text="text")

        config = RisFetchDocumentToolConfig(ingest_into_knowledge=False)
        async with ris_fetch_document(config, MagicMock()) as info:
            await _call(info, reference="NOR40217157")

        assert fake_client.fetch_calls == [
            "https://www.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40217157/NOR40217157.html"
        ]

    async def test_repeat_fetch_is_served_from_cache(self, fake_client):
        fake_client.fetch_result = RisDocument(url="https://www.ris.bka.gv.at/d", title="G", text="Volltext")

        config = RisFetchDocumentToolConfig(ingest_into_knowledge=False)
        async with ris_fetch_document(config, MagicMock()) as info:
            first = await _call(info, reference="https://www.ris.bka.gv.at/d")
            second = await _call(info, reference="https://www.ris.bka.gv.at/d")

        assert "Volltext" in first and first == second
        # The second identical fetch hit the shared cache — only ONE network call.
        assert fake_client.fetch_calls == ["https://www.ris.bka.gv.at/d"]

    async def test_unresolvable_reference_returns_error(self, fake_client):
        config = RisFetchDocumentToolConfig(ingest_into_knowledge=False)
        async with ris_fetch_document(config, MagicMock()) as info:
            output = await _call(info, reference="XYZ123")

        assert output.startswith("Error: RIS document fetch failed")
        assert "application" in output
        assert fake_client.fetch_calls == []

    async def test_empty_reference_returns_error(self, fake_client):
        config = RisFetchDocumentToolConfig(ingest_into_knowledge=False)
        async with ris_fetch_document(config, MagicMock()) as info:
            output = await _call(info, reference="   ")

        assert output.startswith("Error: RIS document fetch failed")

    async def test_truncates_long_documents(self, fake_client):
        fake_client.fetch_result = RisDocument(url="https://www.ris.bka.gv.at/d", title="Lang", text="x" * 5000)

        config = RisFetchDocumentToolConfig(ingest_into_knowledge=False, max_chars=1000)
        async with ris_fetch_document(config, MagicMock()) as info:
            output = await _call(info, reference="NOR1")

        assert "Document truncated: showing 1,000 of 5,000 characters" in output

    async def test_fetch_error_returned_as_string(self, fake_client):
        fake_client.fetch_result = RisError("Fetching RIS document failed with HTTP 404")

        config = RisFetchDocumentToolConfig(ingest_into_knowledge=False)
        async with ris_fetch_document(config, MagicMock()) as info:
            output = await _call(info, reference="NOR1")

        assert output.startswith("Error: RIS document fetch failed")
        assert "404" in output

    async def test_ingestion_success_is_reported(self, fake_client, monkeypatch):
        fake_client.fetch_result = RisDocument(url="https://www.ris.bka.gv.at/d", title="Gesetz", text="Volltext")

        def _fake_ingest(text, file_name, source_url):
            assert text == "Volltext"
            assert source_url == "https://www.ris.bka.gv.at/d"
            return file_name

        monkeypatch.setattr("ris_adapter.register._ingest_document_sync", _fake_ingest)

        config = RisFetchDocumentToolConfig(ingest_into_knowledge=True)
        async with ris_fetch_document(config, MagicMock()) as info:
            output = await _call(info, reference="NOR1")

        assert 'added to the knowledge base as "RIS_Gesetz_NOR1.txt"' in output
        assert "knowledge_search" in output

    async def test_ingestion_failure_is_non_fatal(self, fake_client, monkeypatch):
        fake_client.fetch_result = RisDocument(url="https://www.ris.bka.gv.at/d", title="Gesetz", text="Volltext")

        def _boom(text, file_name, source_url):
            raise RuntimeError("no ingestor")

        monkeypatch.setattr("ris_adapter.register._ingest_document_sync", _boom)

        config = RisFetchDocumentToolConfig(ingest_into_knowledge=True)
        async with ris_fetch_document(config, MagicMock()) as info:
            output = await _call(info, reference="NOR1")

        assert "Volltext" in output
        assert "added to the knowledge base" not in output
        assert not output.startswith("Error")


class TestFormatCatalogEntry:
    def test_contains_pointer_lines(self):
        output = _format_catalog_entry(1, _catalog_entry())

        assert "--- Catalog match 1 ---" in output
        assert "Title: Bauordnung für Wien" in output
        assert "Bundesland: Wien" in output
        assert "Application: LrKons" in output
        assert "Document number: NOR12345678" in output
        assert "Source: https://www.ris.bka.gv.at/eli/lgbl/WI/1930/11" in output
        assert "Entire consolidated law (all paragraphs):" in output
        assert "Relevance: State building code for Vienna" in output

    def test_skips_empty_optional_fields(self):
        output = _format_catalog_entry(1, _catalog_entry(bundesland="", citation_url="", full_law_url="", relevance=""))

        assert "Bundesland:" not in output
        assert "Source:" not in output
        assert "Entire consolidated law" not in output
        assert "Relevance:" not in output


class TestRisCatalogLookupTool:
    def test_config_defaults(self):
        config = RisCatalogLookupToolConfig()

        assert config.catalog_path == ""
        assert config.max_matches == 5

    def test_inherits_from_function_base_config(self):
        assert issubclass(RisCatalogLookupToolConfig, FunctionBaseConfig)

    async def test_returns_verified_pointers(self, fake_catalog):
        async with ris_catalog_lookup(RisCatalogLookupToolConfig(), MagicMock()) as info:
            output = await _call(info, topic="bauordnung wien")

        assert "1 verified match(es)" in output
        assert "NOR12345678" in output
        assert "Entire consolidated law" in output
        assert "ris_fetch_document" in output
        assert "No ris_search needed" in output

    async def test_no_match_guides_to_ris_search(self, fake_catalog):
        async with ris_catalog_lookup(RisCatalogLookupToolConfig(), MagicMock()) as info:
            output = await _call(info, topic="mietzins")

        assert "No curated RIS catalog entry matches 'mietzins'" in output
        assert "ris_search" in output

    async def test_max_matches_respected(self, monkeypatch):
        catalog = NormRegistry(
            entries=[
                _catalog_entry(),
                _catalog_entry(
                    id="bo-noe", short="BO NÖ", bundesland="Niederösterreich", document_number="NOR87654321"
                ),
            ]
        )
        monkeypatch.setattr("ris_adapter.register.load_registry", lambda path=None: catalog)

        async with ris_catalog_lookup(RisCatalogLookupToolConfig(max_matches=1), MagicMock()) as info:
            output = await _call(info, topic="bauordnung")

        assert "1 verified match(es)" in output
        assert "NOR12345678" in output
        assert "NOR87654321" not in output

    async def test_state_specific_topic_returns_that_state_not_the_catalog_head(self, monkeypatch):
        # All nine state building codes share the generic "bauordnung" topic. A
        # state-specific lookup must return THAT state (plus federal law) — not
        # the first max_matches entries in catalog order, which would crowd the
        # right state out entirely.
        catalog = NormRegistry(
            entries=[
                _catalog_entry(),  # Wien, catalog head
                _catalog_entry(
                    id="bo-noe", short="NÖ BO", bundesland="Niederösterreich", document_number="NOR00000002"
                ),
                _catalog_entry(
                    id="bo-ooe", short="Oö. BauO", bundesland="Oberösterreich", document_number="NOR00000003"
                ),
                _catalog_entry(
                    id="bo-stmk", short="Stmk. BauG", bundesland="Steiermark", document_number="NOR00000004"
                ),
                _catalog_entry(id="bo-ktn", short="Ktn. BO", bundesland="Kärnten", document_number="NOR00000005"),
                _catalog_entry(id="bo-tirol", short="Tiroler BO", bundesland="Tirol", document_number="NOR00000006"),
                _catalog_entry(
                    id="aschg", short="ASchG", application="BrKons", bundesland="", document_number="NOR00000007"
                ),
            ]
        )
        monkeypatch.setattr("ris_adapter.register.load_registry", lambda path=None: catalog)

        async with ris_catalog_lookup(RisCatalogLookupToolConfig(max_matches=5), MagicMock()) as info:
            output = await _call(info, topic="Bauordnung Tirol")

        assert "NOR00000006" in output  # Tirol — was truncated out before the fix
        assert "NOR00000007" in output  # federal law is never dropped
        assert "NOR12345678" not in output  # Wien
        assert "NOR00000002" not in output  # NÖ
        # The named state sorts before federal law.
        assert output.index("NOR00000006") < output.index("NOR00000007")

    async def test_catalog_unavailable(self, monkeypatch):
        monkeypatch.setattr("ris_adapter.register.load_registry", lambda path=None: None)

        async with ris_catalog_lookup(RisCatalogLookupToolConfig(), MagicMock()) as info:
            output = await _call(info, topic="bauordnung")

        assert "RIS catalog unavailable" in output
        assert "ris_search" in output

    async def test_module_unavailable(self, monkeypatch):
        monkeypatch.setattr("ris_adapter.register._CATALOG_AVAILABLE", False)

        async with ris_catalog_lookup(RisCatalogLookupToolConfig(), MagicMock()) as info:
            output = await _call(info, topic="bauordnung")

        assert "catalog module not importable" in output
        assert "ris_search" in output


class TestRisSearchCatalogShortcut:
    async def test_match_returns_pointers_without_live_search(self, fake_client, fake_catalog):
        async with ris_search(RisSearchToolConfig(), MagicMock()) as info:
            output = await _call(info, query="bauordnung wien")

        assert "Curated RIS catalog match(es)" in output
        assert "no live search performed" in output
        assert "NOR12345678" in output
        assert "ris_fetch_document" in output
        assert fake_client.search_calls == []

    async def test_match_with_matching_explicit_application_shortcuts(self, fake_client, fake_catalog):
        async with ris_search(RisSearchToolConfig(), MagicMock()) as info:
            output = await _call(info, query="bauordnung", application="LrKons")

        assert "Curated RIS catalog match(es)" in output
        assert fake_client.search_calls == []

    async def test_bundesland_argument_selects_that_states_law(self, fake_client, monkeypatch):
        catalog = NormRegistry(
            entries=[
                _catalog_entry(),  # Wien
                _catalog_entry(id="bo-tirol", short="Tiroler BO", bundesland="Tirol", document_number="NOR00000006"),
            ]
        )
        monkeypatch.setattr("ris_adapter.register.load_registry", lambda path=None: catalog)

        async with ris_search(RisSearchToolConfig(), MagicMock()) as info:
            output = await _call(info, query="bauordnung", bundesland="Tirol")

        assert fake_client.search_calls == []
        assert "NOR00000006" in output
        # The explicitly requested state wins: no Viennese pointers for Tirol.
        assert "NOR12345678" not in output

    async def test_explicit_application_filters_pointers(self, fake_client, monkeypatch):
        catalog = NormRegistry(
            entries=[
                _catalog_entry(),  # LrKons Wien
                _catalog_entry(
                    id="aschg", short="ASchG", application="BrKons", bundesland="", document_number="NOR00000007"
                ),
            ]
        )
        monkeypatch.setattr("ris_adapter.register.load_registry", lambda path=None: catalog)

        async with ris_search(RisSearchToolConfig(), MagicMock()) as info:
            output = await _call(info, query="bauordnung wien", application="LrKons")

        assert fake_client.search_calls == []
        assert "NOR12345678" in output
        # Explicit LrKons request -> federal pointers are not mixed in.
        assert "NOR00000007" not in output

    async def test_no_match_falls_through_to_live_search(self, fake_client, fake_catalog):
        async with ris_search(RisSearchToolConfig(), MagicMock()) as info:
            await _call(info, query="garagengesetz")

        assert len(fake_client.search_calls) == 1

    async def test_case_law_signal_forces_live_search(self, fake_client, fake_catalog):
        async with ris_search(RisSearchToolConfig(), MagicMock()) as info:
            await _call(info, query="VwGH Erkenntnis Bauordnung")

        assert len(fake_client.search_calls) == 1

    async def test_mismatched_application_forces_live_search(self, fake_client, fake_catalog):
        async with ris_search(RisSearchToolConfig(), MagicMock()) as info:
            await _call(info, query="bauordnung", application="Vwgh")

        assert len(fake_client.search_calls) == 1

    async def test_date_argument_forces_live_search(self, fake_client, fake_catalog):
        async with ris_search(RisSearchToolConfig(), MagicMock()) as info:
            await _call(info, query="bauordnung", date_from="2020-01-01")

        assert len(fake_client.search_calls) == 1

    async def test_title_argument_forces_live_search(self, fake_client, fake_catalog):
        async with ris_search(RisSearchToolConfig(), MagicMock()) as info:
            await _call(info, query="bauordnung", title="Bauordnung für Wien")

        assert len(fake_client.search_calls) == 1

    async def test_shortcut_disabled_via_config(self, fake_client, fake_catalog):
        async with ris_search(RisSearchToolConfig(catalog_shortcut=False), MagicMock()) as info:
            await _call(info, query="bauordnung wien")

        assert len(fake_client.search_calls) == 1

    async def test_catalog_unavailable_falls_through(self, fake_client, monkeypatch):
        monkeypatch.setattr("ris_adapter.register.load_registry", lambda path=None: None)

        async with ris_search(RisSearchToolConfig(), MagicMock()) as info:
            await _call(info, query="bauordnung wien")

        assert len(fake_client.search_calls) == 1


def _override_setting(monkeypatch, values):
    """Patch the platform retrieval-settings resolver: only the listed keys are
    overridden, every other key falls through to its config fallback — exactly
    what the real resolver does for unpinned keys."""
    import aiq_agent.common.retrieval_settings as retrieval_settings

    def fake_get(key, fallback):
        return values.get(key, fallback)

    monkeypatch.setattr(retrieval_settings, "get_retrieval_setting", fake_get)


class TestPlatformRetrievalSettings:
    """The ris_search / ris_catalog_lookup counts come from Platform → Retrieval
    when pinned there, and fall back to the YAML config values otherwise."""

    async def test_platform_max_results_overrides_config(self, fake_client, monkeypatch):
        fake_client.search_result = RisSearchResult(
            hits=[_sample_hit() for _ in range(5)], total=5, page=1, page_size=20
        )
        _override_setting(monkeypatch, {"ris.max_results": 3})

        async with ris_search(RisSearchToolConfig(), MagicMock()) as info:
            output = await _call(info, query="Garage Stellplatz")

        assert output.count("--- Result") == 3

    async def test_platform_page_size_reaches_the_client(self, fake_client, monkeypatch):
        fake_client.search_result = RisSearchResult(hits=[_sample_hit()], total=1, page=1, page_size=50)
        _override_setting(monkeypatch, {"ris.page_size": 50})

        async with ris_search(RisSearchToolConfig(), MagicMock()) as info:
            await _call(info, query="Garage Stellplatz")

        assert fake_client.search_calls[0]["page_size"] == 50

    async def test_resolver_failure_falls_back_to_config(self, fake_client, monkeypatch):
        fake_client.search_result = RisSearchResult(hits=[_sample_hit()], total=1, page=1, page_size=20)
        import aiq_agent.common.retrieval_settings as retrieval_settings

        def boom(key, fallback):
            raise RuntimeError("BFF unreachable")

        monkeypatch.setattr(retrieval_settings, "get_retrieval_setting", boom)

        async with ris_search(RisSearchToolConfig(), MagicMock()) as info:
            output = await _call(info, query="Garage Stellplatz")

        assert "Garagengesetz" in output
        assert fake_client.search_calls[0]["page_size"] == 20

    async def test_catalog_shortcut_respects_platform_max_results(self, fake_client, monkeypatch):
        catalog = NormRegistry(
            entries=[
                _catalog_entry(),
                _catalog_entry(
                    id="bo-noe", short="BO NÖ", bundesland="Niederösterreich", document_number="NOR87654321"
                ),
            ]
        )
        monkeypatch.setattr("ris_adapter.register.load_registry", lambda path=None: catalog)
        _override_setting(monkeypatch, {"ris.max_results": 1})

        async with ris_search(RisSearchToolConfig(), MagicMock()) as info:
            output = await _call(info, query="bauordnung")

        assert "NOR12345678" in output
        assert "NOR87654321" not in output
        assert fake_client.search_calls == []

    async def test_catalog_lookup_respects_platform_max_matches(self, fake_catalog, monkeypatch):
        fake_catalog.entries.append(
            _catalog_entry(id="bo-noe", short="BO NÖ", bundesland="Niederösterreich", document_number="NOR87654321")
        )
        _override_setting(monkeypatch, {"ris_catalog.max_matches": 1})

        async with ris_catalog_lookup(RisCatalogLookupToolConfig(), MagicMock()) as info:
            output = await _call(info, topic="bauordnung")

        assert "1 verified match(es)" in output
        assert "NOR12345678" in output
        assert "NOR87654321" not in output
