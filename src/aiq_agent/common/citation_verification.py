"""Deterministic citation and report post-processing for research reports.

This module provides:
- SourceRegistry: captures URLs/citation keys from tool call results
- verify_citations(): validates cited source identities against the registry
- sanitize_report(): normalizes final report display and URL hygiene
- Extensible parser registry for adding new source types

Usage:
    registry = SourceRegistry()
    # ... populate via SourceRegistryMiddleware or manually ...
    result = verify_citations(report_text, registry)
    clean_report = result.verified_report
"""

from __future__ import annotations

import contextvars
import dataclasses
import difflib
import logging
import os
import re
import threading
import unicodedata
from collections import OrderedDict
from collections.abc import Callable
from collections.abc import Sequence
from dataclasses import dataclass
from dataclasses import field
from html import unescape
from typing import TYPE_CHECKING
from typing import Any
from urllib.parse import parse_qs
from urllib.parse import unquote
from urllib.parse import urlparse
from urllib.parse import urlunparse

from aiq_agent.common.source_kinds import TOOL_RESULT_SOURCE_TYPE
from aiq_agent.common.source_kinds import kind_for_lane

if TYPE_CHECKING:
    from aiq_agent.common.norm_registry import NormRegistry

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------


@dataclass
class SourceEntry:
    """A single source captured from a tool call result."""

    url: str | None = None
    title: str | None = None
    citation_key: str | None = None
    source_type: str = ""
    tool_name: str = ""
    # Retrieval collection the hit came from (oib_knowledge, s_*, proj_*, archiv_*),
    # parsed from the knowledge-layer tool output's `Collection:` field. None for
    # URL/web sources and for output produced before the field was threaded.
    collection: str | None = None
    # Explicit per-document classification ("Dokumentart" / doc_class), parsed
    # from the knowledge-layer tool output's `Dokumentart:` field. When present
    # it is the FIRST-priority signal for lane/kind placement, overriding the
    # filename/collection heuristics. None for sources without an explicit class.
    doc_class: str | None = None
    # Retrieved passage body for knowledge-layer hits (the chunk content the KB
    # tool returned, truncated at 1500 chars per chunk). Used by
    # ``verify_quoted_spans`` to check that a QUOTED sentence in the answer
    # actually appears (fuzzily) in the evidence, catching the DeepSeek "cites a
    # real section but fabricates the quote" bug. When several chunks dedup onto
    # the same (filename, page) key their bodies are joined (see ``add``). None
    # for URL/web sources and for output produced before this field was threaded.
    chunk_text: str | None = None


@dataclass
class CitationVerificationResult:
    """Result of running verify_citations()."""

    verified_report: str
    removed_citations: list[dict] = field(default_factory=list)
    valid_citations: list[dict] = field(default_factory=list)


class EmptySourceRegistryError(Exception):
    """Raised when no sources were captured during research."""

    def __init__(
        self,
        agent_type: str = "research",
        unavailable_tools: list[str] | None = None,
        available_count: int = 0,
    ) -> None:
        self.agent_type = agent_type
        self.unavailable_tools = unavailable_tools or []
        self.available_count = available_count
        super().__init__(
            f"Research failed: no sources were captured during {agent_type}. "
            "All tool calls may have failed or returned no results. "
            "Please try again."
        )


_TRACKING_PARAMS = frozenset(
    {
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_term",
        "utm_content",
        "ref",
        "source",
    }
)


def _normalize_url(url: str) -> str:
    """Normalize a URL for comparison.

    Lowercases scheme/host, strips trailing slash, removes fragments
    and common tracking parameters.
    """
    url = unescape(url).strip()
    parsed = urlparse(url)
    scheme = parsed.scheme.lower()
    netloc = parsed.netloc.lower()
    path = unquote(parsed.path).rstrip("/") or "/"
    # Remove tracking params
    qs = parse_qs(parsed.query, keep_blank_values=True)
    filtered_qs = {k: v for k, v in qs.items() if k.lower() not in _TRACKING_PARAMS}
    query_str = "&".join(f"{k}={v[0]}" for k, v in sorted(filtered_qs.items()) if v)
    return urlunparse((scheme, netloc, path, "", query_str, ""))


# ---------------------------------------------------------------------------
# Knowledge-layer fuzzy matching helpers
# ---------------------------------------------------------------------------

# The page token must be a separate word (preceded by a comma or whitespace
# and followed by a delimiter or end), so filenames containing "p" + digits
# (e.g. "Top2.pdf", "wp2023.pdf") are not truncated into bogus page refs.
_PAGE_RE = re.compile(r"[,\s]\s*(?:p\.?|page)\s*(\d+)(?=\s*(?:[,)\]]|$))", re.IGNORECASE)


def _parse_citation_key(key: str) -> tuple[str, int | None]:
    """Extract (filename, page_number) from a citation key.

    Handles: "report.pdf, p.15", "report.pdf, page 15", "report.pdf",
    "report.pdf, p.15, Table 1"
    """
    page_match = _PAGE_RE.search(key)
    page = int(page_match.group(1)) if page_match else None
    # Filename is everything before the page reference (or the whole key)
    if page_match:
        filename = key[: page_match.start()].rstrip(", ").strip()
    else:
        filename = key.strip()
    return filename, page


@dataclass
class _ParsedURL:
    """Pre-parsed URL components cached at registration time."""

    host: str
    path: str
    path_segments: list[str]
    query: dict[str, list[str]]
    entry: SourceEntry


# ---------------------------------------------------------------------------
# SourceRegistry
# ---------------------------------------------------------------------------


class SourceRegistry:
    """Registry of sources captured from tool call results.

    Not thread-safe — this is intentional.  All access happens on a single
    asyncio event loop (cooperative concurrency), and Python's GIL already
    protects the underlying dict/list/set operations from corruption.
    The module-level ``_session_registries`` dict *is* lock-protected because
    it is accessed across event loops when creating/looking up sessions.
    """

    def __init__(self) -> None:
        self._urls: dict[str, SourceEntry] = {}
        self._parsed_urls: dict[str, _ParsedURL] = {}
        self._citation_keys: list[SourceEntry] = []
        # Dedup key is (filename, page): two chunks from the SAME document at
        # DIFFERENT pages are distinct evidence and must both become chips.
        # Keying on filename alone silently dropped every page after the first
        # (and mismatched the page-aware Trace-Lanes fan-out — see ADR-0026).
        self._citation_key_files: set[tuple[str, int | None]] = set()
        self._all: list[SourceEntry] = []

    def add(self, entry: SourceEntry) -> None:
        """Register a source entry. One entry per logical URL (dedup by normalized form).

        Raw URL = entry.url (exactly as the tool returned it); that is what we
        retain in the report. Normalized URL is used only as a key for dedup
        and matching. Both raw and normalized are stored as keys to the same
        entry so we never have duplicate entries and lookups find the tool URL.
        """
        added = False
        if entry.url:
            raw = entry.url
            normalized = _normalize_url(raw)
            if normalized not in self._urls:
                self._urls[normalized] = entry
                parsed = urlparse(normalized)
                self._parsed_urls[normalized] = _ParsedURL(
                    host=parsed.netloc,
                    path=parsed.path,
                    path_segments=[s for s in parsed.path.split("/") if s],
                    query=parse_qs(parsed.query, keep_blank_values=True),
                    entry=entry,
                )
                added = True
            if raw != normalized:
                self._urls[raw] = self._urls[normalized]
        if entry.citation_key:
            filename, page = _parse_citation_key(entry.citation_key)
            dedup_key = (filename.lower(), page)
            if dedup_key not in self._citation_key_files:
                self._citation_key_files.add(dedup_key)
                self._citation_keys.append(entry)
                if not added:
                    added = True
            elif entry.chunk_text:
                # A single page may hold >1 retrieved chunk; dedup collapses them
                # onto one (filename, page) entry, but each chunk's body is
                # distinct evidence for quote verification. Append the new body to
                # the surviving entry so the whole-registry fuzzy match sees every
                # chunk of the page rather than only the first.
                for existing in self._citation_keys:
                    existing_file, existing_page = _parse_citation_key(existing.citation_key)
                    if (existing_file.lower(), existing_page) == dedup_key:
                        if not existing.chunk_text:
                            existing.chunk_text = entry.chunk_text
                        elif entry.chunk_text not in existing.chunk_text:
                            existing.chunk_text = f"{existing.chunk_text}\n\n{entry.chunk_text}"
                        break
        if added:
            self._all.append(entry)

    def has_url(self, url: str) -> bool:
        """Check if a URL (after normalization) is in the registry."""
        return _normalize_url(url) in self._urls

    @staticmethod
    def _pick_unique(candidates: list[SourceEntry], strategy: str, url: str) -> str | None:
        """Return the registry URL when exactly one candidate matches.

        The source section can only show one URL per citation. If multiple
        registry URLs match (e.g. same path, different query), we cannot know
        which one the author meant, so we reject.
        """
        if len(candidates) == 1:
            logger.debug("[CitationVerify] %s match: '%s' → '%s'", strategy, url, candidates[0].url)
            return candidates[0].url
        if len(candidates) > 1:
            logger.debug(
                "[CitationVerify] Ambiguous %s match for '%s' — %d candidates, rejecting",
                strategy,
                url,
                len(candidates),
            )
        return None

    def resolve_url(self, url: str) -> str | None:
        """Return the registry URL (full, as returned by the tool) when the report URL matches.

        Matching strategy (first unambiguous match wins):
        1. Exact match — raw or normalized
        2. Truncation — report URL is a prefix of exactly one registry URL (raw)
        3. Prefix — report normalized is prefix of registry normalized
        4. Child-path — report path is a subpath of exactly one registry URL
        5. Query-subset — same host+path, report params subset of one registry URL

        Always returns the tool's URL (with query params etc.). If multiple
        registry URLs match, we reject (ambiguous).
        """
        # 1. Exact match — raw or normalized; retain the tool's URL
        if url in self._urls:
            return self._urls[url].url
        normalized = _normalize_url(url)
        if normalized in self._urls:
            return self._urls[normalized].url

        # 2. Truncation — report URL is a prefix of exactly one registry URL (raw).
        #    Normalized match fails when the report is cut mid-query (param order differs).
        truncation_entries = [e for e in self._urls.values() if e.url and e.url.startswith(url)]
        result = self._pick_unique(list({e.url: e for e in truncation_entries}.values()), "truncation", url)
        if result:
            return result

        # 3. Prefix match — report normalized is prefix of registry normalized
        #    Deduplicate by url to avoid raw+normalized keys for the same entry
        #    being counted as ambiguous.
        prefix_entries = [e for n, e in self._urls.items() if n.startswith(normalized)]
        result = self._pick_unique(
            list({e.url: e for e in prefix_entries}.values()),
            "prefix",
            url,
        )
        if result:
            return result

        parsed = urlparse(normalized)
        host, path = parsed.netloc, parsed.path
        same_host = [p for p in self._parsed_urls.values() if p.host == host]

        # 4. Child-path match — report path extends a registry path (subpage)
        #    Use rstrip("/") + "/" to enforce segment boundaries (prevents
        #    /us/benefits matching /us/benefitsOther).
        result = self._pick_unique(
            [
                p.entry
                for p in same_host
                if len(p.path_segments) >= 2 and path != p.path and path.startswith(p.path.rstrip("/") + "/")
            ],
            "child-path",
            url,
        )
        if result:
            return result

        # 5. Query-subset match — same host+path, report params are a subset of registry params
        report_qs = parse_qs(parsed.query, keep_blank_values=True)
        if report_qs:
            result = self._pick_unique(
                [
                    p.entry
                    for p in same_host
                    if p.path == path and p.query and all(p.query.get(k) == v for k, v in report_qs.items())
                ],
                "query-subset",
                url,
            )
            if result:
                return result

        return None

    def has_citation_key(self, key: str) -> bool:
        """Lenient match of a citation key against registry entries.

        Matches if filename (case-insensitive) matches ANY registry entry.
        Page numbers are not required to match — the LLM may cite a different
        page than what the knowledge layer returned, and that's acceptable
        since the document itself was verified as a real source.
        """
        target_file, _ = _parse_citation_key(key)
        target_lower = target_file.lower()
        for entry in self._citation_keys:
            entry_file, _ = _parse_citation_key(entry.citation_key)
            if entry_file.lower() == target_lower:
                return True
        return False

    def entry_for_url(self, url: str) -> SourceEntry | None:
        """Return the registry entry for a URL already resolved via ``resolve_url``.

        ``resolve_url`` returns the registry's canonical URL string, which is
        stored (raw and normalized) as a key to its entry, so an exact lookup
        recovers the owning :class:`SourceEntry` for origin-token labeling.
        """
        entry = self._urls.get(url)
        if entry is not None:
            return entry
        return self._urls.get(_normalize_url(url))

    def entry_for_citation_key(self, key: str) -> SourceEntry | None:
        """Return the registry entry best matching ``key`` (lenient on the page).

        Identity still matches :meth:`has_citation_key` — filename-only and
        case-insensitive — but when the SAME document was retrieved at several
        pages, the entry whose page the citation actually names wins. The entry
        this returns is what supplies the wire's ``page``, and therefore the page
        the UI opens the PDF at; returning "whichever chunk landed in the
        registry first" made a citation to p.30 open at p.12 whenever both were
        retrieved. Falls back to the first filename match (so a page the
        retrieval never returned still resolves to a real, retrieved page rather
        than to nothing).
        """
        target_file, target_page = _parse_citation_key(key)
        target_lower = target_file.lower()
        fallback: SourceEntry | None = None
        for entry in self._citation_keys:
            entry_file, entry_page = _parse_citation_key(entry.citation_key)
            if entry_file.lower() != target_lower:
                continue
            if target_page is not None and entry_page == target_page:
                return entry
            if fallback is None:
                fallback = entry
        return fallback

    def all_sources(self) -> list[SourceEntry]:
        """Return all registered sources."""
        return list(self._all)

    def clear(self) -> None:
        """Reset the registry."""
        self._urls.clear()
        self._parsed_urls.clear()
        self._citation_keys.clear()
        self._citation_key_files.clear()
        self._all.clear()


# ---------------------------------------------------------------------------
# Session-scoped registry (ContextVar)
# ---------------------------------------------------------------------------

_session_source_registry: contextvars.ContextVar[SourceRegistry | None] = contextvars.ContextVar(
    "_session_source_registry", default=None
)

_MAX_SESSION_REGISTRIES = 1000
_session_registries: OrderedDict[str, SourceRegistry] = OrderedDict()
_session_registries_lock = threading.Lock()


# Cross-turn citation state survives process restarts and replica moves via
# the shared cache (ADR-0020); the in-process LRU stays the fast path.
_REGISTRY_CACHE_PREFIX = "citations:"
_REGISTRY_CACHE_TTL_SECONDS = int(os.environ.get("GRID_CITATION_REGISTRY_TTL_SECONDS", "86400"))


def _registry_from_cached_entries(entries: Any) -> SourceRegistry:
    registry = SourceRegistry()
    if isinstance(entries, list):
        for item in entries:
            if isinstance(item, dict):
                try:
                    registry.add(
                        SourceEntry(
                            url=item.get("url"),
                            title=item.get("title"),
                            citation_key=item.get("citation_key"),
                            source_type=item.get("source_type", ""),
                            tool_name=item.get("tool_name", ""),
                            collection=item.get("collection"),
                            doc_class=item.get("doc_class"),
                            chunk_text=item.get("chunk_text"),
                        )
                    )
                except Exception:
                    logger.debug("Skipping malformed cached source entry", exc_info=True)
    return registry


def persist_session_registry(session_id: str | None) -> None:
    """Write a session's captured sources to the shared cache (best-effort).

    Call after a turn that may have captured sources; synchronous (wrap in
    ``asyncio.to_thread`` from the event loop).
    """
    if not session_id:
        return
    with _session_registries_lock:
        registry = _session_registries.get(session_id)
    if registry is None or not registry._all:
        return
    from aiq_agent.common import cache

    cache.set_json(
        f"{_REGISTRY_CACHE_PREFIX}{session_id}",
        [dataclasses.asdict(entry) for entry in registry._all],
        _REGISTRY_CACHE_TTL_SECONDS,
    )


def get_or_create_session_registry(session_id: str | None) -> SourceRegistry:
    """Get or create a session-scoped SourceRegistry (LRU, max 1000 sessions).

    When session_id is None (e.g. CLI or batch modes with no conversation context),
    a fresh isolated SourceRegistry is returned on every call to prevent anonymous
    sessions from sharing state and leaking citations across concurrent requests.

    On a local miss the shared cache is consulted, so a conversation resumed on
    another replica (or after a restart) keeps its prior-turn citation sources.
    """
    if session_id is None:
        return SourceRegistry()
    with _session_registries_lock:
        if session_id in _session_registries:
            _session_registries.move_to_end(session_id)
            return _session_registries[session_id]

    # Shared-cache hydration outside the lock (network I/O must not serialize
    # unrelated sessions); the double-checked insert below resolves races.
    from aiq_agent.common import cache

    hydrated: SourceRegistry | None = None
    try:
        entries = cache.get_json(f"{_REGISTRY_CACHE_PREFIX}{session_id}")
        if entries:
            hydrated = _registry_from_cached_entries(entries)
    except Exception:
        logger.debug("Citation registry hydration failed for %s", session_id, exc_info=True)

    with _session_registries_lock:
        if session_id in _session_registries:
            _session_registries.move_to_end(session_id)
            return _session_registries[session_id]
        registry = hydrated if hydrated is not None else SourceRegistry()
        _session_registries[session_id] = registry
        while len(_session_registries) > _MAX_SESSION_REGISTRIES:
            _session_registries.popitem(last=False)
        return registry


# ---------------------------------------------------------------------------
# Per-turn capture log (ContextVar)
# ---------------------------------------------------------------------------
#
# The SourceRegistry is deliberately CUMULATIVE across a conversation, so a
# later turn can still cite a document an earlier turn retrieved. That makes it
# the wrong denominator for per-turn citation-health telemetry: reporting
# ``len(registry.all_sources())`` as "sources retrieved" grew monotonically
# while "sources cited" stayed per-turn, so the dashboard's implied efficiency
# decayed over a long conversation for reasons that had nothing to do with
# citation quality — and a turn that re-cited an earlier document could report
# more citations than retrievals.
#
# This log records what THIS turn's tool calls actually returned. It is scoped
# with a ContextVar (like the session registry) so concurrent turns cannot mix.

_turn_captured_sources: contextvars.ContextVar[list[SourceEntry] | None] = contextvars.ContextVar(
    "_turn_captured_sources", default=None
)


def begin_turn_capture() -> contextvars.Token:
    """Start recording this turn's captured sources. Pair with :func:`end_turn_capture`."""
    return _turn_captured_sources.set([])


def end_turn_capture(token: contextvars.Token) -> None:
    """Stop recording this turn's captured sources."""
    _turn_captured_sources.reset(token)


def record_turn_capture(entries: Sequence[SourceEntry]) -> None:
    """Note sources a tool call returned during this turn. No-op when not recording."""
    log = _turn_captured_sources.get()
    if log is not None:
        log.extend(entries)


def get_turn_captures() -> list[SourceEntry]:
    """Distinct sources this turn's tool calls returned, in first-seen order.

    Deduplicated on the same identity the registry uses (URL / document key), so
    a document returned by two queries in one turn counts once — but a document
    retrieved again in a LATER turn counts again for that turn, which
    ``registry.all_sources()`` could not express.
    """
    log = _turn_captured_sources.get()
    if not log:
        return []
    seen: set[str] = set()
    unique: list[SourceEntry] = []
    for entry in log:
        identity = _normalize_url(entry.url) if entry.url else (entry.citation_key or "").lower()
        if not identity or identity in seen:
            continue
        seen.add(identity)
        unique.append(entry)
    return unique


def set_session_registry(registry: SourceRegistry | None) -> contextvars.Token:
    """Set the session-scoped SourceRegistry for the current async context."""
    return _session_source_registry.set(registry)


def reset_session_registry(token: contextvars.Token) -> None:
    """Restore the session-scoped SourceRegistry to its previous value."""
    _session_source_registry.reset(token)


def get_session_registry() -> SourceRegistry | None:
    """Get the session-scoped SourceRegistry for the current async context."""
    return _session_source_registry.get()


# ---------------------------------------------------------------------------
# Parser registry
# ---------------------------------------------------------------------------

SourceParser = Callable[[str, str], list[SourceEntry]]

_PARSER_REGISTRY: list[tuple[Callable[[str], bool], SourceParser]] = []


def register_source_parser(
    match_fn: Callable[[str], bool],
    parser_fn: SourceParser,
) -> None:
    """Register a parser for a tool name pattern.

    Args:
        match_fn: Predicate on lowercase tool name.
        parser_fn: (content, tool_name) -> list[SourceEntry]
    """
    _PARSER_REGISTRY.append((match_fn, parser_fn))


def extract_sources_from_tool_result(
    tool_name: str,
    content: str,
    source_id: str | None = None,
) -> list[SourceEntry]:
    """Extract sources from a tool's output.

    Strategy:
    1. If a registered parser matches the tool name, use it (for special
       formats like knowledge layer citation keys).
    2. Otherwise, fall back to the generic URL extractor which finds all
       URLs in any tool output regardless of format.
    3. If neither produces entries, register the tool result itself as a
       non-URL citation source.

    This means new sources (Bing, Perplexity, etc.) work automatically
    without any parser registration — as long as their output contains URLs.

    The non-URL fallback is permissive on purpose: callers (the shallow and
    deep researchers) are responsible for deciding which tool calls are
    eligible to contribute sources, typically by limiting capture to the
    agent's loaded tool set. The optional ``source_id`` is stored on the
    returned entries when callers have resolved this tool to a configured
    data source via
    :func:`aiq_agent.common.data_source_registry.get_source_id_for_tool`,
    but it does not gate the fallback.
    """
    name_lower = tool_name.lower()
    for match_fn, parser_fn in _PARSER_REGISTRY:
        if match_fn(name_lower):
            try:
                return parser_fn(content, tool_name)
            except Exception:
                logger.warning("Parser failed for tool %s, falling back to generic", tool_name, exc_info=True)
                break
    # Generic fallback: extract all URLs from content
    entries = _parse_generic_urls(content, tool_name)
    if entries:
        return entries

    if _is_non_citable_status_output(content):
        return []

    # Non-URL fallback: register the tool result itself as a source whenever
    # the tool produced non-empty output. The caller has already decided
    # this tool is eligible to contribute sources (typically by limiting
    # capture to the agent's loaded tool set).
    if content.strip():
        return [SourceEntry(citation_key=tool_name, source_type=TOOL_RESULT_SOURCE_TYPE, tool_name=tool_name)]

    return []


# Batch source-tool output format (see deep_researcher's
# _format_batch_tool_output): "## Query: <q>\n<body>" sections joined by
# "\n\n---\n\n".
_BATCH_SECTION_SEPARATOR_RE = re.compile(r"\n\s*---\s*\n")
_BATCH_QUERY_HEADING_RE = re.compile(r"\A\s*##\s*Query:[^\n]*\n?", re.IGNORECASE)


def _split_batch_output_bodies(content: str) -> list[str] | None:
    """Split batch source-tool output into per-query bodies.

    Returns None when content is not batch-formatted (i.e. any section does
    not start with a "## Query:" heading).
    """
    sections = _BATCH_SECTION_SEPARATOR_RE.split(content.strip())
    bodies: list[str] = []
    for section in sections:
        heading_match = _BATCH_QUERY_HEADING_RE.match(section)
        if heading_match is None:
            return None
        bodies.append(section[heading_match.end() :])
    return bodies or None


def _is_non_citable_status_output(content: str) -> bool:
    """Return whether content is a tool status/error message, not evidence.

    Understands the batched source-tool output format: a batch whose items ALL
    errored (or returned nothing) is a status report, not citable evidence.
    A batch with at least one substantive item stays citable.
    """
    batch_bodies = _split_batch_output_bodies(content)
    if batch_bodies is not None:
        return all(not body.strip() or _is_status_message(body) for body in batch_bodies)
    return _is_status_message(content)


def _is_status_message(content: str) -> bool:
    """Return whether a single tool output (or batch item body) is a status message."""
    stripped = content.strip()
    normalized = re.sub(r"\s+", " ", stripped).rstrip(".").lower()
    if not normalized:
        return False
    if normalized.startswith("error:"):
        return True
    if normalized == "search returned no results" or normalized.endswith(" search returned no results"):
        return True
    # No-result outputs from source tools (e.g. the RIS adapter's
    # "No RIS documents found for query ...") are status reports, not evidence,
    # and must not become citations. The known no-result prefixes only qualify
    # when the body actually has the shape of a terse status line — a SINGLE,
    # reasonably SHORT line, matching the real RIS no-result output. A multi-line
    # or long body that merely LEADS with one of these phrases (e.g. "No results
    # found for the exact phrase, however: <records>") carries substantive
    # content and must survive as citable evidence.
    is_terse_status_line = "\n" not in stripped and len(normalized) <= 300
    return is_terse_status_line and normalized.startswith(
        (
            "no ris documents found",
            "no documents found",
            "no results found",
        )
    )


# ---------------------------------------------------------------------------
# Built-in parsers
# ---------------------------------------------------------------------------

# Generic URL extractor — works for any tool output format.
# Commas are valid URL path characters (RFC 3986 sub-delim) and appear in real
# URLs like https://weathercams.faa.gov/map/-122.31167,47.22287,10/...; we
# include them in the match and rely on _URL_TRIM_CHARS below to strip any
# comma that's actually sentence punctuation. ``]`` stays excluded here
# because it almost always terminates a markdown link rather than appearing
# in a path.
_GENERIC_URL_RE = re.compile(r"https?://[^\s<>\"'\]]+")

# Trailing characters to strip from a captured URL.  Covers sentence
# punctuation and the closing chars of common Markdown wrappers — ``]`` for
# ``[https://...]`` and ``>`` for ``<https://...>``.  Used at every site that
# captures a URL via a permissive regex (registration and verification).
_URL_TRIM_CHARS = ".,;)]>"


# Patterns for extracting titles near URLs in common tool output formats
_TITLE_NEAR_URL_PATTERNS = [
    # Tavily: <title>\nSome Title\n</title>
    re.compile(r"<title>\s*\n?(.*?)\n?\s*</title>", re.DOTALL | re.IGNORECASE),
    # Paper search: N. **Title** (Year)
    re.compile(r"^\d+\.\s+\*\*(.+?)\*\*", re.MULTILINE),
    # Additional title patterns: --- Title ---
    re.compile(r"^---\s+(.+?)\s+---$", re.MULTILINE),
    # Key-value: Title: Some Title
    re.compile(r"^Title:\s*(.+)$", re.MULTILINE),
]


def _extract_title_for_url(content: str, url: str, blocks: list[str] | None = None) -> str | None:
    """Try to extract a title associated with a URL from the surrounding content.

    Finds the title pattern **closest to** (and preceding) the URL within its
    text block.  This prevents a single block containing multiple search
    results from assigning the first result's title to every URL.

    ``blocks`` may be supplied pre-split (by the same
    ``re.split(r"\\n\\n---\\n\\n|\\n\\n\\n", content)``) so a URL-heavy caller
    splits the content once instead of once per URL; when ``None`` the content
    is split here, preserving standalone callers' behaviour.
    """
    # Find the block of text containing this URL (split by --- or double newlines)
    if blocks is None:
        blocks = re.split(r"\n\n---\n\n|\n\n\n", content)
    for block in blocks:
        if url not in block:
            continue
        url_pos = block.index(url)
        best_title: str | None = None
        best_distance = float("inf")
        for pattern in _TITLE_NEAR_URL_PATTERNS:
            for title_match in pattern.finditer(block):
                title = title_match.group(1).strip()
                if not title or title == url:
                    continue
                # Prefer titles that appear before (and closest to) the URL
                distance = url_pos - title_match.end()
                if distance < 0:
                    # Title appears after the URL — use large penalty
                    distance = abs(distance) + 10000
                if distance < best_distance:
                    best_distance = distance
                    best_title = title
        if best_title:
            return best_title
    return None


def _parse_generic_urls(content: str, tool_name: str) -> list[SourceEntry]:
    """Extract all URLs from any tool output, regardless of format.

    This is the universal fallback. It finds every URL in the content
    and registers it. Works for Tavily XML, paper search markdown,
    plain text with links, or any future source format. Also attempts to
    extract titles from common patterns near each URL.
    """
    seen: set[str] = set()
    entries: list[SourceEntry] = []
    # Split the content into blocks ONCE here (same regex as
    # ``_extract_title_for_url``) so title extraction is O(content) rather than
    # O(urls × content) on URL-heavy tool outputs (e.g. large ris_fetch results).
    blocks = re.split(r"\n\n---\n\n|\n\n\n", content)
    for match in _GENERIC_URL_RE.finditer(content):
        url = unescape(match.group(0)).rstrip(_URL_TRIM_CHARS)
        normalized = _normalize_url(url)
        if normalized not in seen:
            seen.add(normalized)
            title = _extract_title_for_url(content, url, blocks)
            entries.append(SourceEntry(url=url, title=title, source_type="generic", tool_name=tool_name))
    return entries


# Knowledge layer is the only source that needs a specific parser because
# it uses citation keys (e.g., "report.pdf, p.15") instead of URLs.
_KL_CITATION_RE = re.compile(r"^Citation:\s*(.+)$", re.MULTILINE)
_KL_SOURCE_RE = re.compile(r"^Source:\s*(.+)$", re.MULTILINE)
_KL_COLLECTION_RE = re.compile(r"^Collection:\s*(.+)$", re.MULTILINE)
# Machine-readable doc_class field emitted by the knowledge layer's
# `_format_results` (``Dokumentart: <doc_class_key>``). ``Doc-Class:`` is
# accepted as an alias for robustness.
_KL_DOC_CLASS_RE = re.compile(r"^(?:Dokumentart|Doc-Class):\s*(.+)$", re.MULTILINE)

# Per-hit block/body markers, mirroring register.py:_format_results layout: each
# hit is a ``--- Result N ---`` block whose passage body follows the
# ``Relevance Score:`` header line + a blank line, running until the next block
# / the ``## Trace-Lanes`` fan-out summary / end. A very long body is truncated
# with a trailing ``... [truncated]`` marker we strip back off.
_KL_RESULT_BLOCK_RE = re.compile(r"^--- Result \d+ ---[^\S\n]*$", re.MULTILINE)
_KL_RELEVANCE_LINE_RE = re.compile(r"^Relevance Score:.*$", re.MULTILINE)
_KL_TRACE_LANES_MARKER = "## Trace-Lanes"
_KL_TRUNCATED_SUFFIX_RE = re.compile(r"\s*\.\.\.\s*\[truncated\]\s*$")


def _split_kl_result_blocks(content: str) -> list[str]:
    """Split KB tool output into one text span per ``--- Result N ---`` block.

    Each span runs from just after its block marker to the start of the next
    marker (or the ``## Trace-Lanes`` fan-out summary / end of content), so a
    block contains exactly one hit's header fields AND its passage body. The
    leading "Found N relevant document(s):" preamble is not a block and is
    dropped. Returns ``[]`` when the output carries no block markers.
    """
    block_matches = list(_KL_RESULT_BLOCK_RE.finditer(content))
    blocks: list[str] = []
    for idx, block_match in enumerate(block_matches):
        block_start = block_match.end()
        block_end = block_matches[idx + 1].start() if idx + 1 < len(block_matches) else len(content)
        block = content[block_start:block_end]
        # The trailing Trace-Lanes JSON belongs to the whole result set, not to
        # the last hit — cut it off so it can pollute neither the body nor the
        # header-field scan below.
        trace_lanes_at = block.find(_KL_TRACE_LANES_MARKER)
        if trace_lanes_at != -1:
            block = block[:trace_lanes_at]
        blocks.append(block)
    return blocks


def _kl_block_body(block: str) -> str:
    """The retrieved passage body of one result block.

    ``_format_results`` puts the body after the ``Relevance Score:`` header line
    and a blank line. Returns ``""`` when that header is absent (nothing to
    anchor the body to). A very long body is truncated by the producer with a
    trailing ``... [truncated]`` marker, which is stripped back off.
    """
    relevance_match = _KL_RELEVANCE_LINE_RE.search(block)
    if relevance_match is None:
        return ""
    return _KL_TRUNCATED_SUFFIX_RE.sub("", block[relevance_match.end() :].strip()).strip()


def _kl_block_header(block: str) -> str:
    """The HEADER region of one result block — everything above the passage body.

    Header fields must be read from here, never from the whole block, because
    the block also contains RETRIEVED DOCUMENT TEXT. ``_format_results`` omits
    ``Dokumentart:``/``Collection:``/``Page:`` for a hit that has none, so a
    passage whose own text contains such a line would otherwise supply the
    missing field — and a scanned Einreichplan or Bescheid whose title block
    carries a metadata table plausibly does. The result is the same user-visible
    failure as positional misalignment: a private project plan classified as an
    OIB Richtlinie, because ``doc_class`` is first priority in ``lane_for_hit``.

    ``Source:``/``Citation:`` happen to be safe (the header always emits them,
    so the header's own match wins), but scoping the region is what makes that
    true by construction rather than by luck.

    A block with no ``Relevance Score:`` line has no body to confuse us with, so
    the whole block is its header.
    """
    relevance_match = _KL_RELEVANCE_LINE_RE.search(block)
    return block[: relevance_match.start()] if relevance_match else block


def _extract_kl_chunk_bodies(content: str) -> list[str]:
    """Retrieved passage body per ``--- Result N ---`` block, in document order."""
    return [_kl_block_body(block) for block in _split_kl_result_blocks(content)]


def _first(pattern: re.Pattern[str], text: str) -> str | None:
    """First capture of ``pattern`` in ``text``, stripped; ``None`` when absent."""
    match = pattern.search(text)
    return match.group(1).strip() or None if match else None


def _parse_kl_doc_class(raw: str | None) -> str | None:
    """Machine doc_class key from a ``Dokumentart:`` value.

    The line is emitted as ``<doc_class_key> — <German label>``; keep only the
    leading machine key so lane placement gets a valid key.
    """
    if not raw:
        return None
    return raw.split("—")[0].split(" - ")[0].strip() or None


def _kl_entry(
    *,
    citation_key: str,
    title: str | None,
    collection: str | None,
    doc_class: str | None,
    chunk_text: str | None,
    tool_name: str,
) -> SourceEntry:
    """Build a knowledge-layer :class:`SourceEntry` from one hit's fields."""
    return SourceEntry(
        citation_key=citation_key.strip(),
        title=title,
        source_type="knowledge_layer",
        tool_name=tool_name,
        collection=collection or None,
        doc_class=doc_class or None,
        chunk_text=chunk_text or None,
    )


def _parse_knowledge_layer(content: str, tool_name: str) -> list[SourceEntry]:
    """Parse knowledge layer retrieval output.

    Extracts citation keys (filename + page), the retrieval ``Collection:``
    each hit came from (threaded by the KB tool so ``source_lane`` can place
    the hit deterministically), the explicit ``Dokumentart:`` classification,
    and the retrieved passage body. Falls back to generic URL extraction if no
    Citation: fields found.

    Fields are read PER ``--- Result N ---`` BLOCK, never by zipping separate
    whole-document ``findall`` lists. ``_format_results`` emits ``Collection:``
    and ``Dokumentart:`` only when the hit HAS one, so a result set mixing a
    classified hit (OIB corpus) with an unclassified one (a project upload)
    shifts every later value up by one under positional zipping — and because
    ``doc_class`` is the FIRST-priority signal in ``lane_for_hit``, that
    silently rendered a project plan as an OIB Richtlinie. Block-scoped parsing
    makes the association structural rather than coincidental.
    """
    blocks = _split_kl_result_blocks(content)
    entries: list[SourceEntry] = []

    if blocks:
        for block in blocks:
            # Header fields come from the header region ONLY; the rest of the
            # block is retrieved document text and must never be able to supply
            # a field the producer omitted. See ``_kl_block_header``.
            header = _kl_block_header(block)
            citation_key = _first(_KL_CITATION_RE, header)
            if not citation_key:
                # A block without a Citation: field identifies nothing citable.
                continue
            entries.append(
                _kl_entry(
                    citation_key=citation_key,
                    title=_first(_KL_SOURCE_RE, header),
                    collection=_first(_KL_COLLECTION_RE, header),
                    doc_class=_parse_kl_doc_class(_first(_KL_DOC_CLASS_RE, header)),
                    chunk_text=_kl_block_body(block),
                    tool_name=tool_name,
                )
            )
    else:
        # No block markers (a non-``_format_results`` producer whose tool name
        # still matches "knowledge"). Nothing delimits the hits, so fall back to
        # the historical positional pairing rather than dropping the sources.
        citations = _KL_CITATION_RE.findall(content)
        sources = _KL_SOURCE_RE.findall(content)
        collections = _KL_COLLECTION_RE.findall(content)
        doc_classes = _KL_DOC_CLASS_RE.findall(content)
        for i, citation_key in enumerate(citations):
            entries.append(
                _kl_entry(
                    citation_key=citation_key,
                    title=sources[i].strip() if i < len(sources) else None,
                    collection=collections[i].strip() if i < len(collections) else None,
                    doc_class=_parse_kl_doc_class(doc_classes[i] if i < len(doc_classes) else None),
                    chunk_text=None,
                    tool_name=tool_name,
                )
            )

    if not entries:
        return _parse_generic_urls(content, tool_name)
    return entries


# Register knowledge layer as the only special-case parser.
# All other tools (Tavily, paper search, etc.) use the generic URL fallback.
register_source_parser(lambda name: "knowledge" in name, _parse_knowledge_layer)

# ---------------------------------------------------------------------------
# Citation parsing and source-section layout normalization
# ---------------------------------------------------------------------------

# German labels are first-class: reports written in German use "Quellen" &c.,
# and failing to recognize them appended a duplicate English "## Sources"
# section while mangling the original block.
_GERMAN_REFERENCE_HEADING_LABEL_PATTERN = r"(?:Quellen(?:verzeichnis|angaben)?|Literatur(?:verzeichnis)?|Referenzen)"
_REFERENCE_HEADING_LABEL_PATTERN = (
    r"(?:Sources|References|Reference[^\S\n]+List|" + _GERMAN_REFERENCE_HEADING_LABEL_PATTERN + r")"
)
_GERMAN_REFERENCE_HEADING_LABEL_RE = re.compile(
    rf"{_GERMAN_REFERENCE_HEADING_LABEL_PATTERN}[^\S\n]*:?[^\S\n]*\**[^\S\n]*$", re.IGNORECASE
)
_REFERENCE_HEADING_PATTERN = (
    r"^[^\S\n]*(?:"
    rf"#{{1,3}}[^\S\n]+{_REFERENCE_HEADING_LABEL_PATTERN}[^\S\n]*:?"
    rf"|\*\*{_REFERENCE_HEADING_LABEL_PATTERN}:?\*\*"
    rf"|{_REFERENCE_HEADING_LABEL_PATTERN}[^\S\n]*:?"
    r")[^\S\n]*$"
)
_REFERENCE_ENTRY_START_PATTERN = r"(?:[-*][^\S\n]*)?(?:\[\d+\]|\[\^\d+\]:?|\d+[.)])[^\S\n]+"
_REFERENCE_SECTION_RE = re.compile(
    rf"{_REFERENCE_HEADING_PATTERN}(?=\n[^\S\n]*(?:\n[^\S\n]*)*{_REFERENCE_ENTRY_START_PATTERN})",
    re.MULTILINE | re.IGNORECASE,
)
_REFERENCE_HEADING_LINE_RE = re.compile(_REFERENCE_HEADING_PATTERN, re.IGNORECASE)

_CITATION_LINE_RE = re.compile(r"^\s*[-*]?\s*\[(\d+)\]\s*(.+)$", re.MULTILINE)
_ORDERED_REFERENCE_LINE_RE = re.compile(r"^(\s*)(\d+)[.)]\s+(.+)$", re.MULTILINE)
_COLLAPSED_SOURCE_BOUNDARY_RE = re.compile(r"\s+(?=\[(\d+)\]\s+)")
_INLINE_CITATION_RE = re.compile(r"\[(\d+)\]")
_FOOTNOTE_REFERENCE_LINE_RE = re.compile(r"^\s*\[\^(\d+)\]:?\s*", re.MULTILINE)
_FOOTNOTE_INLINE_CITATION_RE = re.compile(r"\[\^(\d+)\]")
_SOURCE_LOCATION_CITATION_RE = re.compile(r"\[(\d+)\s*†[^\]]+\]")

_URL_IN_LINE_RE = re.compile(r"https?://\S+")

# Knowledge-layer citation pattern: "filename.ext" optionally followed by ", p.N" or ", page N"
_KL_CITATION_PATTERN_RE = re.compile(r"^(.+\.\w{2,5})(?:,\s*(?:p\.?|page)\s*\d+)?$", re.IGNORECASE)


# Characters that may appear INSIDE a filename token. Used to require that a
# registry filename found in a reference line stands on its own rather than
# being the tail of a longer name — without this, a registry holding `plan.pdf`
# claims a citation to `bestandsplan.pdf` and the chip opens the wrong document.
_FILENAME_INNER_CHARS = "_-."


def _filename_occurs_as_token(haystack_lower: str, needle_lower: str) -> int | None:
    """Index just past ``needle_lower`` when it occurs as a standalone token.

    Returns ``None`` when the filename only occurs as part of a longer one.
    """
    index = haystack_lower.find(needle_lower)
    while index != -1:
        end = index + len(needle_lower)
        before_ok = index == 0 or not (
            haystack_lower[index - 1].isalnum() or haystack_lower[index - 1] in _FILENAME_INNER_CHARS
        )
        # A trailing "." is allowed (sentence punctuation); a trailing word
        # character would mean we matched a prefix of a longer filename.
        after_ok = end >= len(haystack_lower) or not (haystack_lower[end].isalnum() or haystack_lower[end] in "_-")
        if before_ok and after_ok:
            return end
        index = haystack_lower.find(needle_lower, index + 1)
    return None


def _match_registry_filename(ref_text: str, registry: SourceRegistry) -> str | None:
    """Resolve a reference line to a registered document key, page included.

    Scans the line for any filename the registry actually holds and rebuilds a
    canonical ``filename, p.N`` key from it: the registry's spelling of the
    filename (so it always matches) plus the page THE LINE states (so a document
    retrieved at several pages resolves to the one the answer is citing).

    The longest match wins, so `bestandsplan.pdf` is never resolved to a
    registered `plan.pdf`. ``None`` when the line names no registered document.

    This runs on the RAW line, before any title/parenthetical trimming, because
    those trims are exactly what used to lose the locator: a line written as
    ``OIB-Richtlinie 2 (oib-rl_2.pdf, p.12)`` had its whole locator removed as
    if it were an "(Internal)" annotation, and ``Titel - oib-rl_2.pdf, p.12``
    had the title swallowed into the filename — both dropping a citation to a
    document that was genuinely retrieved.
    """
    lowered = ref_text.lower()
    best_name: str | None = None
    best_end = 0
    for entry in registry._citation_keys:
        entry_file, _ = _parse_citation_key(entry.citation_key or "")
        if not entry_file:
            continue
        end = _filename_occurs_as_token(lowered, entry_file.lower())
        if end is None:
            continue
        if best_name is None or len(entry_file) > len(best_name):
            best_name, best_end = entry_file, end
    if best_name is None:
        return None

    # The page stated immediately after the filename, when there is one.
    page_match = _PAGE_RE.search(ref_text[best_end:])
    return f"{best_name}, p.{page_match.group(1)}" if page_match else best_name


def cited_document_entries(text: str, registry: SourceRegistry) -> list[SourceEntry]:
    """Registry documents the answer's SOURCE SECTION lists, in registry order.

    The document-key counterpart to :meth:`SourceRegistry.has_url`: it answers
    "which of the documents we retrieved does this answer cite?" without needing
    a URL. Matching is the same standalone-token test the citation verifier uses,
    so a registered ``plan.pdf`` is not claimed by a mention of
    ``bestandsplan.pdf``.

    Deep research had no such path — its "cited" signal was URL-only, so a
    knowledge-base source could never be marked cited and was dropped from the
    provenance row the moment any web source WAS cited.

    Only the source section is scanned, NEVER the prose. Citing is a claim the
    answer makes in its source list; a filename appearing in body text is not
    that claim, and may well be the opposite of it ("Ich konnte oib-rl_2.pdf
    nicht abrufen"). This matters because the caller runs on intermediate agent
    output too, where documents are discussed far more often than cited — the
    URL path gets away with the looser rule only because URLs rarely appear in
    prose, while filenames routinely do. No source section means no citation
    claim yet, so nothing is marked. Fail-open: returns an empty list rather
    than raising.
    """
    if not text:
        return []
    section_match = _REFERENCE_SECTION_RE.search(_normalize_citation_syntax(text))
    if section_match is None:
        return []
    lowered = _normalize_citation_syntax(text)[section_match.start() :].lower()
    seen: set[str] = set()
    cited: list[SourceEntry] = []
    for entry in registry._citation_keys:
        entry_file, _ = _parse_citation_key(entry.citation_key or "")
        if not entry_file:
            continue
        key = entry_file.lower()
        if key in seen:
            continue
        if _filename_occurs_as_token(lowered, key) is not None:
            seen.add(key)
            cited.append(entry)
    return cited


def _is_knowledge_citation(ref_text: str, registry: SourceRegistry | None = None) -> tuple[bool, str | None]:
    """Check if reference text looks like a knowledge-layer citation.

    Matching strategy:
    1. If a registry is provided, resolve the line against the documents that
       were actually retrieved (:func:`_match_registry_filename`). This is both
       the most reliable signal and the most forgiving of LLM formatting, so it
       runs first.
    2. Otherwise fall back to the shape test (``filename.ext, p.N``) after
       trimming a trailing parenthetical and markdown emphasis.

    Returns (is_kl, citation_key_or_none).
    """
    # Strip markdown bold/italic markers only (*, **) — preserve underscores in
    # filenames. Done before the registry scan so `**file.pdf**` still matches.
    unemphasized = re.sub(r"\*+", "", ref_text).strip()

    if registry is not None:
        matched = _match_registry_filename(unemphasized, registry)
        if matched:
            return True, matched

    # Strip trailing "(Internal)" or similar parenthetical
    cleaned = re.sub(r"\s*\(.*?\)\s*$", "", unemphasized).strip()
    # Remove leading "Title - " or "Title: " prefix by taking last segment
    # if it contains a filename pattern
    for segment in [cleaned, cleaned.split(" - ")[-1].strip(), cleaned.split(": ")[-1].strip()]:
        if _KL_CITATION_PATTERN_RE.match(segment):
            return True, segment

    return False, None


# Austrian RIS (Rechtsinformationssystem) sources arrive via the generic URL
# parser, so they share ``source_type == "generic"`` with ordinary web hits.
# They stay cleanly identifiable through the RIS tool names (``ris_search_tool``
# / ``ris_fetch_tool``, and the ``ris_*`` names the prompts reference) and the
# official RIS host — either signal is enough to label them as the authoritative
# legal source rather than generic web.
_RIS_URL_HOST_RE = re.compile(r"^\s*https?://(?:[\w-]+\.)*ris\.bka\.gv\.at\b", re.IGNORECASE)


def _is_ris_source(entry: SourceEntry) -> bool:
    """Return true when a source originates from the Austrian RIS."""
    name = (entry.tool_name or "").lower()
    if name.startswith("ris_") or "ris_search" in name or "ris_fetch" in name:
        return True
    return bool(entry.url and _RIS_URL_HOST_RE.match(entry.url))


def source_lane(entry: SourceEntry, registry: NormRegistry | None = None) -> tuple[str, str]:
    """(stratum_key, German label) for the research fan-out UI's source grouping.

    Deterministic display tagging on top of ``source_origin_token``'s coarse
    origin: Baurecht lanes split by registry rank (RIS) or OIB filename class
    (knowledge base), Projektwissen/Büroarchiv by collection prefix, Web
    otherwise — see ``norm_registry.lane_for_hit``. The wire tokens
    (``[KB]``/``[RIS]``/``[Web]``) are unchanged; the fan-out UI reads this
    richer label from the structured source payloads instead.
    """
    from aiq_agent.common.norm_registry import lane_for_hit
    from aiq_agent.common.norm_registry import load_registry

    file_name = None
    if entry.citation_key:
        file_name, _ = _parse_citation_key(entry.citation_key)
    # ``registry`` may be supplied by the caller (so a single ``load_registry()``
    # serves several helpers per entry); when absent, load it exactly as before —
    # only for RIS URLs, so non-RIS entries still skip the load entirely.
    if registry is None:
        registry = load_registry() if (entry.url and "ris.bka.gv.at" in entry.url) else None
    lane = lane_for_hit(
        doc_class=entry.doc_class,
        file_name=file_name,
        source_url=entry.url,
        collection=entry.collection,
        registry=registry,
    )
    if lane == ("web", "Web") and entry.source_type == "knowledge_layer":
        # A knowledge-base hit without collection metadata (output produced
        # before the `Collection:` field was threaded) is project/org
        # material — the capture path carries the collection now, so this is
        # only the legacy fallback.
        return ("projekt", "Projektwissen")
    return lane


def binding_note_for_entry(entry: SourceEntry, registry: NormRegistry | None = None) -> str | None:
    """Prose bindingness note for a source, when the norm registry catalogues one.

    For a RIS source whose URL carries a catalogued ``document_number``, return
    the matching registry entry's ``binding_note`` (e.g. how the WBTV makes the
    OIB Richtlinien binding in Wien) — the highest-value "does this actually bind
    me?" fact for the citation popover. ``None`` when the source is not RIS or
    the matched entry carries no note. Fail-open: never raises.
    """
    if not (entry.url and "ris.bka.gv.at" in entry.url):
        return None
    try:
        from aiq_agent.common.norm_registry import load_registry

        # Reuse a caller-supplied registry when present; otherwise load it as
        # before. The load stays inside the fail-open guard.
        if registry is None:
            registry = load_registry()
        for norm in registry.entries:
            if norm.document_number and norm.document_number in entry.url and norm.binding_note:
                return norm.binding_note
    except Exception:  # registry unavailable/invalid — bindingness is best-effort
        return None
    return None


def source_label(entry: SourceEntry) -> str | None:
    """Stable identity of a captured source for the citation-health ledger.

    The document key or URL — an identifier, never the retrieved passage — so
    the platform export can name WHICH source was in play without carrying any
    answer or corpus prose across tenants. ``None`` when the entry has neither
    (a bare tool-result source, which identifies nothing citable).
    """
    return entry.citation_key or entry.url or None


def source_origin_token(entry: SourceEntry) -> str:
    """Return a stable leading origin token for a source line.

    Deterministic backend output (never LLM-generated): ``[KB]`` for the
    trusted OIB knowledge base, ``[RIS]`` for the official Austrian legal
    information system, ``[Web]`` for URL-bearing web sources. Returns an empty
    string when the origin is not cleanly identifiable, so callers emit no token
    and the frontend falls open to plain, unlabeled text.
    """
    if entry.source_type == "knowledge_layer":
        return "[KB]"
    if _is_ris_source(entry):
        return "[RIS]"
    if entry.url:
        return "[Web]"
    return ""


def source_entry_to_wire(entry: SourceEntry, *, number: int | None = None) -> dict[str, Any]:
    """Serialize a :class:`SourceEntry` for the citation wire (SSE / WS).

    The frontend opens document previews from structured ``file_name`` /
    ``page`` / ``collection`` fields rather than inventing filenames from free
    text. ``content`` still carries a human-readable line (optional leading
    origin token + citation key or title) for legacy parsers and chip labels.

    ``number`` is the citation's ``[N]`` label in the verified answer — the one
    fact the frontend cannot recover on its own, because the ``[N]``→source
    binding lives in ``verify_citations``' ``valid_citations`` and nowhere else.
    Carrying it lets the UI render ONE provenance block (numbered, colored,
    clickable) instead of the LLM-written "## Sources" list AND a chip row that
    each hold half the truth. Omitted when unknown, so every existing caller and
    every persisted message keeps working unchanged.
    """
    origin_token = source_origin_token(entry)
    origin = origin_token.strip("[]").lower() if origin_token else None

    file_name: str | None = None
    page: int | None = None
    if entry.citation_key:
        parsed_name, page = _parse_citation_key(entry.citation_key)
        # Only surface filenames that look like documents (extension present).
        if parsed_name and "." in parsed_name.rsplit("/", 1)[-1]:
            file_name = parsed_name

    label = entry.citation_key or entry.title or entry.url or entry.tool_name or ""
    content = f"{origin_token} {label}".strip() if origin_token else label

    # Canonical source-kind: the coarse taxonomy every surface renders through
    # (chips, Herleitung fan-out, report). Derived from the rich lane
    # classification so the OIB corpus and RIS share the same ``baurecht`` kind;
    # the fine lane travels alongside as a sub-label. See ``source_kinds``.
    # The norm registry is static within a turn; load it at most once here
    # (only for RIS entries, mirroring both helpers' guard) and hand the same
    # instance to source_lane and binding_note_for_entry so neither reloads it.
    from aiq_agent.common.norm_registry import load_registry

    registry = load_registry() if (entry.url and "ris.bka.gv.at" in entry.url) else None
    lane_key, lane_label = source_lane(entry, registry)
    kind = kind_for_lane(lane_key)

    payload: dict[str, Any] = {
        # The [N] marker this source carries in the answer prose (when known).
        "number": number,
        "content": content,
        "title": entry.title or file_name,
        "citation_key": entry.citation_key,
        "collection": entry.collection,
        "source_type": entry.source_type or None,
        "tool": entry.tool_name or None,
        "url": entry.url,
        "origin": origin,
        "kind": kind,
        "lane": lane_key,
        "lane_label": lane_label,
        # Bindingness fact for the popover ("does this bind me?") — only present
        # for RIS sources the norm registry catalogues with a binding_note.
        "binding_note": binding_note_for_entry(entry, registry),
        "file_name": file_name,
        "page": page,
    }
    return {key: value for key, value in payload.items() if value is not None}


# A leading origin token on the post-``[N]`` text of a source line, e.g. the
# ``[KB]`` in ``- [1] [KB] file.pdf, p.3``. Kept in sync with
# ``source_origin_token`` and the frontend ``SOURCE_KIND_TOKEN_RE`` parser.
# Used to (a) make token injection idempotent and (b) strip a pre-existing
# token before registry identity-matching so it never pollutes the fuzzy
# filename comparison in ``_is_knowledge_citation`` / ``has_citation_key``.
_ORIGIN_TOKEN_RE = re.compile(r"^(\[(?:KB|RIS|Web)\])\s*", re.IGNORECASE)


def _inject_origin_token(line: str, token: str) -> str:
    """Insert ``token`` immediately after the ``[N]`` marker of a source line.

    The token must sit AFTER the number (``- [1] [KB] file.pdf``) so it does
    not break ``_CITATION_LINE_RE`` parsing or the ``[N]`` renumbering in
    ``sanitize_report``. Idempotent: a line already carrying a recognized
    origin token is returned unchanged.
    """
    line_match = _CITATION_LINE_RE.match(line)
    if line_match is None:
        return line
    ref_text = line_match.group(2)
    if _ORIGIN_TOKEN_RE.match(ref_text):
        return line
    prefix = line[: line_match.start(2)]
    return f"{prefix}{token} {ref_text}"


def _format_registry_reference(num: int, entry: SourceEntry) -> str | None:
    """Render a registered source as a source-section line."""
    title = entry.title or entry.tool_name or entry.source_type or "Source"
    token = source_origin_token(entry)
    prefix = f"{token} " if token else ""
    if entry.url:
        return f"[{num}] {prefix}{title}: {entry.url}"
    if entry.citation_key:
        return f"[{num}] {prefix}{entry.citation_key}"
    return None


def _normalize_citation_syntax(report_text: str) -> str:
    """Normalize citation bracket variants before verification/sanitization."""
    report_text = report_text.replace("【", "[").replace("】", "]")
    report_text = _SOURCE_LOCATION_CITATION_RE.sub(r"[\1]", report_text)
    report_text = _FOOTNOTE_REFERENCE_LINE_RE.sub(r"[\1] ", report_text)
    return _FOOTNOTE_INLINE_CITATION_RE.sub(r"[\1]", report_text)


def _normalize_ordered_reference_lines(ref_section: str) -> str:
    """Convert ordered-list source lines to canonical [N] form."""
    return _ORDERED_REFERENCE_LINE_RE.sub(r"\1[\2] \3", ref_section)


def _reference_segment_has_target(segment: str) -> bool:
    """Return true when a source segment already contains a verifiable target."""
    line_match = _CITATION_LINE_RE.match(segment)
    if line_match is None:
        return False

    ref_text = line_match.group(2).strip()
    if _URL_IN_LINE_RE.search(ref_text):
        return True

    cleaned = re.sub(r"\*+", "", ref_text).strip()
    return bool(_KL_CITATION_PATTERN_RE.match(cleaned))


def _split_collapsed_source_line(line: str) -> str:
    """Split only truly collapsed source entries on one line.

    Avoid splitting bracketed numbers that are part of a title, such as
    ``[1] Semiconductor outlook [2024] update: https://...``.
    """
    first_line_match = _CITATION_LINE_RE.match(line)
    if first_line_match is None:
        return line

    current_num = int(first_line_match.group(1))
    segment_start = 0
    segments: list[str] = []
    for boundary_match in _COLLAPSED_SOURCE_BOUNDARY_RE.finditer(line):
        next_num = int(boundary_match.group(1))
        current_segment = line[segment_start : boundary_match.start()]
        if next_num <= current_num or next_num >= 1000 or not _reference_segment_has_target(current_segment):
            continue

        segments.append(current_segment.rstrip())
        segment_start = boundary_match.end()
        current_num = next_num

    if not segments:
        return line

    segments.append(line[segment_start:].lstrip())
    return "\n".join(segments)


def _normalize_source_section_layout(ref_section: str) -> str:
    """Normalize source-section presentation before parsing or final cleanup.

    This is report hygiene, not source-identity verification. ``verify_citations``
    calls it only so common writer variants are parseable; ``sanitize_report``
    owns the final display normalization.
    """
    ref_section = _normalize_ordered_reference_lines(ref_section)
    lines = ref_section.split("\n")
    if lines and _REFERENCE_HEADING_LINE_RE.match(lines[0]):
        # Keep German reports German: a "Quellen"-style heading is normalized
        # to "## Quellen" instead of being anglicized to "## Sources". The
        # canonical label is chosen from the label the writer used, which is
        # correct as long as the writer's label follows the answer's language —
        # the prompt requires exactly that (see researcher.j2 <output_contract>).
        lines[0] = "## Quellen" if _GERMAN_REFERENCE_HEADING_LABEL_RE.search(lines[0]) else "## Sources"
        ref_section = "\n".join(lines)
    return "\n".join(_split_collapsed_source_line(line) for line in ref_section.split("\n"))


def _inline_citation_numbers(text: str) -> set[int]:
    """Return numeric inline citation labels present in text."""
    return {int(match.group(1)) for match in _INLINE_CITATION_RE.finditer(text)}


def _strip_inline_citations_not_in(text: str, valid_numbers: set[int]) -> str:
    """Remove inline citations whose labels are not in valid_numbers."""
    return _INLINE_CITATION_RE.sub(
        lambda match: match.group(0) if int(match.group(1)) in valid_numbers else "",
        text,
    )


def _renumber_citations(body: str, ref_section: str) -> tuple[str, str, dict[int, int]]:
    """Renumber [N] citations sequentially, closing any gaps.

    Scans the source section for citation numbers, builds a mapping
    from old to new sequential numbers, and applies it to both body and
    source lines via collision-safe placeholders.

    Returns:
        (body, ref_section, renumber_map) where renumber_map maps every
        old citation number to its new sequential number.
    """
    remaining = sorted(int(m.group(1)) for m in _CITATION_LINE_RE.finditer(ref_section))
    renumber_map: dict[int, int] = {old: new for new, old in enumerate(remaining, 1)}

    # Nothing to do if already sequential
    if all(old == new for old, new in renumber_map.items()):
        return body, ref_section, renumber_map

    # Apply renumbering via placeholders (descending order avoids [1] matching inside [10])
    for old_num in sorted(renumber_map, reverse=True):
        new_num = renumber_map[old_num]
        if old_num != new_num:
            placeholder = f"__CITE_{new_num}__"
            body = body.replace(f"[{old_num}]", placeholder)
            ref_section = ref_section.replace(f"[{old_num}]", placeholder)

    for new_num in sorted(renumber_map.values()):
        placeholder = f"__CITE_{new_num}__"
        body = body.replace(placeholder, f"[{new_num}]")
        ref_section = ref_section.replace(placeholder, f"[{new_num}]")

    return body, ref_section, renumber_map


# ---------------------------------------------------------------------------
# Quote verification (deterministic, fail-open)
# ---------------------------------------------------------------------------
#
# The weak model (DeepSeek) reliably cites a REAL legal section but sometimes
# FABRICATES the sentence it puts in quotation marks. Citation verification
# above only checks the *identity* of a source; it cannot tell whether a quoted
# span is actually present in the retrieved passage. This layer closes that gap:
# after the model answers, every QUOTED span is checked (fuzzily) against the
# chunk text of ANY knowledge-layer source in the registry (whole-registry
# match, per ADR decision — simpler than per-citation and catches the reported
# bug). A span that matches nothing is annotated INLINE and never altered
# (fail-open): the sentence stays, a short marker is appended after it, and the
# answer's confidence is capped to "low".

# Fuzzy-match threshold: a quoted span counts as "verified" when at least this
# fraction of it is found (as ordered matching subsequences) in some source's
# chunk text. 0.90 tolerates minor OCR/whitespace/hyphenation noise while still
# rejecting a wholesale fabrication. TUNABLE — see module note; wants calibration
# against real transcripts (cannot be tuned live here).
QUOTE_MATCH_THRESHOLD = 0.90

# Minimum length (characters, on the normalized quote) a span must reach before
# it is verified. Short spans ("§ 3", "OIB", a bare term) are too common and too
# generic to fuzzy-match reliably and are skipped. TUNABLE — see module note.
MIN_QUOTE_LEN = 20

# Minimum padding (characters) added around a candidate match window so a genuine
# verbatim quote whose length drifted under OCR (inserted/removed chars) still
# fits inside the window. Kept small on purpose: a large pad would re-admit the
# scattered-splice fragments the locality window is meant to exclude. The window
# length is ``len(quote) + max(_QUOTE_WINDOW_PAD_MIN, len(quote) // 10)``.
_QUOTE_WINDOW_PAD_MIN = 4

# Absolute budget (characters) for the CHUNK text a verified quote may skip over,
# accumulated across the matched region. This is the non-contiguity penalty that
# separates a lightly-noisy verbatim quote from a splice of two real clauses:
#
# - OCR/whitespace/hyphenation/„…"-mark noise perturbs the alignment by only a
#   char or two at a time (a substitution advances the quote and the chunk by the
#   same amount, so its NET elided chunk text is ~0), keeping the cumulative total
#   well under budget → the quote stays verified.
# - A splice that merges two adjacent clauses (dropping a connective and the
#   material between them, e.g. "…Kosten [der Massnahme. Der] Nachbar…") leaves a
#   run of chunk text with no counterpart in the quote; its NET elided total
#   (≳10 chars even when coincidental re-matches fragment it into pieces) exceeds
#   the budget, splitting the matched region so no single contiguous-enough run
#   reaches the threshold → the quote is flagged.
#
# An ABSOLUTE constant (not ``len(quote)//k``) is essential: the defeat in the
# prior metric was that every tolerance scaled with the quote, so a longer quote
# bought a proportionally larger elision. 6 is chosen empirically — noisy
# verbatim fixtures net ≤4 elided chars, clause splices net ≥7. TUNABLE.
_QUOTE_MAX_ELIDED_GAP = 6

# Inline marker appended immediately after a quoted span that could not be
# verified against any retrieved passage. Fail-open: the sentence is NEVER
# stripped or altered; only this marker is inserted after the closing quote.
UNVERIFIED_QUOTE_MARKER = "[nicht wörtlich in der Quelle belegt]"

# Quoted-span matcher: German „…“ (also lenient „…”), guillemets »…«, curly
# “…”, and plain ASCII "…". Each alternative captures the inner text in its own
# group; the first non-None group of a match is the quote. German „…“ is tried
# before the curly “…” form so the shared U+201C is read as a German closing
# mark when it opened with „. Inner text may not contain the relevant quote
# characters, so quotes do not run across sentence boundaries.
_QUOTED_SPAN_RE = re.compile(
    r"„([^„“”\"]+)[“”\"]"  # German low-9 opening; closing „…“/„…”/„…" (models mix them)
    r"|»([^»«]+)«"  # guillemets
    r"|“([^“”]+)”"  # curly double
    r"|\"([^\"]+)\""  # ASCII straight
)

# Quote marks stripped from the edges of a normalized span before matching.
_QUOTE_EDGE_CHARS = "„“”»«\"'‚‘’ "


@dataclass
class UnverifiedQuote:
    """A quoted span in the answer body that no source chunk text supports."""

    # Inner quoted text, exactly as it appeared in the answer (no quote marks).
    quote: str
    # The full matched span INCLUDING its quote marks (used for logging/tests).
    span: str
    # Character offsets of the span within the scanned answer text, so the
    # annotation can be inserted immediately after the closing quote mark.
    start: int
    end: int
    # Best coverage achieved against any source chunk text (0.0–1.0). Below
    # ``QUOTE_MATCH_THRESHOLD`` by construction; retained for diagnostics.
    best_coverage: float


def _normalize_for_quote_match(text: str) -> str:
    """Normalize a quote or chunk body for fuzzy comparison.

    Applies (in order): Unicode NFKC; join hyphenated line-wraps (``Bau-\\nordnung``
    → ``Bauordnung``); strip leading blockquote ``> `` markers; collapse all
    whitespace to single spaces; strip surrounding quote marks; ``casefold()``.
    Both the quoted span and each source chunk text pass through this so the
    comparison ignores formatting, OCR line-wrapping and casing differences.
    """
    text = unicodedata.normalize("NFKC", text)
    # Join hyphenated line-wraps before whitespace is collapsed.
    text = re.sub(r"-\n", "", text)
    # Strip leading Markdown blockquote markers.
    text = re.sub(r"(?m)^[ \t]*>[ \t]?", "", text)
    # Collapse whitespace.
    text = re.sub(r"\s+", " ", text).strip()
    # Strip surrounding quote marks.
    text = text.strip(_QUOTE_EDGE_CHARS)
    return text.casefold()


def _quote_coverage(norm_quote: str, norm_chunk: str) -> float:
    """Fraction of ``norm_quote`` covered by a CONTIGUOUS-enough run of the chunk.

    Two earlier metrics were both defeatable:

    - A whole-chunk subsequence match (sum of every matching block, anywhere in
      the chunk) scored a phrase-splice — real fragments pulled from DIFFERENT
      clauses — at 1.0 even though the quote is not a substring.
    - Restricting the sum to a single window sized to the quote length still let
      an ADJACENT-clause splice through: when the quote merges two neighbouring
      sentences (dropping a short connective), the whole spliced span is about as
      long as the quote, so it fits one window and the summed blocks stay above
      threshold — even though the quote skipped over real chunk text in between.

    The fix penalizes NON-CONTIGUITY directly. Within each candidate window we
    walk the matching blocks in order and accumulate the NET chunk text the quote
    skips between consecutive blocks (``chunk_gap - quote_gap``, floored at 0 so a
    same-length substitution — the shape of OCR/casing noise — costs ~nothing).
    Once that cumulative elision exceeds an ABSOLUTE budget
    (``_QUOTE_MAX_ELIDED_GAP``) the region is cut and a fresh run begins; the
    score is the longest single run divided by ``len(quote)``.

    - A genuine verbatim quote is one uninterrupted run → ~1.0. Light
      OCR/whitespace/hyphenation/„…"-mark noise perturbs the alignment by only a
      char or two at a time and nets far under budget, so it too scores ~1.0.
    - A splice — adjacent OR scattered, short gap OR long — leaves an elided run
      of chunk text with no quote counterpart; the budget is exceeded, the region
      is split, and no surviving run reaches the threshold → low score.

    The budget is a fixed constant rather than a fraction of the quote, so a
    longer quote can no longer buy a proportionally larger silent elision.
    Candidate windows are anchored at the diagonals of the matching blocks
    (window start = ``block.b - block.a``), so only a handful are scored per
    quote×chunk. Pure stdlib (``difflib``), fail-open, and cheap.
    """
    quote_len = len(norm_quote)
    if quote_len == 0:
        return 0.0
    pad = max(_QUOTE_WINDOW_PAD_MIN, quote_len // 10)
    window_len = quote_len + pad
    base = difflib.SequenceMatcher(None, norm_quote, norm_chunk, autojunk=False)
    # Anchor one window per matching-block diagonal; dedup collapses blocks that
    # share an alignment offset. Empty when nothing matches at all → coverage 0.
    window_starts = {max(0, block.b - block.a) for block in base.get_matching_blocks() if block.size}
    if not window_starts:
        return 0.0
    best = 0.0
    for start in window_starts:
        window = norm_chunk[max(0, start - pad) : start + window_len]
        matcher = difflib.SequenceMatcher(None, norm_quote, window, autojunk=False)
        # Longest run of matching blocks whose cumulative net elided chunk text
        # stays within budget. A block gap that skips real chunk text the quote
        # never covers pushes the running elision up; crossing the budget cuts the
        # run so a spliced-together quote cannot bank credit across the elision.
        run = 0
        best_run = 0
        elided = 0
        prev_a_end: int | None = None
        prev_b_end: int | None = None
        for block in matcher.get_matching_blocks():
            if not block.size:
                continue
            if prev_b_end is not None:
                chunk_gap = block.b - prev_b_end
                quote_gap = block.a - prev_a_end
                elided += max(0, chunk_gap - quote_gap)
                if elided > _QUOTE_MAX_ELIDED_GAP:
                    run = 0
                    elided = 0
            run += block.size
            best_run = max(best_run, run)
            prev_a_end = block.a + block.size
            prev_b_end = block.b + block.size
        best = max(best, best_run / quote_len)
    return best


def _answer_body_before_sources(answer_text: str) -> str:
    """Return the answer prose before the ``## Sources``/references section.

    Quote scanning must not touch the source section (source lines legitimately
    quote titles/URLs). Falls back to the whole text when no section is present.
    Positions in the returned prefix are valid offsets into ``answer_text``
    because it is a leading substring.
    """
    ref_match = _REFERENCE_SECTION_RE.search(answer_text)
    return answer_text[: ref_match.start()] if ref_match else answer_text


def verify_quoted_spans(
    answer_text: str,
    registry: SourceRegistry,
    *,
    threshold: float = QUOTE_MATCH_THRESHOLD,
    min_quote_len: int = MIN_QUOTE_LEN,
) -> list[UnverifiedQuote]:
    """Return the quoted spans in the answer body not supported by any chunk text.

    Whole-registry match: a span is "verified" when its normalized form is
    fuzzily present (coverage ≥ ``threshold``) in the normalized chunk text of
    ANY knowledge-layer source in the registry. Spans shorter than
    ``min_quote_len`` (normalized) are skipped. Only the answer BODY is scanned
    (never the source section). Fail-open: when no source carries chunk text
    (e.g. URL-only web sources), there is nothing to verify against and an empty
    list is returned — nothing is ever flagged on a best-effort miss.
    """
    normalized_chunks = [
        norm
        for source in registry.all_sources()
        if source.chunk_text
        if (norm := _normalize_for_quote_match(source.chunk_text))
    ]
    if not normalized_chunks:
        return []

    body = _answer_body_before_sources(answer_text)
    unverified: list[UnverifiedQuote] = []
    for match in _QUOTED_SPAN_RE.finditer(body):
        inner = next((group for group in match.groups() if group is not None), None)
        if inner is None:
            continue
        norm_quote = _normalize_for_quote_match(inner)
        if len(norm_quote) < min_quote_len:
            continue
        best_coverage = max(_quote_coverage(norm_quote, chunk) for chunk in normalized_chunks)
        if best_coverage < threshold:
            unverified.append(
                UnverifiedQuote(
                    quote=inner,
                    span=match.group(0),
                    start=match.start(),
                    end=match.end(),
                    best_coverage=best_coverage,
                )
            )
    return unverified


def annotate_unverified_quotes(answer_text: str, unverified: Sequence[UnverifiedQuote]) -> str:
    """Insert ``UNVERIFIED_QUOTE_MARKER`` immediately after each unverified span.

    Fail-open and non-destructive: the quoted sentence is never stripped or
    altered — the marker is inserted after the closing quote mark. Offsets come
    from ``verify_quoted_spans`` on the SAME ``answer_text``; insertions run
    right-to-left so earlier offsets stay valid. Idempotent: a span already
    followed by the marker is left untouched.
    """
    if not unverified:
        return answer_text
    result = answer_text
    for uq in sorted(unverified, key=lambda item: item.end, reverse=True):
        insert_at = uq.end
        if result[insert_at:].lstrip().startswith(UNVERIFIED_QUOTE_MARKER):
            continue
        result = f"{result[:insert_at]} {UNVERIFIED_QUOTE_MARKER}{result[insert_at:]}"
    return result


def verify_citations(
    report_text: str,
    registry: SourceRegistry,
    *,
    reference_sources: Sequence[SourceEntry] | None = None,
) -> CitationVerificationResult:
    """Verify cited source identities against the captured source registry.

    This function decides whether each cited source line maps to a real captured
    URL or citation key. It may normalize source-section layout enough to parse
    common writer variants, but final Markdown hygiene belongs to
    ``sanitize_report``.

    Algorithm:
    1. Find the source section
    2. Parse each [N] source line
    3. Validate URL or citation_key against registry
    4. Remove invalid source lines and orphaned inline citations

    Renumbering is NOT done here — it is deferred to sanitize_report()
    which always runs after this function and handles it in a single pass.

    Args:
        report_text: The full report text with citations.
        registry: SourceRegistry populated from tool call results.
        reference_sources: Optional writer-facing source list, in the same
            numbering order the writer saw. Used only to synthesize a missing
            source section.

    Returns:
        CitationVerificationResult with cleaned report and audit trail.
    """
    # Normalize citation syntax variants before validation.
    report_text = _normalize_citation_syntax(report_text)

    # Early exit: nothing to validate against
    all_sources = registry.all_sources()
    if not all_sources:
        logger.debug("[CitationVerify] Skipping — registry is empty (no tool calls captured)")
        return CitationVerificationResult(verified_report=report_text)

    logger.info(
        "[CitationVerify] Starting verification against %d registered source(s)",
        len(all_sources),
    )
    logger.debug(
        "[CitationVerify] Registered URLs: %s",
        [s.url for s in all_sources if s.url],
    )

    # Find source section
    ref_match = _REFERENCE_SECTION_RE.search(report_text)
    if not ref_match:
        if not _INLINE_CITATION_RE.search(report_text):
            logger.warning("[CitationVerify] No source section found in report; skipping")
            return CitationVerificationResult(verified_report=report_text)

        if reference_sources is None:
            logger.warning(
                "[CitationVerify] No source section found; cannot safely synthesize sources "
                "without the writer-facing source list"
            )
            return CitationVerificationResult(verified_report=report_text)

        writer_sources = list(reference_sources)
        cited_numbers = sorted(_inline_citation_numbers(report_text))
        reference_lines = [
            line
            for i in cited_numbers
            if 1 <= i <= len(writer_sources)
            if (line := _format_registry_reference(i, writer_sources[i - 1]))
        ]
        if not reference_lines:
            logger.warning("[CitationVerify] No source section found and no renderable writer-facing sources")
            return CitationVerificationResult(verified_report=_strip_inline_citations_not_in(report_text, set()))

        logger.warning(
            "[CitationVerify] No source section found; appending %d inline-cited registered source(s)",
            len(reference_lines),
        )
        report_text = report_text.rstrip() + "\n\n## Sources\n" + "\n".join(reference_lines)
        ref_match = _REFERENCE_SECTION_RE.search(report_text)
        if ref_match is None:
            return CitationVerificationResult(verified_report=report_text)

    ref_start = ref_match.start()
    body = report_text[:ref_start]
    original_ref_section = report_text[ref_start:]
    ref_section = _normalize_source_section_layout(original_ref_section)

    # Parse citation lines in the source section
    valid_citations: list[dict] = []
    removed_citations: list[dict] = []
    url_replacements: dict[str, str] = {}  # garbled_url -> canonical_url
    # Origin token per validated citation number, e.g. {1: "[Web]", 3: "[KB]"}.
    # Applied AFTER the [N] marker in the cleaned_ref_lines pass so the
    # LLM-written source section gains the same deterministic labels the
    # fallback-synthesized and shallow-chat paths already carry. Lines that
    # already start with a token are left as-is (idempotent).
    origin_tokens: dict[int, str] = {}

    for line_match in _CITATION_LINE_RE.finditer(ref_section):
        num = int(line_match.group(1))
        ref_text = line_match.group(2).strip()
        full_line = line_match.group(0)

        # Strip any pre-existing origin token before identity matching so it
        # never leaks into fuzzy filename comparison (``[KB] file.pdf`` must
        # still resolve to ``file.pdf``). ``already_tokenized`` suppresses
        # re-injection so replayed/synthesized lines are not double-prefixed.
        token_match = _ORIGIN_TOKEN_RE.match(ref_text)
        already_tokenized = token_match is not None
        match_text = ref_text[token_match.end() :] if token_match else ref_text

        # Try URL match first
        url_match = _URL_IN_LINE_RE.search(match_text)
        if url_match:
            url = url_match.group(0).rstrip(_URL_TRIM_CHARS)
            canonical = registry.resolve_url(url)
            if canonical:
                if canonical != url:
                    logger.debug("[CitationVerify]   [%d] VALID  — %s (repaired from: %s)", num, canonical, url)
                    url_replacements[url] = canonical
                else:
                    logger.debug("[CitationVerify]   [%d] VALID  — %s", num, url)
                valid_citations.append({"number": num, "url": canonical, "citation_key": None, "line": full_line})
                if not already_tokenized and (entry := registry.entry_for_url(canonical)):
                    if token := source_origin_token(entry):
                        origin_tokens[num] = token
            else:
                logger.info("[CitationVerify]   [%d] REMOVE — url_not_in_registry: %s", num, url)
                removed_citations.append({"number": num, "line": full_line, "reason": "url_not_in_registry"})
            continue

        # Try knowledge-layer citation key (lenient — passes registry for fuzzy filename match)
        is_kl, citation_key = _is_knowledge_citation(match_text, registry)
        if is_kl and citation_key:
            if registry.has_citation_key(citation_key):
                logger.debug("[CitationVerify]   [%d] VALID  — %s", num, citation_key)
                valid_citations.append({"number": num, "url": None, "citation_key": citation_key, "line": full_line})
                if not already_tokenized and (entry := registry.entry_for_citation_key(citation_key)):
                    if token := source_origin_token(entry):
                        origin_tokens[num] = token
            else:
                logger.debug("[CitationVerify]   [%d] REMOVE — citation_key_not_in_registry: %s", num, citation_key)
                removed_citations.append({"number": num, "line": full_line, "reason": "citation_key_not_in_registry"})
            continue

        # Neither URL nor recognizable citation key
        logger.debug("[CitationVerify]   [%d] REMOVE — unverifiable: %s", num, ref_text[:80])
        removed_citations.append({"number": num, "line": full_line, "reason": "unverifiable"})

    # Dedup: collapse multiple [N] source lines that resolve to the same
    # registry source. The model often makes the same tool call twice (e.g.
    # ``mcp_time__get_current_time`` for two timezones) and emits a separate
    # ``[N] tool_name`` line for each call; without this pass both lines
    # survive verification because each is independently valid. We keep the
    # lowest-numbered occurrence and rewrite later inline citations to that
    # number so the prose still cites the source.
    seen_keys: dict[str, int] = {}  # canonical_key -> kept citation number
    duplicate_rewrites: dict[int, int] = {}  # duplicate_num -> canonical_num
    deduped_valid: list[dict] = []
    for c in valid_citations:
        key = c["url"] or c["citation_key"]
        if key is None:
            # Defensive: a valid citation must have one of url/citation_key.
            # If neither is set we cannot dedup, so keep the entry.
            deduped_valid.append(c)
            continue
        canonical_num = seen_keys.get(key)
        if canonical_num is None:
            seen_keys[key] = c["number"]
            deduped_valid.append(c)
            continue
        duplicate_rewrites[c["number"]] = canonical_num
        removed_citations.append(
            {
                "number": c["number"],
                "line": c["line"],
                "reason": f"duplicate_of_citation_{canonical_num}",
            }
        )
        logger.debug(
            "[CitationVerify]   [%d] REMOVE — duplicate of [%d]: %s",
            c["number"],
            canonical_num,
            key,
        )
    valid_citations = deduped_valid

    # Apply URL replacements (garbled -> canonical) in the source section.
    # Bounded match: a plain str.replace would also rewrite a *different*
    # reference whose URL merely starts with the garbled one (e.g. ?id=1
    # vs ?id=10), corrupting a valid citation into a dead link.
    if url_replacements:
        for garbled, canonical in url_replacements.items():
            ref_section = re.sub(
                re.escape(garbled) + r"(?![\w\-./?=&%#~+])",
                lambda _m, url=canonical: url,
                ref_section,
            )

    removed_numbers = {c["number"] for c in removed_citations}

    # Remove invalid (and duplicate) source lines from the source section, and
    # inject the origin token (``[KB]``/``[RIS]``/``[Web]``) after the ``[N]``
    # marker of each kept, validated line. Injection is idempotent and only
    # touches numbers recorded during the parse loop, so url-repair and dedup
    # above are undisturbed.
    cleaned_ref_lines: list[str] = []
    for line in ref_section.split("\n"):
        line_match = _CITATION_LINE_RE.match(line)
        if line_match:
            num = int(line_match.group(1))
            if num in removed_numbers:
                continue
            if (token := origin_tokens.get(num)) is not None:
                line = _inject_origin_token(line, token)
        cleaned_ref_lines.append(line)
    cleaned_ref_section = "\n".join(cleaned_ref_lines)

    # Body fixups:
    #  * Duplicate citations get rewritten to the canonical number — the
    #    cited source is real, only the [N] label is wrong.
    #  * Genuinely invalid citations get stripped — the source is fabricated
    #    or unverifiable.
    cleaned_body = body
    for old_num, canonical_num in duplicate_rewrites.items():
        cleaned_body = re.sub(rf"\[{old_num}\]", f"[{canonical_num}]", cleaned_body)
    valid_numbers = {c["number"] for c in valid_citations}
    cleaned_body = _strip_inline_citations_not_in(cleaned_body, valid_numbers)

    # Note: renumbering is deferred to sanitize_report() which always runs after
    # this function and handles renumbering in a single pass.
    verified_report = cleaned_body + cleaned_ref_section

    logger.debug(
        "[CitationVerify] Result: kept %d, removed %d",
        len(valid_citations),
        len(removed_citations),
    )

    return CitationVerificationResult(
        verified_report=verified_report,
        removed_citations=removed_citations,
        valid_citations=valid_citations,
    )


# ---------------------------------------------------------------------------
# Report sanitization (deterministic post-processing)
# ---------------------------------------------------------------------------

# Known URL shortener domains
_SHORTENER_DOMAINS = frozenset(
    {
        "bit.ly",
        "tinyurl.com",
        "t.co",
        "goo.gl",
        "ow.ly",
        "is.gd",
        "buff.ly",
        "short.io",
        "rb.gy",
        "cutt.ly",
        "lnkd.in",
        "soo.gd",
        "s.coop",
        "cli.gs",
        "budurl.com",
        "yourls.org",
    }
)

# Patterns indicating a truncated/garbled URL
_TRUNCATED_URL_RE = re.compile(r"\.\.\.$|…$")  # ends in ... or ellipsis

# Suspicious URL patterns
_IP_ADDRESS_RE = re.compile(r"^https?://\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}")
_SUSPICIOUS_SCHEMES_RE = re.compile(r"^(?:javascript|data|vbscript|file):", re.IGNORECASE)
# See _GENERIC_URL_RE for the rationale on why ``,`` is matched and stripped
# via _URL_TRIM_CHARS rather than excluded in the character class.
_BARE_URL_RE = re.compile(r"https?://[^\s<>\"'\]]+")

# Body URL patterns (used by sanitize_report)
_MD_LINK_RE = re.compile(r"\[([^\]]*)\]\(\s*\w+://[^\s)]+\)")
_BODY_URL_RE = re.compile(r"\w+://[^\s<>\"'\]]+")
# Whatever gets removed from mid-sentence (a stripped URL, an empty pair of
# parentheses, or an inline [N] that verification dropped) leaves the space that
# preceded it stranded in front of the punctuation that followed, so
# "eine jaehrliche Begehung [3]." reaches the reader as "Begehung .". Spaces and
# tabs only, never a newline, so punctuation is never pulled up onto the
# previous line.
_SPACE_BEFORE_PUNCTUATION_RE = re.compile(r"[ \t]+(?=[.,;:!?])")


@dataclass
class ReportSanitizationResult:
    """Result of running sanitize_report()."""

    sanitized_report: str
    body_urls_removed: int
    body_urls_replaced: int
    shortened_urls_removed: list[str]
    truncated_urls_removed: list[str]
    unsafe_urls_removed: list[str]
    # old ``[N]`` → new ``[N]`` for the gap-closing renumber this pass applied.
    # ``verify_citations`` hands callers a ``[N]``→source binding computed BEFORE
    # this renumbering, so a caller that puts those numbers on the wire has to
    # remap them or the chips end up labelled with numbers the prose no longer
    # uses. Empty when no source section was present or nothing moved.
    renumber_map: dict[int, int] = field(default_factory=dict)


def sanitize_report(report_text: str) -> ReportSanitizationResult:
    """Deterministic report hygiene and final display normalization.

    Checks:
    1. Normalize the source-section heading and one-source-per-line layout.
    2. Strip body URLs — collapse markdown links to display text, replace
       bare URLs that match a reference with ``[N]``, remove the rest.
    3. Remove shortened/obfuscated URLs from Sources — all URLs must
       be fully expanded (no bit.ly, t.co, etc.).
    4. Remove truncated/garbled URLs — URLs ending in '...' or with no
       path (domain-only like 'https://arxiv.org') are incomplete.
    5. Block unsafe URLs — no IP-address URLs, no non-http schemes.
    6. Renumber citations after verification/sanitization and trim any
       trailing source-section meta-commentary.

    Args:
        report_text: Report text (ideally after verify_citations()).

    Returns:
        ReportSanitizationResult with cleaned report and audit trail.
    """
    report_text = _normalize_citation_syntax(report_text)

    body_urls_removed = 0
    body_urls_replaced = 0
    shortened_urls_removed: list[str] = []
    truncated_urls_removed: list[str] = []
    unsafe_urls_removed: list[str] = []

    # Split into body and source section
    ref_match = _REFERENCE_SECTION_RE.search(report_text)
    if ref_match:
        body = report_text[: ref_match.start()]
        ref_section = _normalize_source_section_layout(report_text[ref_match.start() :])
    else:
        body = report_text
        ref_section = ""

    # --- Check 1: Strip body URLs ---
    # Build URL → citation number map from references so matching body
    # URLs are replaced with [N] instead of being deleted entirely.
    url_to_citation: dict[str, int] = {}
    if ref_section:
        for m in _CITATION_LINE_RE.finditer(ref_section):
            num = int(m.group(1))
            url_m = _BARE_URL_RE.search(m.group(2))
            if url_m:
                url_to_citation[_normalize_url(url_m.group(0).rstrip(_URL_TRIM_CHARS))] = num

    def _replace_body_url(match: re.Match) -> str:
        nonlocal body_urls_removed, body_urls_replaced
        url = match.group(0).rstrip(_URL_TRIM_CHARS)
        normalized = _normalize_url(url)
        if normalized in url_to_citation:
            body_urls_replaced += 1
            return f"[{url_to_citation[normalized]}]"
        body_urls_removed += 1
        return ""

    # Collapse markdown links to display text
    cleaned_body = _MD_LINK_RE.sub(r"\1", body)
    # Replace matching bare URLs with [N], strip the rest
    cleaned_body = _BODY_URL_RE.sub(_replace_body_url, cleaned_body)
    # Clean up leftover empty parentheses and extra spaces
    cleaned_body = re.sub(r"\(\s*\)", "", cleaned_body)
    cleaned_body = re.sub(r"  +", " ", cleaned_body)
    cleaned_body = _SPACE_BEFORE_PUNCTUATION_RE.sub("", cleaned_body)

    if body_urls_replaced:
        logger.debug("[ReportSanitize] Replaced %d body URL(s) with citation numbers", body_urls_replaced)
    if body_urls_removed:
        logger.debug("[ReportSanitize] Removed %d unmatched URL(s) from report body", body_urls_removed)

    # --- Checks 3 & 4: Validate URLs in source section ---
    if ref_section:
        lines_to_remove: set[int] = set()
        ref_lines = ref_section.split("\n")

        for i, line in enumerate(ref_lines):
            url_match = _BARE_URL_RE.search(line)
            if not url_match:
                continue
            url = url_match.group(0).rstrip(_URL_TRIM_CHARS)

            # Check for non-http schemes embedded in text
            if _SUSPICIOUS_SCHEMES_RE.search(line):
                unsafe_urls_removed.append(url)
                lines_to_remove.add(i)
                continue

            parsed = urlparse(url)
            domain = parsed.netloc.lower()

            # Check 2: shortened URLs
            # Strip www. and port for comparison
            bare_domain = domain.split(":")[0]
            if bare_domain.startswith("www."):
                bare_domain = bare_domain[4:]
            if bare_domain in _SHORTENER_DOMAINS:
                shortened_urls_removed.append(url)
                lines_to_remove.add(i)
                continue

            # Check 3: truncated/garbled URLs — only catch obvious truncation markers
            raw_url = url_match.group(0)
            if _TRUNCATED_URL_RE.search(raw_url) or "…" in raw_url:
                truncated_urls_removed.append(raw_url)
                lines_to_remove.add(i)
                continue

            # Check 4: IP address URLs
            if _IP_ADDRESS_RE.match(url):
                unsafe_urls_removed.append(url)
                lines_to_remove.add(i)
                continue

            # Check 4: non-http schemes
            if parsed.scheme not in ("http", "https"):
                unsafe_urls_removed.append(url)
                lines_to_remove.add(i)
                continue

        if lines_to_remove:
            # Collect which [N] numbers were removed
            removed_numbers: set[int] = set()
            for i in lines_to_remove:
                line_m = _CITATION_LINE_RE.match(ref_lines[i])
                if line_m:
                    removed_numbers.add(int(line_m.group(1)))

            cleaned_ref_lines = [line for i, line in enumerate(ref_lines) if i not in lines_to_remove]
            ref_section = "\n".join(cleaned_ref_lines)

            # Strip orphaned inline [N] from body
            if removed_numbers:
                for num in removed_numbers:
                    cleaned_body = re.sub(rf"\[{num}\]", "", cleaned_body)

        if shortened_urls_removed:
            logger.debug(
                "[ReportSanitize] Removed %d shortened URL(s) from references: %s",
                len(shortened_urls_removed),
                shortened_urls_removed,
            )
        if truncated_urls_removed:
            logger.debug(
                "[ReportSanitize] Removed %d truncated/incomplete URL(s) from references: %s",
                len(truncated_urls_removed),
                truncated_urls_removed,
            )
        if unsafe_urls_removed:
            logger.debug(
                "[ReportSanitize] Removed %d unsafe URL(s) from references: %s",
                len(unsafe_urls_removed),
                unsafe_urls_removed,
            )

    # Renumber citations to close any gaps (from verify_citations and/or sanitize removals)
    renumber_map: dict[int, int] = {}
    if ref_section:
        cleaned_body, ref_section, renumber_map = _renumber_citations(cleaned_body, ref_section)

    sanitized_report = cleaned_body + ref_section

    # --- Strip leaked tool-call XML fragments ---
    # LLMs sometimes output raw tool-call syntax as text
    sanitized_report = re.sub(
        r"</?(parameter|function|tool_call|tool_use|invoke|antml:[\w]+)[\s>].*",
        "",
        sanitized_report,
        flags=re.DOTALL,
    )

    # --- Trim everything after the last citation in the Sources section ---
    # The LLM often appends meta-commentary after the references (e.g.,
    # "All citations refer to...", "This report meets..."). Rather than
    # pattern-matching specific phrases, just cut after the last [N] line.
    if ref_section:
        last_citation_end = None
        for m in _CITATION_LINE_RE.finditer(sanitized_report):
            last_citation_end = m.end()
        if last_citation_end is not None:
            sanitized_report = sanitized_report[:last_citation_end].rstrip() + "\n"

    return ReportSanitizationResult(
        sanitized_report=sanitized_report,
        body_urls_removed=body_urls_removed,
        body_urls_replaced=body_urls_replaced,
        shortened_urls_removed=shortened_urls_removed,
        truncated_urls_removed=truncated_urls_removed,
        unsafe_urls_removed=unsafe_urls_removed,
        renumber_map=renumber_map,
    )
