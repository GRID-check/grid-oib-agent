"""``file_draft`` and ``submit_draft``: the working directory's two doors into the project.

Everything else under ``tools/documents/`` stays inside the conversation. These
two are the seam, and they are two tools rather than one with a ``submit: bool``
for a reason worth stating, because the flag looks cheaper:

**Filing and submitting are different promises to the reader.** Filing produces
a draft nobody has to look at. Submitting opens an inbox item on a named
reviewer and asks a person to spend attention — and once it is `in_review` the
draft can no longer be replaced, so a submit is the end of the writing turn, not
a decoration on it. A boolean argument is precisely the shape a model fills in
from the surrounding sentence: „leg das ab und schick es gleich rum" and „leg
das ab" differ by four words, and a default that flips on the wrong one mails a
half-finished Aktenvermerk to a Ziviltechniker. Two verbs make the model choose
the verb, which is the choice it is actually being asked to make. The same
reasoning made ``remember`` its own tool rather than a flag on the answer.

There is deliberately no ``note`` on ``submit_draft``. The wire carries
``reviewerUserIds`` and nothing else (``internalDocumentVersionRequestSchema``),
so a note argument would be a parameter the API discards — a lie in the
signature, and the model would put the substance of its handover into it.

What this module may NOT do is in ``src/aiq_agent/tools/AGENTS.md``: it echoes
the BFF-signed envelope and never signs, and the BFF decides identity and
permission. See ``filing.py`` for why.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any

from aiq_agent import project_context
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig

from .cards import draft_title
from .cards import emit_draft_card
from .draft_store import DRAFT_ROOT
from .draft_store import FILED_DOCUMENT_KEY
from .draft_store import FILED_HASH_KEY
from .draft_store import FILED_STATE_KEY
from .draft_store import FILED_VERSION_KEY
from .draft_store import DraftBackend
from .draft_store import DraftUsage
from .draft_store import get_draft_backend
from .filing import FilingError
from .filing import SignedEnvelope
from .filing import post_document_version

logger = logging.getLogger(__name__)

#: The BFF's own ceilings (`internalDocumentVersionRequestSchema`). Checked here
#: so an over-long title comes back where the model can shorten it, rather than
#: as a 400 after the reader has been told the document is being filed.
MAX_TITLE_CHARS = 200
MAX_REF_CHARS = 200

#: The states an open version may be replaced in — the `update` rows of the
#: transition table, mirrored so the refusal is worded for the model here instead
#: of arriving as an HTTP 409.
REPLACEABLE_STATES = frozenset({"draft", "changes_requested"})

#: The one sentence every success ends on. It leads with what the document is
#: NOT, because that is the claim the model gets wrong: „ins Projekt übernommen“
#: reads as done, and the reader then tells a Bauherr that a Befund is out.
_STILL_A_DRAFT = (
    "Das ist ein ENTWURF, den noch niemand freigegeben hat — sage nicht, das Dokument sei "
    "freigegeben, veröffentlicht oder fertig."
)

_NO_PROJECT = (
    "Fehler: In diesem Gespräch gibt es kein Projekt, also auch keine Projektablage, in der ein "
    "Entwurf liegen könnte. Der Entwurf bleibt im Arbeitsordner dieser Unterhaltung. "
    "Nicht erneut versuchen."
)

#: No signed envelope, no acting person — and this tier must not invent one. A
#: run without it is an unattended one (CLI, eval, job worker), where there is
#: nobody whose permissions the filing could be checked against.
_NO_ENVELOPE = (
    "Fehler: Dieser Lauf hat keinen signierten Sitzungsnachweis, deshalb kann nicht im Namen einer "
    "Person abgelegt werden. Es wurde nichts abgelegt. Nicht erneut versuchen."
)

_NO_CONVERSATION = (
    "Fehler: Dieser Lauf gehört zu keiner Unterhaltung, es gibt also keinen Arbeitsordner. "
    "Es wurde nichts abgelegt. Nicht erneut versuchen."
)


def _slug(path: str) -> str:
    """A short stable name for the idempotency reference, from the file name."""
    name = path.rsplit("/", 1)[-1]
    name = re.sub(r"\.md$", "", name, flags=re.IGNORECASE)
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or "entwurf"


def filing_reference(conversation_id: str, path: str) -> str:
    """The BFF's idempotency key: ``{conversation}-{slug}``, bounded.

    Two turns of one conversation writing „Aktenvermerk" must land on ONE
    document with two versions, which is what makes this key the conversation's
    and not the turn's.
    """
    return f"{conversation_id}-{_slug(path)}"[:MAX_REF_CHARS]


class _Refused(Exception):
    """A model-facing refusal, raised where it is discovered."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def _envelope() -> SignedEnvelope:
    header, signature = project_context.get_request_envelope_from_context()
    if not header or not signature:
        raise _Refused(_NO_ENVELOPE)
    return SignedEnvelope(header=header, signature=signature)


def _conversation_id() -> str:
    """The conversation this turn belongs to, agreed by both of its sources.

    The working directory is namespaced by NAT's conversation id, so that is the
    id that finds the file. The verified envelope carries one too, and the BFF
    authorizes on ITS copy — so a disagreement means one of the two is about a
    different conversation, and filing the wrong conversation's draft under this
    one's reference is not a failure anybody would notice afterwards.
    """
    live = project_context.get_conversation_id_from_context()
    if not live:
        raise _Refused(_NO_CONVERSATION)
    signed = project_context.GridRequestContext.from_context().conversation_id
    if signed and signed != live:
        logger.warning("Envelope conversation %r disagrees with the turn's %r; refusing to file", signed, live)
        raise _Refused(_NO_ENVELOPE)
    return live


async def _draft(path: str) -> tuple[DraftBackend, DraftUsage]:
    """The backend and the stored state of one path, or a refusal."""
    if not path.startswith(DRAFT_ROOT) or ".." in path:
        raise _Refused(
            f"Fehler: `{path}` liegt nicht im Arbeitsordner. Abgelegt werden kann nur, was unter "
            f"`{DRAFT_ROOT}` geschrieben wurde."
        )
    backend = await get_draft_backend(_conversation_id())
    usage = await backend.aread(path)
    if usage.content is None:
        raise _Refused(
            f"Fehler: Unter `{path}` gibt es keinen Entwurf. Mit `ls` nachsehen, wie der Entwurf wirklich heißt."
        )
    return backend, usage


def _version_fields(body: dict[str, Any]) -> dict[str, str]:
    """The filing record, read out of the route's answer."""
    version = body.get("version") or {}
    return {
        FILED_DOCUMENT_KEY: str(body.get("documentId") or version.get("documentId") or ""),
        FILED_VERSION_KEY: str(version.get("id") or ""),
        FILED_HASH_KEY: str(version.get("contentHash") or ""),
        FILED_STATE_KEY: str(version.get("state") or ""),
    }


async def _post(payload: dict[str, Any], envelope: SignedEnvelope) -> dict[str, Any]:
    """The blocking call, off the event loop, with the refusal already worded."""
    try:
        return await asyncio.to_thread(post_document_version, payload, envelope)
    except FilingError as exc:
        raise _Refused(
            f"Fehler beim Ablegen: {exc}. Es wurde nichts abgelegt; sage der Nutzerin, dass der "
            "Entwurf im Arbeitsordner liegt."
        ) from exc


async def _create(path: str, usage: DraftUsage, title: str, envelope: SignedEnvelope) -> dict[str, str]:
    """First filing of this path: one ``create``, plus an ``update`` if it existed."""
    body = await _post(
        {
            "op": "create",
            "projectId": project_context.get_project_id_from_context(),
            "ref": filing_reference(_conversation_id(), path),
            "title": title,
            "content": usage.content or "",
        },
        envelope,
    )
    filing = _version_fields(body)
    # The reference was already filed — a retried turn, or a working directory
    # that lost its mapping (a restart with an in-memory store). The item comes
    # back and NO version was written, so the bytes standing in the project are
    # the OLD ones; saying "filed" here would be true and misleading. Replace
    # them, using the hash the route just told us.
    if body.get("alreadyFiled") and filing[FILED_STATE_KEY] in REPLACEABLE_STATES:
        return await _update(usage, filing, envelope)
    return filing


async def _update(usage: DraftUsage, filing: dict[str, str], envelope: SignedEnvelope) -> dict[str, str]:
    """Replace the bytes of the open version this path already has."""
    body = await _post(
        {
            "op": "update",
            "documentId": filing[FILED_DOCUMENT_KEY],
            "versionId": filing[FILED_VERSION_KEY],
            "content": usage.content or "",
            # The hash the BFF last reported for THIS version, not one computed
            # here: If-Match is about the bytes the server holds, and a hash of
            # our own copy would agree with itself and overwrite a reviewer.
            "ifMatch": filing[FILED_HASH_KEY],
        },
        envelope,
    )
    return _version_fields(body)


def _project_or_refuse() -> str:
    project_id = project_context.get_project_id_from_context()
    if not project_id:
        raise _Refused(_NO_PROJECT)
    return project_id


# ── file_draft ───────────────────────────────────────────────────────────────

_FILE_DRAFT_DESCRIPTION = (
    "Legt einen Entwurf aus dem Arbeitsordner ALS ENTWURF im Projekt ab, damit ihn andere sehen und "
    "prüfen können. `path` ist der Pfad im Arbeitsordner (`" + DRAFT_ROOT + "<name>.md`), `title` "
    "optional der Titel im Projekt — ohne Angabe die erste Überschrift des Dokuments. "
    "Aufrufen, wenn die Nutzerin darum bittet („leg das ins Projekt“, „abspeichern“, „ablegen“),  "
    "nicht von selbst nach jedem Schreiben. "
    "Ein zweiter Aufruf für denselben Pfad ersetzt den Inhalt desselben Entwurfs, es entsteht kein "
    "zweites Dokument. Abgelegt wird ein ENTWURF: niemand hat ihn freigegeben, er ist nicht "
    "veröffentlicht und wird nicht durchsucht. Für die Freigabe `submit_draft` verwenden."
)


class FileDraftConfig(FunctionBaseConfig, name="file_draft"):
    """Configuration for the ``file_draft`` tool."""


async def _refile(usage: DraftUsage, envelope: SignedEnvelope) -> dict[str, str]:
    """A path this conversation has filed before: replace the open version's bytes."""
    if usage.filing.get(FILED_STATE_KEY, "") not in REPLACEABLE_STATES:
        raise _Refused(
            "Fehler: Dieser Entwurf liegt bereits zur Freigabe vor und kann nicht mehr geändert werden. "
            "Sage der Nutzerin, dass eine Person ihn zuerst zurückgeben oder freigeben muss."
        )
    return await _update(usage, usage.filing, envelope)


async def _file(path: str, title: str) -> str:
    """The whole of ``file_draft``, with every refusal raised where it is found."""
    _project_or_refuse()
    envelope = _envelope()
    backend, usage = await _draft(path)
    chosen = " ".join((title or "").split())[:MAX_TITLE_CHARS] or draft_title(path, usage.content or "")
    filing = (
        await _refile(usage, envelope)
        if usage.filing.get(FILED_DOCUMENT_KEY)
        else await _create(path, usage, chosen, envelope)
    )
    await backend.arecord_filing(path, filing)
    emit_draft_card(path=path, content=usage.content or "", version=usage.version or 1, filing=filing, title=chosen)
    return (
        f"Im Projekt abgelegt: „{chosen}“. {_STILL_A_DRAFT} "
        "Zur Freigabe einreichen kann `submit_draft`, wenn die Nutzerin darum bittet."
    )


async def run_file_draft(path: str, title: str = "") -> str:
    """File one working-directory draft into the project as a draft version.

    Module-level, and the tool below is a one-line wrapper around it, so the
    refusal paths are reachable by a test without going through NAT's
    generator — the refusals are most of what this tool is.
    """
    try:
        return await _file(path, title)
    except _Refused as refused:
        return refused.message


@register_function(config_type=FileDraftConfig)
async def file_draft(tool_config: FileDraftConfig, builder: Builder):
    yield FunctionInfo.from_fn(run_file_draft, description=_FILE_DRAFT_DESCRIPTION)


# ── submit_draft ─────────────────────────────────────────────────────────────

_SUBMIT_DRAFT_DESCRIPTION = (
    "Reicht einen bereits im Projekt abgelegten Entwurf ZUR FREIGABE ein: Er geht in die Prüfung und "
    "erscheint im Posteingang der Prüfenden. `path` ist derselbe Pfad im Arbeitsordner wie bei "
    "`file_draft`. Nur aufrufen, wenn die Nutzerin um Freigabe, Prüfung oder Weitergabe bittet — "
    "das Einreichen kostet eine Person Aufmerksamkeit und der Entwurf lässt sich danach nicht mehr "
    "ändern. Ist der Entwurf noch nicht abgelegt, zuerst `file_draft`. Auch nach dem Einreichen ist "
    "das Dokument NICHT freigegeben: Es wartet auf die Freigabe durch eine Person."
)


class SubmitDraftConfig(FunctionBaseConfig, name="submit_draft"):
    """Configuration for the ``submit_draft`` tool."""


async def _submit(path: str) -> str:
    """The whole of ``submit_draft``, with every refusal raised where it is found."""
    _project_or_refuse()
    envelope = _envelope()
    backend, usage = await _draft(path)
    filing = _submittable(usage)
    body = await _post(
        {
            "op": "submit",
            "documentId": filing[FILED_DOCUMENT_KEY],
            "versionId": filing[FILED_VERSION_KEY],
            # Nobody named. The route falls back to the project's reviewers; this
            # tier holds no member roster, and a guessed reviewer is the same
            # mistake `assign_document` refuses to make.
            "reviewerUserIds": [],
        },
        envelope,
    )
    updated = _version_fields(body)
    await backend.arecord_filing(path, updated)
    emit_draft_card(path=path, content=usage.content or "", version=usage.version or 1, filing=updated)
    return (
        f"Zur Freigabe eingereicht: „{draft_title(path, usage.content or '')}“ wartet jetzt auf die "
        f"Prüfung durch eine Person. {_STILL_A_DRAFT}"
    )


async def run_submit_draft(path: str) -> str:
    """Submit one already-filed draft for review. See :func:`run_file_draft`."""
    try:
        return await _submit(path)
    except _Refused as refused:
        return refused.message


@register_function(config_type=SubmitDraftConfig)
async def submit_draft(tool_config: SubmitDraftConfig, builder: Builder):
    yield FunctionInfo.from_fn(run_submit_draft, description=_SUBMIT_DRAFT_DESCRIPTION)


def _submittable(usage: DraftUsage) -> dict[str, str]:
    """The filing record of a draft that may be submitted, or a refusal."""
    filing = usage.filing
    if not filing.get(FILED_DOCUMENT_KEY):
        raise _Refused(
            "Fehler: Dieser Entwurf liegt noch nicht im Projekt, es gibt also nichts einzureichen. "
            "Zuerst `file_draft` aufrufen."
        )
    if filing.get(FILED_STATE_KEY) not in REPLACEABLE_STATES:
        raise _Refused(
            "Fehler: Dieser Entwurf wurde bereits eingereicht. Sage der Nutzerin, dass er auf die "
            "Freigabe durch eine Person wartet."
        )
    return filing
