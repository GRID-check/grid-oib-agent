"""Tests for the ris_search and ris_fetch_document NAT tools."""

from unittest.mock import MagicMock

import pytest
from ris_adapter.client import RisDocument
from ris_adapter.client import RisError
from ris_adapter.client import RisHit
from ris_adapter.client import RisSearchResult
from ris_adapter.register import RisFetchDocumentToolConfig
from ris_adapter.register import RisSearchToolConfig
from ris_adapter.register import _build_search_params
from ris_adapter.register import _format_hit
from ris_adapter.register import _safe_document_name
from ris_adapter.register import ris_fetch_document
from ris_adapter.register import ris_search

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


async def _call(info, **kwargs):
    """Invoke a registered NAT tool: multi-arg tools take one input_schema instance."""
    return await info.single_fn(info.input_schema(**kwargs))


@pytest.fixture
def fake_client(monkeypatch):
    _FakeClient.search_result = RisSearchResult()
    _FakeClient.fetch_result = RisDocument(url="", title="", text="")
    _FakeClient.search_calls = []
    _FakeClient.fetch_calls = []
    monkeypatch.setattr("ris_adapter.register.RisClient", _FakeClient)
    return _FakeClient


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
    def test_prefers_title(self):
        assert _safe_document_name("NOR1", "Bauordnung für Wien §5") == "RIS_Bauordnung_für_Wien__5.txt"

    def test_falls_back_to_reference(self):
        assert _safe_document_name("NOR40217157", "") == "RIS_NOR40217157.txt"

    def test_truncates_long_titles(self):
        name = _safe_document_name("NOR1", "x" * 300)

        assert len(name) <= len("RIS_.txt") + 80


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

        assert 'added to the knowledge base as "RIS_Gesetz.txt"' in output
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
