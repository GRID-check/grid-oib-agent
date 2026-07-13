"""Client for the Austrian OGD-RIS API (Rechtsinformationssystem des Bundes).

Implements the "OGD-RIS Service" v2.6 REST API documented in the
"OGD-RIS API Handbuch V2_6" (https://data.bka.gv.at/ris/api/v2.6/).

Two capabilities:

- ``search()``   — query a RIS application (Bundesrecht, Landesrecht,
  Judikatur, ...) and normalize the JSON search result into ``RisHit``
  objects carrying document numbers, titles, metadata, and content URLs.
- ``fetch_document_text()`` — download an entire document (law paragraph,
  full consolidated law, court decision, ...) from the RIS citizen
  application and convert its HTML/XML payload to plain text.

The search result payload is JSON converted from the XML response schemas
(OGD_*_Response.xsd), so element cardinality is ambiguous: a node holding
one child is a dict while the same node with several children is a list.
All parsing here therefore goes through ``_as_list``/deep-search helpers
and never assumes a fixed shape.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass
from dataclasses import field
from html import unescape
from typing import Any
from urllib.parse import urlparse

import httpx

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://data.bka.gv.at/ris/api/v2.6"

# Only documents hosted by RIS itself may be fetched through this adapter.
ALLOWED_DOCUMENT_HOSTS = frozenset(
    {
        "www.ris.bka.gv.at",
        "ris.bka.gv.at",
        "data.bka.gv.at",
    }
)

# Application code -> API controller (URL path segment of the search endpoint).
# See "Umstrukturierung der API (Controller) Namen" in the handbook.
CONTROLLER_FOR_APPLICATION: dict[str, str] = {
    # Bundesrecht
    "BrKons": "Bundesrecht",
    "BgblAuth": "Bundesrecht",
    "BgblPdf": "Bundesrecht",
    "BgblAlt": "Bundesrecht",
    "Begut": "Bundesrecht",
    "RegV": "Bundesrecht",
    "Erv": "Bundesrecht",
    # Landesrecht
    "LrKons": "Landesrecht",
    "LgblAuth": "Landesrecht",
    "Lgbl": "Landesrecht",
    "LgblNO": "Landesrecht",
    "Vbl": "Landesrecht",
    # Judikatur
    "Vfgh": "Judikatur",
    "Vwgh": "Judikatur",
    "Normenliste": "Judikatur",
    "Justiz": "Judikatur",
    "Bvwg": "Judikatur",
    "AsylGH": "Judikatur",
    "Lvwg": "Judikatur",
    "Dsk": "Judikatur",
    "Verg": "Judikatur",
    "Dok": "Judikatur",
    "Pvak": "Judikatur",
    "Gbk": "Judikatur",
    "Uvs": "Judikatur",
    "Ubas": "Judikatur",
    "Umse": "Judikatur",
    "Bks": "Judikatur",
    # Bezirke / Gemeinden
    "Bvb": "Bezirke",
    "Gr": "Gemeinden",
    "GrA": "Gemeinden",
    # Sonstige Kundmachungen, Erlässe
    "PruefGewO": "Sonstige",
    "Avsv": "Sonstige",
    "Spg": "Sonstige",
    "Avn": "Sonstige",
    "KmGer": "Sonstige",
    "Upts": "Sonstige",
    "Mrp": "Sonstige",
    "Erlaesse": "Sonstige",
}

# Documents-per-page values accepted by the API.
PAGE_SIZES: dict[int, str] = {10: "Ten", 20: "Twenty", 50: "Fifty", 100: "OneHundred"}

# Citizen-application path segment used in document content URLs
# (https://www.ris.bka.gv.at/Dokumente/<segment>/<docnr>/<docnr>.html),
# keyed by application code.
DOCUMENT_PATH_SEGMENTS: dict[str, str] = {
    "BrKons": "Bundesnormen",
    "LrKons": "Landesnormen",
    "BgblAuth": "BgblAuth",
    "Begut": "Begut",
    "RegV": "RegV",
    "Erv": "Erv",
    "Vfgh": "Vfgh",
    "Vwgh": "Vwgh",
    "Justiz": "Justiz",
    "Bvwg": "Bvwg",
    "Lvwg": "Lvwg",
    "AsylGH": "AsylGH",
    "Dsk": "Dsk",
    "Gbk": "Gbk",
    "Erlaesse": "Erlaesse",
}

# Document-number prefix -> citizen-application path segment, used to infer
# the fetch URL when the agent passes a bare document number.
_DOC_PREFIX_SEGMENTS: tuple[tuple[str, str], ...] = (
    ("NOR", "Bundesnormen"),
    ("JFT", "Vfgh"),
    ("JFR", "Vfgh"),
    ("JWT", "Vwgh"),
    ("JWR", "Vwgh"),
    ("JJT", "Justiz"),
    ("JJR", "Justiz"),
    ("BVWG", "Bvwg"),
    ("LVWG", "Lvwg"),
    ("ASYLGH", "AsylGH"),
    ("DSB", "Dsk"),
    ("ERL", "Erlaesse"),
)


class RisError(Exception):
    """Raised for OGD-RIS API errors (validation errors, bad pages, HTTP failures)."""


@dataclass
class RisHit:
    """A single normalized document reference from an OGD-RIS search result."""

    application: str = ""
    document_number: str = ""
    title: str = ""
    citation_url: str = ""  # citizen-application URL of the document (for citations)
    content_urls: dict[str, str] = field(default_factory=dict)  # DataType (Html/Xml/Pdf/Rtf) -> URL
    full_law_url: str = ""  # GesamteRechtsvorschriftUrl — the ENTIRE consolidated law as HTML
    metadata: dict[str, str] = field(default_factory=dict)  # human-relevant fields (dates, §, court, ...)

    @property
    def fetch_url(self) -> str:
        """Best URL for fetching the document text (HTML preferred, then XML)."""
        return self.content_urls.get("Html") or self.citation_url or self.content_urls.get("Xml", "")


@dataclass
class RisSearchResult:
    """Normalized OGD-RIS search response."""

    hits: list[RisHit] = field(default_factory=list)
    total: int = 0
    page: int = 1
    page_size: int = 20


@dataclass
class RisDocument:
    """A fetched RIS document converted to plain text."""

    url: str
    title: str
    text: str


# ---------------------------------------------------------------------------
# JSON traversal helpers (XML-derived JSON has dict-or-list ambiguity)
# ---------------------------------------------------------------------------


def _as_list(node: Any) -> list[Any]:
    """Normalize an XML-derived JSON node to a list (single child -> dict)."""
    if node is None:
        return []
    if isinstance(node, list):
        return node
    return [node]


def _find_first(node: Any, key: str) -> Any:
    """Breadth-first search for the first value under ``key`` anywhere in ``node``."""
    queue = [node]
    while queue:
        current = queue.pop(0)
        if isinstance(current, dict):
            if key in current:
                return current[key]
            queue.extend(current.values())
        elif isinstance(current, list):
            queue.extend(current)
    return None


def _find_all(node: Any, key: str) -> list[Any]:
    """Breadth-first search for every value under ``key`` anywhere in ``node``."""
    found: list[Any] = []
    queue = [node]
    while queue:
        current = queue.pop(0)
        if isinstance(current, dict):
            if key in current:
                found.append(current[key])
            queue.extend(current.values())
        elif isinstance(current, list):
            queue.extend(current)
    return found


def _as_text(value: Any) -> str:
    """Flatten a scalar / ``{"#text": ...}`` / list node into a display string."""
    if value is None:
        return ""
    if isinstance(value, dict):
        if "#text" in value:
            return _as_text(value["#text"])
        # e.g. Geschaeftszahl arrays come as {"item": [...]}
        return ", ".join(filter(None, (_as_text(v) for v in value.values())))
    if isinstance(value, list):
        return ", ".join(filter(None, (_as_text(v) for v in value)))
    return str(value).strip()


# Metadata fields worth surfacing to the agent, in display order.
_METADATA_FIELDS = (
    ("Kurztitel", "Kurztitel"),
    ("ArtikelParagraphAnlage", "Paragraph/Artikel"),
    ("Gesetzesnummer", "Gesetzesnummer"),
    ("Kundmachungsorgan", "Kundmachungsorgan"),
    ("Inkrafttretensdatum", "In Kraft seit"),
    ("Ausserkrafttretensdatum", "Außer Kraft seit"),
    ("Geschaeftszahl", "Geschäftszahl"),
    ("Entscheidungsdatum", "Entscheidungsdatum"),
    ("Gericht", "Gericht"),
    ("Bundesland", "Bundesland"),
    ("Bgblnummer", "BGBl-Nummer"),
)

_TITLE_KEYS = ("Kurztitel", "Titel", "Dokumenttitel", "Kurzinformation", "Geschaeftszahl")


def _parse_hit(ref: Any) -> RisHit:
    """Normalize one OgdDocumentReference node into a RisHit."""
    hit = RisHit()

    data = ref.get("Data", ref) if isinstance(ref, dict) else ref
    metadaten = _find_first(data, "Metadaten") or data

    technisch = _find_first(metadaten, "Technisch") or {}
    hit.document_number = _as_text(technisch.get("ID") if isinstance(technisch, dict) else None) or _as_text(
        _find_first(metadaten, "Dokumentnummer")
    )
    hit.application = _as_text(technisch.get("Applikation") if isinstance(technisch, dict) else None)

    for key in _TITLE_KEYS:
        title = _as_text(_find_first(metadaten, key))
        if title:
            hit.title = title
            break

    hit.citation_url = _as_text(_find_first(metadaten, "DokumentUrl"))
    hit.full_law_url = _as_text(_find_first(metadaten, "GesamteRechtsvorschriftUrl"))

    for key, label in _METADATA_FIELDS:
        value = _as_text(_find_first(metadaten, key))
        if value and label not in hit.metadata:
            hit.metadata[label] = value

    # Content URLs live under Dokumentliste/ContentReference/Urls/ContentUrl.
    for content_url in _find_all(ref, "ContentUrl"):
        for entry in _as_list(content_url):
            if not isinstance(entry, dict):
                continue
            data_type = _as_text(entry.get("DataType"))
            url = _as_text(entry.get("Url"))
            if data_type and url and data_type not in hit.content_urls:
                hit.content_urls[data_type] = url

    return hit


def parse_search_response(payload: dict[str, Any]) -> RisSearchResult:
    """Parse a raw OGD-RIS JSON response into a RisSearchResult.

    Raises:
        RisError: When the payload carries an ``OgdSearchResult.Error`` node.
    """
    result = payload.get("OgdSearchResult")
    if not isinstance(result, dict):
        raise RisError("Unexpected OGD-RIS response: missing OgdSearchResult")

    error = result.get("Error")
    if isinstance(error, dict):
        application = _as_text(error.get("Applikation"))
        message = _as_text(error.get("Message")) or "unknown error"
        raise RisError(f"OGD-RIS API error ({application or 'unknown application'}): {message}")

    doc_results = result.get("OgdDocumentResults") or {}
    hits_node = doc_results.get("Hits")
    total = 0
    page = 1
    page_size = 20
    if isinstance(hits_node, dict):
        total = int(_as_text(hits_node.get("#text")) or 0)
        page = int(_as_text(hits_node.get("@pageNumber")) or 1)
        page_size = int(_as_text(hits_node.get("@pageSize")) or 20)
    elif hits_node is not None:
        total = int(_as_text(hits_node) or 0)

    hits = [_parse_hit(ref) for ref in _as_list(doc_results.get("OgdDocumentReference"))]
    return RisSearchResult(hits=hits, total=total, page=page, page_size=page_size)


# ---------------------------------------------------------------------------
# HTML / XML -> plain text
# ---------------------------------------------------------------------------

_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)


def html_to_text(markup: str) -> tuple[str, str]:
    """Convert an HTML/XML document to (title, plain text).

    Uses BeautifulSoup when available; falls back to a regex tag stripper so
    the adapter degrades gracefully rather than failing the whole tool call.
    """
    title = ""
    title_match = _TITLE_RE.search(markup)
    if title_match:
        title = unescape(re.sub(r"\s+", " ", title_match.group(1))).strip()

    try:
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(markup, "html.parser")
        for tag in soup(["script", "style", "noscript", "head"]):
            tag.decompose()
        text = soup.get_text("\n")
    except ImportError:  # pragma: no cover - bs4 is a declared dependency
        text = re.sub(r"(?is)<(script|style|head)[^>]*>.*?</\1>", " ", markup)
        text = unescape(re.sub(r"<[^>]+>", "\n", text))

    # Collapse intra-line whitespace and runs of blank lines.
    lines = [re.sub(r"[ \t\xa0]+", " ", line).strip() for line in text.splitlines()]
    collapsed: list[str] = []
    for line in lines:
        if line:
            collapsed.append(line)
        elif collapsed and collapsed[-1] != "":
            collapsed.append("")
    return title, "\n".join(collapsed).strip()


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


class RisClient:
    """Async client for OGD-RIS search and document fetching.

    Reuses one HTTP connection pool, retries transient failures with
    exponential backoff, and keeps a small TTL cache of fetched documents.
    """

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 30.0,
        max_document_bytes: int = 10 * 1024 * 1024,
        cache_ttl_seconds: float = 3600.0,
        cache_max_entries: int = 64,
        max_retries: int = 3,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_document_bytes = max_document_bytes
        self.cache_ttl_seconds = cache_ttl_seconds
        self.cache_max_entries = cache_max_entries
        self.max_retries = max(1, max_retries)
        self._transport = transport
        self._client: httpx.AsyncClient | None = None
        self._doc_cache: dict[str, tuple[float, RisDocument]] = {}

    def _http_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                timeout=self.timeout,
                follow_redirects=True,
                transport=self._transport,
                headers={
                    "Accept": "application/json, text/html;q=0.9, */*;q=0.8",
                    "User-Agent": "grid-oib-agent-ris-adapter/1.0 (+https://data.bka.gv.at/ris/api/v2.6)",
                },
            )
        return self._client

    async def aclose(self) -> None:
        """Close the pooled HTTP connection (idempotent)."""
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()
        self._client = None

    async def _get_with_retries(self, url: str, params: dict[str, str] | None = None) -> httpx.Response:
        """GET with exponential backoff on transport errors and 5xx responses.

        HTTP 500 responses carrying a structured ``OgdSearchResult.Error`` are
        NOT retried — they are deterministic validation errors the caller must
        surface to the agent.
        """
        last_error: Exception | None = None
        for attempt in range(self.max_retries):
            try:
                response = await self._http_client().get(url, params=params)
                if response.status_code >= 500:
                    try:
                        parse_search_response(response.json())
                    except RisError:
                        raise
                    except Exception:
                        pass
                    last_error = RisError(f"OGD-RIS request failed with HTTP {response.status_code}")
                else:
                    response.raise_for_status()
                    return response
            except RisError:
                raise
            except httpx.HTTPStatusError as exc:
                raise RisError(f"OGD-RIS request failed with HTTP {exc.response.status_code}: {url}") from exc
            except httpx.HTTPError as exc:
                last_error = exc
            if attempt < self.max_retries - 1:
                await asyncio.sleep(2**attempt)
        if isinstance(last_error, RisError):
            raise last_error
        raise RisError(f"OGD-RIS request failed after {self.max_retries} attempts: {last_error}") from last_error

    async def search(
        self,
        application: str,
        params: dict[str, str] | None = None,
        page: int = 1,
        page_size: int = 20,
    ) -> RisSearchResult:
        """Run a search against the application's controller endpoint.

        Args:
            application: RIS application code (e.g. ``BrKons``, ``LrKons``, ``Vfgh``).
            params: Additional query parameters (e.g. ``{"Suchworte": "..."}``).
            page: 1-based result page.
            page_size: Documents per page — one of 10, 20, 50, 100.

        Raises:
            RisError: For unknown applications, transport failures, or API errors.
        """
        controller = CONTROLLER_FOR_APPLICATION.get(application)
        if controller is None:
            valid = ", ".join(sorted(CONTROLLER_FOR_APPLICATION))
            raise RisError(f"Unknown RIS application '{application}'. Valid applications: {valid}")

        if page_size not in PAGE_SIZES:
            page_size = 20

        query: dict[str, str] = {
            "Applikation": application,
            "DokumenteProSeite": PAGE_SIZES[page_size],
            "Seitennummer": str(max(1, page)),
        }
        query.update({k: v for k, v in (params or {}).items() if v})

        url = f"{self.base_url}/{controller}"
        response = await self._get_with_retries(url, params=query)
        try:
            payload = response.json()
        except ValueError as exc:
            raise RisError("OGD-RIS returned a non-JSON response") from exc

        return parse_search_response(payload)

    async def fetch_document_text(self, url: str) -> RisDocument:
        """Fetch an entire document from RIS and convert it to plain text.

        Args:
            url: An ``https`` URL on an allowed RIS host. HTML and XML payloads
                are converted to text; binary payloads (PDF/RTF) are rejected
                with a hint to use the document's HTML variant.

        Raises:
            RisError: For disallowed URLs, transport failures, or binary payloads.
        """
        self._validate_document_url(url)

        cached = self._doc_cache.get(url)
        if cached and (time.monotonic() - cached[0]) < self.cache_ttl_seconds:
            return cached[1]

        response = await self._get_with_retries(url)

        if len(response.content) > self.max_document_bytes:
            raise RisError(f"RIS document exceeds the {self.max_document_bytes // (1024 * 1024)} MiB size limit: {url}")

        content_type = response.headers.get("content-type", "").lower()
        if any(binary in content_type for binary in ("pdf", "rtf", "octet-stream", "msword")):
            raise RisError(
                f"Document at {url} is only available as a binary format ({content_type}). "
                "Use the document's Html content URL from ris_search instead."
            )

        title, text = html_to_text(response.text)
        if not text:
            raise RisError(f"RIS document at {url} contained no extractable text")

        document = RisDocument(url=str(response.url), title=title, text=text)
        self._cache_document(url, document)
        return document

    def _cache_document(self, url: str, document: RisDocument) -> None:
        if len(self._doc_cache) >= self.cache_max_entries:
            oldest = min(self._doc_cache, key=lambda key: self._doc_cache[key][0])
            del self._doc_cache[oldest]
        self._doc_cache[url] = (time.monotonic(), document)

    @staticmethod
    def _validate_document_url(url: str) -> None:
        parsed = urlparse(url)
        if parsed.scheme != "https":
            raise RisError(f"Only https RIS URLs can be fetched, got: {url}")
        if parsed.hostname not in ALLOWED_DOCUMENT_HOSTS:
            allowed = ", ".join(sorted(ALLOWED_DOCUMENT_HOSTS))
            raise RisError(f"Refusing to fetch non-RIS URL (host '{parsed.hostname}'). Allowed hosts: {allowed}")


def build_document_url(reference: str, application: str = "") -> str:
    """Build a citizen-application document URL from a bare document number.

    Args:
        reference: RIS document number, e.g. ``NOR40217157`` or ``JWT_2020130074_20210415J00``.
        application: Optional application code (``BrKons``, ``Vfgh``, ...) to
            disambiguate the URL path segment. When omitted the segment is
            inferred from the document-number prefix.

    Raises:
        RisError: When the reference is not a plausible document number or the
            application/path segment cannot be determined.
    """
    reference = reference.strip()
    if not re.fullmatch(r"[A-Za-z0-9_.\-]+", reference):
        raise RisError(
            f"'{reference}' is neither a RIS URL nor a document number. "
            "Pass a document number from ris_search (e.g. NOR40217157) or a https://www.ris.bka.gv.at/... URL."
        )

    segment = DOCUMENT_PATH_SEGMENTS.get(application) if application else None
    if segment is None:
        upper = reference.upper()
        for prefix, prefix_segment in _DOC_PREFIX_SEGMENTS:
            if upper.startswith(prefix):
                segment = prefix_segment
                break
    if segment is None:
        raise RisError(
            f"Cannot determine the RIS application for document number '{reference}'. "
            "Pass the 'application' argument (e.g. BrKons, LrKons, Vfgh, Vwgh, Justiz, Bvwg, Lvwg) "
            "or pass the document URL from ris_search directly."
        )

    return f"https://www.ris.bka.gv.at/Dokumente/{segment}/{reference}/{reference}.html"
