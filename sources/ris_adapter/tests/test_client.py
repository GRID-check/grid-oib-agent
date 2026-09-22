"""Tests for the OGD-RIS client: response parsing, document fetching, URL building."""

import json

import httpx
import pytest
from ris_adapter.client import RisClient
from ris_adapter.client import RisError
from ris_adapter.client import build_document_url
from ris_adapter.client import html_to_text
from ris_adapter.client import parse_search_response

BR_KONS_RESPONSE = {
    "OgdSearchResult": {
        "OgdDocumentResults": {
            "Hits": {"@pageNumber": "1", "@pageSize": "20", "#text": "42"},
            "OgdDocumentReference": [
                {
                    "Data": {
                        "Metadaten": {
                            "Technisch": {"ID": "NOR40217157", "Applikation": "BrKons"},
                            "Allgemein": {
                                "DokumentUrl": (
                                    "https://www.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40217157/NOR40217157.html"
                                )
                            },
                            "Bundesrecht": {
                                "Kurztitel": "Garagengesetz",
                                "Titel": "Bundesgesetz über Garagen",
                                "BrKons": {
                                    "GesamteRechtsvorschriftUrl": (
                                        "https://www.ris.bka.gv.at/GeltendeFassung.wxe"
                                        "?Abfrage=Bundesnormen&Gesetzesnummer=20000123"
                                    ),
                                    "ArtikelParagraphAnlage": "§ 5",
                                    "Inkrafttretensdatum": "2020-01-01",
                                    "Gesetzesnummer": {"item": "20000123"},
                                },
                            },
                        },
                        "Dokumentliste": {
                            "ContentReference": {
                                "ContentType": "MainDocument",
                                "Name": "Hauptdokument",
                                "Urls": {
                                    "ContentUrl": [
                                        {"DataType": "Xml", "Url": "https://www.ris.bka.gv.at/x/NOR40217157.xml"},
                                        {"DataType": "Html", "Url": "https://www.ris.bka.gv.at/x/NOR40217157.html"},
                                    ]
                                },
                            }
                        },
                    }
                },
                {
                    # Single-child variant: ContentUrl is a dict, not a list.
                    "Data": {
                        "Metadaten": {
                            "Technisch": {"ID": "JWT_2020130074", "Applikation": "Vwgh"},
                            "Judikatur": {
                                "Geschaeftszahl": {"item": ["Ra 2019/05/0068"]},
                                "Entscheidungsdatum": "2021-04-15",
                            },
                        },
                        "Dokumentliste": {
                            "ContentReference": {
                                "Urls": {
                                    "ContentUrl": {
                                        "DataType": "Html",
                                        "Url": "https://www.ris.bka.gv.at/x/JWT_2020130074.html",
                                    }
                                }
                            }
                        },
                    }
                },
            ],
        }
    }
}

ERROR_RESPONSE = {
    "OgdSearchResult": {
        "Error": {
            "Applikation": "Landesnormen",
            "Message": "soap:Client Die Seitennummer ist höher als die Anzahl der verfügbaren Seiten",
        }
    }
}


class TestParseSearchResponse:
    def test_parses_hits_and_paging(self):
        result = parse_search_response(BR_KONS_RESPONSE)

        assert result.total == 42
        assert result.page == 1
        assert result.page_size == 20
        assert len(result.hits) == 2

    def test_normalizes_bundesrecht_hit(self):
        hit = parse_search_response(BR_KONS_RESPONSE).hits[0]

        assert hit.document_number == "NOR40217157"
        assert hit.application == "BrKons"
        assert hit.title == "Garagengesetz"
        assert hit.citation_url.endswith("NOR40217157.html")
        assert hit.full_law_url.startswith("https://www.ris.bka.gv.at/GeltendeFassung.wxe")
        assert hit.content_urls == {
            "Xml": "https://www.ris.bka.gv.at/x/NOR40217157.xml",
            "Html": "https://www.ris.bka.gv.at/x/NOR40217157.html",
        }
        assert hit.metadata["Paragraph/Artikel"] == "§ 5"
        assert hit.metadata["In Kraft seit"] == "2020-01-01"
        assert hit.metadata["Gesetzesnummer"] == "20000123"
        assert hit.fetch_url == "https://www.ris.bka.gv.at/x/NOR40217157.html"

    def test_normalizes_judikatur_hit_with_dict_content_url(self):
        hit = parse_search_response(BR_KONS_RESPONSE).hits[1]

        assert hit.document_number == "JWT_2020130074"
        assert hit.application == "Vwgh"
        # No Kurztitel/Titel — falls back to the Geschaeftszahl.
        assert hit.title == "Ra 2019/05/0068"
        assert hit.metadata["Entscheidungsdatum"] == "2021-04-15"
        assert hit.content_urls == {"Html": "https://www.ris.bka.gv.at/x/JWT_2020130074.html"}

    def test_single_document_reference_as_dict(self):
        payload = {
            "OgdSearchResult": {
                "OgdDocumentResults": {
                    "Hits": {"#text": "1"},
                    "OgdDocumentReference": BR_KONS_RESPONSE["OgdSearchResult"]["OgdDocumentResults"][
                        "OgdDocumentReference"
                    ][0],
                }
            }
        }

        result = parse_search_response(payload)

        assert result.total == 1
        assert len(result.hits) == 1
        assert result.hits[0].document_number == "NOR40217157"

    def test_error_response_raises_ris_error_with_message(self):
        with pytest.raises(RisError, match="Seitennummer ist höher"):
            parse_search_response(ERROR_RESPONSE)

    def test_missing_ogd_search_result_raises(self):
        with pytest.raises(RisError, match="missing OgdSearchResult"):
            parse_search_response({"unexpected": True})

    def test_empty_results(self):
        result = parse_search_response({"OgdSearchResult": {"OgdDocumentResults": {"Hits": {"#text": "0"}}}})

        assert result.total == 0
        assert result.hits == []


class TestHtmlToText:
    def test_strips_markup_and_extracts_title(self):
        html = (
            "<html><head><title> Garagengesetz  §5 </title><style>p{color:red}</style></head>"
            "<body><script>alert(1)</script><h1>§ 5</h1>\n\n\n<p>Stellplätze   sind&nbsp;vorzusehen.</p>"
            "</body></html>"
        )

        title, text = html_to_text(html)

        assert title == "Garagengesetz §5"
        assert "alert(1)" not in text
        assert "color:red" not in text
        assert "§ 5" in text
        assert "Stellplätze sind vorzusehen." in text
        assert "\n\n\n" not in text

    def test_drops_the_ris_page_furniture_when_the_document_container_is_present(self):
        # The shape of a real ``GeltendeFassung.wxe`` page: an accesskey menu and
        # a navigation bar BEFORE ``#content``. Measured against the Bauordnung
        # für Wien (2026-09-04) the furniture is only ~672 characters against
        # 759,015 of law — and all of it sits at the FRONT, which is where it does
        # the damage: it is what the in-app reader opens on, what the agent reads
        # first inside its ``max_chars`` window, and what gets ingested into the
        # session collection as retrievable text that is not law.
        html = (
            "<html><head><title>Bauordnung für Wien</title></head><body>"
            "<div id='skiplinks'>Seitenbereiche: Zum Inhalt (Accesskey 0)</div>"
            "<ul id='nav'><li>Startseite</li><li>Bund</li><li>Länder</li></ul>"
            "<div id='content'><h1>§ 108</h1><p>Lagerung gefährlicher Stoffe</p></div>"
            "<div id='footer'>Impressum</div>"
            "</body></html>"
        )

        _, text = html_to_text(html)

        assert "Lagerung gefährlicher Stoffe" in text
        assert "Accesskey" not in text
        assert "Startseite" not in text
        assert "Impressum" not in text

    def test_keeps_the_whole_document_when_there_is_no_container(self):
        # A ``/Dokumente/…`` page, an XML payload, or a future RIS template may
        # carry no ``#content``. Absence is not an error — the whole document is
        # then the answer, exactly as it was before.
        html = "<html><body><h1>§ 5</h1><p>Stellplätze sind vorzusehen.</p></body></html>"

        _, text = html_to_text(html)

        assert "Stellplätze sind vorzusehen." in text
        assert "§ 5" in text


class TestBuildDocumentUrl:
    def test_infers_segment_from_prefix(self):
        url = build_document_url("NOR40217157")

        assert url == "https://www.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40217157/NOR40217157.html"

    def test_explicit_application_wins(self):
        url = build_document_url("LKT40001234", application="LrKons")

        assert url == "https://www.ris.bka.gv.at/Dokumente/Landesnormen/LKT40001234/LKT40001234.html"

    def test_vwgh_prefix(self):
        url = build_document_url("JWT_2020130074_20210415J00")

        assert "/Dokumente/Vwgh/" in url

    def test_rejects_garbage_reference(self):
        with pytest.raises(RisError, match="neither a RIS URL nor a document number"):
            build_document_url("not a doc number!")

    def test_unknown_prefix_without_application_raises(self):
        with pytest.raises(RisError, match="Cannot determine the RIS application"):
            build_document_url("XYZ123")


def _transport(handler):
    return httpx.MockTransport(handler)


class TestRisClientSearch:
    async def test_search_builds_request_and_parses(self):
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            return httpx.Response(200, json=BR_KONS_RESPONSE)

        client = RisClient(transport=_transport(handler))
        result = await client.search("BrKons", params={"Suchworte": "Garage"}, page=2, page_size=50)

        assert result.total == 42
        assert "data.bka.gv.at/ris/api/v2.6/Bundesrecht" in seen["url"]
        assert "Applikation=BrKons" in seen["url"]
        assert "Suchworte=Garage" in seen["url"]
        assert "DokumenteProSeite=Fifty" in seen["url"]
        assert "Seitennummer=2" in seen["url"]

    async def test_unknown_application_raises(self):
        client = RisClient(transport=_transport(lambda request: httpx.Response(200, json={})))

        with pytest.raises(RisError, match="Unknown RIS application 'Bogus'"):
            await client.search("Bogus")

    async def test_http_500_with_error_payload_surfaces_message(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, json=ERROR_RESPONSE)

        client = RisClient(transport=_transport(handler))

        with pytest.raises(RisError, match="Seitennummer ist höher"):
            await client.search("LrKons")

    async def test_http_error_without_payload(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(503, text="unavailable")

        client = RisClient(transport=_transport(handler), max_retries=1)

        with pytest.raises(RisError, match="HTTP 503"):
            await client.search("BrKons")

    async def test_transient_5xx_is_retried(self):
        calls = {"count": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["count"] += 1
            if calls["count"] == 1:
                return httpx.Response(502, text="bad gateway")
            return httpx.Response(200, json=BR_KONS_RESPONSE)

        client = RisClient(transport=_transport(handler))
        result = await client.search("BrKons")

        assert calls["count"] == 2
        assert result.total == 42

    async def test_structured_500_error_is_not_retried(self):
        calls = {"count": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["count"] += 1
            return httpx.Response(500, json=ERROR_RESPONSE)

        client = RisClient(transport=_transport(handler))

        with pytest.raises(RisError, match="Seitennummer"):
            await client.search("LrKons")
        assert calls["count"] == 1

    async def test_non_json_response_raises(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="<html>not json</html>")

        client = RisClient(transport=_transport(handler))

        with pytest.raises(RisError, match="non-JSON"):
            await client.search("BrKons")


class TestRisClientFetch:
    async def test_fetches_and_converts_html(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                headers={"content-type": "text/html; charset=utf-8"},
                text="<html><head><title>Bauordnung</title></head><body><p>§ 1 Geltungsbereich</p></body></html>",
            )

        client = RisClient(transport=_transport(handler))
        document = await client.fetch_document_text("https://www.ris.bka.gv.at/Dokumente/x/y.html")

        assert document.title == "Bauordnung"
        assert "§ 1 Geltungsbereich" in document.text

    async def test_caches_fetched_documents(self):
        calls = {"count": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["count"] += 1
            return httpx.Response(200, headers={"content-type": "text/html"}, text="<p>content</p>")

        client = RisClient(transport=_transport(handler))
        url = "https://www.ris.bka.gv.at/Dokumente/x/y.html"
        await client.fetch_document_text(url)
        await client.fetch_document_text(url)

        assert calls["count"] == 1

    async def test_cache_max_entries_zero_disables_the_in_process_cache(self):
        """Turning the cache off must not crash, and must actually turn it off.

        ``GET /v1/ris/document`` reads through the SHARED cache, so its
        process-global client asks for no second copy — up to 64 documents of
        up to two million characters each, resident per worker, for bytes
        Dragonfly already holds. The eviction branch ran unguarded on
        ``len({}) >= 0`` and ``min`` over an empty dict raises, so the only way
        to ask for that failed on the first fetch.
        """
        calls = {"count": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["count"] += 1
            return httpx.Response(200, headers={"content-type": "text/html"}, text="<p>content</p>")

        client = RisClient(transport=_transport(handler), cache_max_entries=0)
        url = "https://www.ris.bka.gv.at/Dokumente/x/y.html"
        await client.fetch_document_text(url)
        await client.fetch_document_text(url)

        assert calls["count"] == 2
        assert client._doc_cache == {}

    async def test_rejects_non_ris_host(self):
        client = RisClient(transport=_transport(lambda request: httpx.Response(200)))

        with pytest.raises(RisError, match="Refusing to fetch non-RIS URL"):
            await client.fetch_document_text("https://evil.example.com/doc.html")

    async def test_rejects_http_scheme(self):
        client = RisClient(transport=_transport(lambda request: httpx.Response(200)))

        with pytest.raises(RisError, match="Only https"):
            await client.fetch_document_text("http://www.ris.bka.gv.at/doc.html")

    async def test_a_redirect_off_ris_is_refused_before_it_is_followed(self):
        """The allow-list bounds the FETCH, not just the request.

        The client follows redirects, and the URL check used to run once, on the
        caller's string. So a RIS endpoint that reflects a query parameter into
        ``Location`` — and the citizen application is query-driven WebForms
        throughout — reduced the allow-list to a formality: the second hop went
        wherever the response said, and its body came back to the caller. From
        inside the cluster that reaches cloud metadata, the backend's own
        internal API, Dragonfly and the object store.

        It was survivable while only the agent called this, with URLs it had
        just received FROM RIS. ``GET /v1/ris/document`` takes the URL from a
        signed-in user, which is what makes this a gate rather than a nicety.
        """
        hops: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            hops.append(str(request.url))
            if "ris.bka.gv.at" in str(request.url):
                return httpx.Response(302, headers={"Location": "http://169.254.169.254/latest/meta-data/"})
            return httpx.Response(200, headers={"content-type": "text/plain"}, text="AWS_SECRET=hunter2")

        client = RisClient(transport=_transport(handler))

        with pytest.raises(RisError, match="Only https"):
            await client.fetch_document_text("https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=x")

        # The point is not only that it raised — it is that the second request
        # was never made. A check that ran after the fetch would still have the
        # response in hand, and an SSRF is the request, not the return value.
        assert hops == ["https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=x"]

    async def test_a_redirect_within_ris_is_still_followed(self):
        """RIS redirects between its own hosts; the gate must not break that."""

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.host == "ris.bka.gv.at":
                return httpx.Response(301, headers={"Location": "https://www.ris.bka.gv.at/Dokumente/x/y.html"})
            return httpx.Response(
                200, headers={"content-type": "text/html"}, text="<html><body><p>§ 5</p></body></html>"
            )

        client = RisClient(transport=_transport(handler))

        document = await client.fetch_document_text("https://ris.bka.gv.at/Dokumente/x/y.html")

        assert "§ 5" in document.text
        assert document.url == "https://www.ris.bka.gv.at/Dokumente/x/y.html"

    async def test_rejects_binary_content(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, headers={"content-type": "application/pdf"}, content=b"%PDF-1.4")

        client = RisClient(transport=_transport(handler))

        with pytest.raises(RisError, match="binary format"):
            await client.fetch_document_text("https://www.ris.bka.gv.at/Dokumente/x/y.pdf")

    async def test_rejects_oversized_documents(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, headers={"content-type": "text/html"}, text="x" * 2048)

        client = RisClient(transport=_transport(handler), max_document_bytes=1024)

        with pytest.raises(RisError, match="size limit"):
            await client.fetch_document_text("https://www.ris.bka.gv.at/Dokumente/x/y.html")

    async def test_json_fixture_is_serializable(self):
        # Guard against fixtures drifting into non-JSON shapes.
        assert json.loads(json.dumps(BR_KONS_RESPONSE))
