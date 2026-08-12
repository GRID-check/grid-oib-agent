"""Spatial engine client — the model's own BYTES, and one operator over them.

Where :mod:`aiq_agent.knowledge.bim_query` asks the BFF a question and reports
the answer, this module asks the BFF for a FILE and answers the question here.
The difference is not architectural taste, it is where the capability lives:
the extracted index in Postgres knows what the export wrote down, and the
questions ``ifc_measure`` exists for are the ones it did not write down — a
room's floor area when no ``Qto_*`` was published, a window's sill height, the
clear height under a suspended ceiling. Those need geometry, geometry needs the
file, and the engine that reads it (IfcOpenShell/OCCT, roadmap §13b) is Python.

## How a model becomes bytes

The agent backend owns no object storage — ADR-0045 puts `grid_app` and the
bucket behind the BFF — so it obtains the source exactly as the viewer does:
it asks for a short-lived presigned URL and reads it. The route is
``POST /api/internal/bim/source``, the service-token twin of the viewer's
``GET /api/bim/models/<id>/source``, and it applies the same ``ifc-models``
flag and the same project + Archiv scope as ``POST /api/internal/bim/query``
because both share ``lib/bim/internal-access``. **This module widens nothing.**
It cannot: it names a project and a file name, exactly like ``ifc_query``, and
the BFF decides what that means.

## Why the cache needs a second key

:class:`ifc_spatial.cache.SpatialCache` is keyed on the sha256 of the bytes,
which is the right key and the wrong question: knowing it requires having
already downloaded the file. A 150 MB IFC downloaded once per tool call would
make the second question about a building cost as much as the first.

So this module keys on a SOURCE IDENTITY as well — the object's ETag if the
store gave one, else the model id and its ``updatedAt`` — and remembers what
that identity resolved to. The second question about a building is then a
dictionary lookup and no network at all, while a re-export lands under a new
identity and is a guaranteed miss. That last property is the one worth having:
it is what stops the agent measuring last week's building because the file name
did not change.

The cache is process-local and holds no tenancy, exactly as its own docstring
warns. That is safe here for one reason and it is worth stating: **the content
hash is never a way in.** Every call re-resolves the model through the BFF, so
a caller that may not see a building never reaches the cache lookup, and the
hash is only ever used to skip work for a model this process was just granted.
"""

from __future__ import annotations

import atexit
import json
import logging
import os
import tempfile
import threading
import urllib.error
import urllib.request
from typing import Any

from aiq_agent.knowledge.bim_query import BimQueryRejectedError
from aiq_agent.knowledge.bim_query import BimQueryUnavailableError

logger = logging.getLogger(__name__)

#: Resolving a model to a URL is a list, a flag lookup and a HEAD. It is not
#: the download.
_RESOLVE_TIMEOUT_SECONDS = 10

#: The download itself. A 250 MB model (`BIM_MAX_IFC_BYTES`) over the compose
#: network is seconds; the ceiling is here so a stalled object store cannot hold
#: a turn open indefinitely.
_DOWNLOAD_TIMEOUT_SECONDS = 120

#: Resident bytes per byte of IFC, once IfcOpenShell has the file open.
#:
#: Measured across the corpus, the ratio runs from 20× to about 143× — 2.3 MB of
#: sample house occupies 47 MB, and a 151 MB office model peaked at 5.3 GB. The
#: spread is real and it is not predictable from the file size: it tracks
#: geometric complexity, so a dense curtain-wall facade costs far more per byte
#: than a big flat slab.
#:
#: The LOW end is used deliberately. It makes the gate a NECESSARY condition and
#: not a sufficient one: a file over the ceiling certainly cannot be measured
#: here, while one under it merely might be. Using 143× would be honest about
#: the worst case and would refuse a 30 MB model on a 4 GB pod, which is most
#: real projects — the guard would have removed the capability instead of
#: protecting it.
PARSE_FOOTPRINT_RATIO = 20

#: Floor and cap for the derived ceiling. The cap is the BFF's own upload limit
#: rounded up; below the floor the tool is not worth having at all.
_MIN_MODEL_BYTES = 16 * 1024 * 1024
_MAX_MODEL_BYTES_CAP = 512 * 1024 * 1024


def _container_memory_bytes() -> int | None:
    """What this container may actually use, not what the host has.

    ``os.sysconf`` reports the HOST's RAM inside a cgroup-limited container, so
    a 2 GB pod on a 128 GB node would size its ceiling for 128 GB and be OOM-
    killed by the kernel — silently, taking the conversation with it. cgroup v2
    first, then v1, then the host as a last resort.
    """
    for path in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        try:
            with open(path, encoding="ascii") as handle:
                raw = handle.read().strip()
        except OSError:
            continue
        if raw == "max":
            break
        try:
            value = int(raw)
        except ValueError:
            continue
        # cgroup v1 writes a sentinel near 2^63 to mean "unlimited".
        if 0 < value < (1 << 62):
            return value
    try:
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    except (ValueError, OSError, AttributeError):
        return None


def _derive_max_model_bytes() -> int:
    """The largest model this process will admit, from the memory it actually has.

    A fixed 512 MB was the previous rule, justified as "a refusal rather than an
    OOM". It accounted for the DOWNLOAD and not for the parse: at 20× the low
    end, a 512 MB file needs 10 GB resident before a single question is asked,
    so on any ordinary pod the guard guaranteed exactly the OOM it named.

    Half the container's memory, divided by the footprint ratio, leaves room for
    the model already resident (``MAX_RESIDENT_MODELS`` is 2) and for the rest of
    the process. Overridable, because an operator who has sized a dedicated
    worker knows better than this arithmetic does.
    """
    override = os.environ.get("BIM_SPATIAL_MAX_MODEL_BYTES", "").strip()
    if override:
        try:
            chosen = int(override)
        except ValueError:
            logger.warning("BIM_SPATIAL_MAX_MODEL_BYTES is not a number: %r — ignored", override)
        else:
            if chosen > 0:
                return chosen
            logger.warning("BIM_SPATIAL_MAX_MODEL_BYTES must be positive: %r — ignored", override)

    available = _container_memory_bytes()
    if not available:
        return _MIN_MODEL_BYTES
    derived = int(available * 0.5) // PARSE_FOOTPRINT_RATIO
    return max(_MIN_MODEL_BYTES, min(_MAX_MODEL_BYTES_CAP, derived))


#: What this process will read into memory for one model — a refusal rather than
#: an OOM, because a killed worker takes the whole conversation with it.
MAX_MODEL_BYTES = _derive_max_model_bytes()


class SpatialEngineUnavailableError(RuntimeError):
    """The spatial engine is not installed in this process.

    Distinct from every other failure here: nothing is wrong with the model or
    the request, this deployment simply cannot answer geometric questions. The
    tool says so in those words rather than implying the building is unreadable.
    """


class ModelTooLargeError(BimQueryUnavailableError):
    """This model does not fit in this worker's memory.

    A subclass so every existing handler keeps working, and its own type because
    the sentence a user needs is completely different. Reported as the generic
    „der Modelldienst ist nicht erreichbar", an architect waits for an outage
    that will never end: the service is perfectly healthy and their 300 MB
    export is never going to be measurable on this deployment. The fact is
    about the FILE, and only a message that says so lets them act — split the
    model by building section, or ask for a bigger worker.

    Carries the numbers so the message can name them instead of gesturing at a
    limit the reader cannot see.
    """

    def __init__(self, model_bytes: int | None, limit_bytes: int) -> None:
        self.model_bytes = model_bytes
        self.limit_bytes = limit_bytes
        size = f"{model_bytes / (1024 * 1024):.0f} MB" if model_bytes else "the model"
        super().__init__(
            f"{size} exceeds the {limit_bytes // (1024 * 1024)} MB this worker can hold"
        )


class SpatialToolError(ValueError):
    """The call could not be MADE — no such GlobalId, no such relation.

    :class:`ifc_spatial.tools.ToolError` re-raised under a name this package's
    callers can catch without importing IfcOpenShell to do it. The distinction
    it carries is the one the whole envelope is built on: this means we could
    not look, while every "looked, and the file cannot say" comes back as a
    successful answer carrying ``decidable: false``. Collapsing the two would
    let a typo in a GlobalId read as a finding about the building.
    """


def _internal_base_url() -> str:
    url = os.environ.get("FRONTEND_INTERNAL_URL") or os.environ.get("FRONTEND_URL") or "http://frontend:3000"
    return url.rstrip("/")


def _service_token() -> str | None:
    return os.environ.get("GRID_INTERNAL_API_TOKEN") or None


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse redirects on the internal call — a 3xx means an auth middleware
    intercepted it, and following it would drop the POST body and the service
    token. Mirrors :mod:`aiq_agent.knowledge.bim_query`."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        raise urllib.error.HTTPError(req.full_url, code, f"unexpected redirect to {newurl}", headers, fp)


_opener = urllib.request.build_opener(_NoRedirectHandler)


def resolve_model_source(
    *,
    organization_id: str,
    project_id: str | None,
    model_name: str | None = None,
) -> dict[str, Any]:
    """Ask the BFF which model this is, and where its bytes are.

    Returns the endpoint's body verbatim. ``resolved: false`` is a normal
    outcome carrying a German ``message`` (no model, several models, extraction
    still running) that the caller reports rather than treating as a failure.

    :raises BimQueryUnavailableError: nothing was looked up — no token, no
        transport, or a 5xx.
    :raises BimQueryRejectedError: the endpoint understood the request and
        refused it, which is correctable by the caller.
    """
    from aiq_agent.knowledge.bim_query import _rejection_message

    token = _service_token()
    if not token:
        raise BimQueryUnavailableError("GRID_INTERNAL_API_TOKEN is not configured")

    payload: dict[str, Any] = {"organizationId": organization_id}
    if project_id:
        payload["projectId"] = project_id
    if model_name:
        payload["modelName"] = model_name

    request = urllib.request.Request(
        f"{_internal_base_url()}/api/internal/bim/source",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-grid-internal-token": token},
        method="POST",
    )

    try:
        with _opener.open(request, timeout=_RESOLVE_TIMEOUT_SECONDS) as response:
            body = response.read()
    except urllib.error.HTTPError as exc:
        # Never log the body: it names the tenant's files. The status is what a
        # reader needs.
        logger.warning("BIM source lookup refused by the frontend (status=%s)", exc.code)
        if 400 <= exc.code < 500 and exc.code not in (401, 403, 429):
            raise BimQueryRejectedError(_rejection_message(exc)) from exc
        raise BimQueryUnavailableError(f"internal BIM source endpoint returned {exc.code}") from exc
    except Exception as exc:  # noqa: BLE001 — urllib raises a wide family here
        logger.warning("BIM source lookup could not reach the frontend: %s", type(exc).__name__)
        raise BimQueryUnavailableError("internal BIM source endpoint unreachable") from exc

    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as exc:
        raise BimQueryUnavailableError("internal BIM source endpoint returned a non-JSON body") from exc
    if not isinstance(parsed, dict):
        raise BimQueryUnavailableError("internal BIM source endpoint returned an unexpected body")
    return parsed


def source_identity(result: dict[str, Any]) -> str:
    """A key for "the same bytes as last time", from a resolved source body.

    The object's ETag when the store gave one — it changes when the object
    changes, which is precisely the property a cache key needs. Otherwise the
    model id plus its revision timestamp, which changes on every re-extraction
    and is therefore correct in the same direction, if coarser.

    Never the file name alone. A re-export under the same name is the ordinary
    way an architect works, and serving the old parse for it would answer a
    question about a building that no longer exists.
    """
    model = result.get("model") or {}
    source = result.get("source") or {}
    etag = source.get("etag")
    if isinstance(etag, str) and etag:
        return f"etag:{etag}"
    return f"model:{model.get('modelId')}:{model.get('updatedAt')}"


def _download(url: str, expected_bytes: Any = None) -> bytes:
    """The model's bytes, or a refusal that says which limit was hit."""
    if not isinstance(url, str) or not url.lower().startswith(("http://", "https://")):
        raise BimQueryUnavailableError("the model source URL was not usable")
    if isinstance(expected_bytes, (int, float)) and expected_bytes > MAX_MODEL_BYTES:
        # Refused on the HEAD's byte count, before a single byte is transferred.
        raise ModelTooLargeError(int(expected_bytes), MAX_MODEL_BYTES)
    try:
        with urllib.request.urlopen(url, timeout=_DOWNLOAD_TIMEOUT_SECONDS) as response:  # noqa: S310
            # One byte past the ceiling, so "exactly at the limit" and "over it"
            # are distinguishable without reading the whole thing first.
            data = response.read(MAX_MODEL_BYTES + 1)
            encoding = (response.headers.get("Content-Encoding") or "").lower()
    except Exception as exc:  # noqa: BLE001
        logger.warning("the model source could not be downloaded: %s", type(exc).__name__)
        raise BimQueryUnavailableError("the model file could not be downloaded") from exc

    if len(data) > MAX_MODEL_BYTES:
        # The store gave no Content-Length, or lied about it.
        raise ModelTooLargeError(len(data), MAX_MODEL_BYTES)
    if "gzip" in encoding:
        # The internal route presigns the ORIGINAL object precisely so this
        # cannot happen — the viewer's `_bim/source.ifc.gz` is transparent only
        # because a browser inflates it. Handled anyway rather than trusted,
        # because the alternative failure is IfcOpenShell reporting a perfectly
        # good building as unreadable.
        import gzip

        try:
            data = gzip.decompress(data)
        except OSError as exc:
            raise BimQueryUnavailableError("the model file arrived compressed and could not be read") from exc
    return data


# ── the engine ───────────────────────────────────────────────────────────────

#: How many models one process keeps parsed. Two, not the package default of
#: four: a conversation touches one building, occasionally two being compared,
#: and each resident model holds its tessellation and its OCCT tree in the C++
#: heap of a process that is also running an agent.
MAX_RESIDENT_MODELS = 2

_LOCK = threading.Lock()
#: source identity → the local file the bytes were spilled to.
_PATH_BY_SOURCE: dict[str, str] = {}
#: source identity → content hash, once this process has read those bytes.
_HANDLE_BY_SOURCE: dict[str, str] = {}
#: The handles registered in the CURRENT tool table — see :func:`open_model`.
_OPEN_HANDLES: list[str] = []
#: Spill files, unlinked when the interpreter exits and never before.
_SPILLED: list[str] = []
_CACHE: Any = None
_TOOLS: Any = None


@atexit.register
def _remove_spilled_files() -> None:
    for path in _SPILLED:
        try:
            os.unlink(path)
        except OSError:
            pass


def _engine() -> tuple[Any, Any]:
    """The shared cache and the current tool table.

    Imported lazily and behind a lock: ``import ifc_spatial`` pulls in
    IfcOpenShell, numpy and shapely, which is a second of import time and a few
    hundred megabytes of address space that a deployment answering no model
    questions should never pay.
    """
    global _CACHE, _TOOLS
    if _TOOLS is None:
        try:
            from ifc_spatial.cache import SpatialCache
            from ifc_spatial.tools import create_tools
        except ImportError as exc:  # pragma: no cover — deployment shape
            raise SpatialEngineUnavailableError(str(exc)) from exc
        _CACHE = SpatialCache(max_entries=MAX_RESIDENT_MODELS)
        _TOOLS = create_tools(_CACHE)
    return _CACHE, _TOOLS


def _spill(identity: str, data: bytes) -> str:
    """These bytes as a file on disk, once per source identity.

    IfcOpenShell wants a path, and it wants the file to stay there: the entity
    graph is read first and the geometry pass and the OCCT tree read the same
    file again later. So the file outlives the call, and it is unlinked only
    when the interpreter exits — the same posture
    :class:`ifc_spatial.cache.SpatialCache` takes toward its own spills, and for
    the same reason. Unlinking a file whose model is still resident would turn a
    memory decision into a broken model.

    The consequence is stated rather than hidden: a process that opens many
    different buildings accumulates their files for its lifetime. A host serving
    many models from one process should recycle it, which is what the engine's
    own cache docstring says about the identical trade.
    """
    with _LOCK:
        existing = _PATH_BY_SOURCE.get(identity)
    if existing and os.path.isfile(existing):
        return existing

    handle, path = tempfile.mkstemp(prefix="grid-ifc-", suffix=".ifc")
    with os.fdopen(handle, "wb") as file:
        file.write(data)
    with _LOCK:
        _PATH_BY_SOURCE[identity] = path
        _SPILLED.append(path)
    return path


def open_model(result: dict[str, Any]) -> str:
    """Open a resolved model and return the handle every operator takes.

    Three levels of "already have it", cheapest first:

    1. the handle is registered in the current tool table — nothing at all
       happens, and this is the ordinary case for the second, third and tenth
       question about one building;
    2. the bytes are on disk from an earlier turn — the file is re-read (a hash
       plus, on a cache hit, nothing else);
    3. neither — the file is downloaded.

    The tool table is REPLACED once it holds more models than the cache does,
    and that is not an optimisation. ``create_tools`` keeps a handle table that
    never evicts, deliberately, so that a handle handed to an MCP client three
    turns ago still resolves. In an agent process serving many tenants from one
    interpreter that table is unbounded retention of tenant model data — so the
    table is dropped and rebuilt around the cache's own lid, which is the only
    number here that has a memory meaning.
    """
    cache, _ = _engine()
    identity = source_identity(result)

    with _LOCK:
        known = _HANDLE_BY_SOURCE.get(identity)
        if known and known in _OPEN_HANDLES:
            return known

    source = result.get("source") or {}
    path = _PATH_BY_SOURCE.get(identity)
    if not path or not os.path.isfile(path):
        path = _spill(identity, _download(source.get("url"), source.get("bytes")))

    global _TOOLS
    with _LOCK:
        if len(_OPEN_HANDLES) >= MAX_RESIDENT_MODELS:
            from ifc_spatial.tools import create_tools

            _TOOLS = create_tools(cache)
            _OPEN_HANDLES.clear()
        tools = _TOOLS

    from ifc_spatial.tools import ToolError
    from ifc_spatial.tools import call

    try:
        opened = call(tools, "open_model", {"path": path})
    except ToolError as exc:
        # `SpatialModel` refuses an unreadable file with a German reason an
        # architect can act on — truncated upload, wrong format, too large.
        # That sentence is the answer; burying it under a traceback would
        # leave the agent with "es hat nicht funktioniert".
        raise BimQueryUnavailableError(str(exc)) from None

    handle = str(opened.get("contentHash") or "")
    with _LOCK:
        _HANDLE_BY_SOURCE[identity] = handle
        if handle not in _OPEN_HANDLES:
            _OPEN_HANDLES.append(handle)
    return handle


def call_spatial_tool(handle: str, name: str, args: dict[str, Any]) -> Any:
    """Run one operator from :mod:`ifc_spatial.tools` against an open model.

    ``handle`` is what :func:`open_model` returned — the content hash, which is
    the package's own address for a model, so nothing has to translate between
    two notions of "which building".

    Raises :class:`SpatialToolError` for a call that could not be made at all
    (no such GlobalId, an unknown relation). Every "the file cannot say" comes
    back as a successful answer carrying ``decidable: false``, and the two must
    not be collapsed.
    """
    _engine()
    with _LOCK:
        tools = _TOOLS

    from ifc_spatial.tools import ToolError
    from ifc_spatial.tools import call

    try:
        return call(tools, name, {**args, "model": handle})
    except ToolError as exc:
        raise SpatialToolError(str(exc)) from None


def reset_cache_for_tests() -> None:
    """Forget every parsed model, handle and source identity."""
    global _CACHE, _TOOLS
    with _LOCK:
        if _CACHE is not None:
            _CACHE.clear()
        _PATH_BY_SOURCE.clear()
        _HANDLE_BY_SOURCE.clear()
        _OPEN_HANDLES.clear()
        _CACHE = None
        _TOOLS = None


__all__ = [
    "MAX_MODEL_BYTES",
    "MAX_RESIDENT_MODELS",
    "ModelTooLargeError",
    "PARSE_FOOTPRINT_RATIO",
    "SpatialEngineUnavailableError",
    "SpatialToolError",
    "call_spatial_tool",
    "open_model",
    "reset_cache_for_tests",
    "resolve_model_source",
    "source_identity",
]
