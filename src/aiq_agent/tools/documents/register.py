"""``file_draft``: the working directory's one door into the project.

Everything else under ``tools/documents/`` stays inside the conversation. This
tool is the seam: it files a draft as a draft version, and with ``submit=True``
it then submits that version for review.

**It was two tools, and the reason it is one is the sequence.** Filing and
submitting were ``file_draft`` and ``submit_draft``, and a submit was always
preceded by a filing of the same path — the second tool refused an unfiled
draft and named the first. A pair that is always called in that order is one
operation with a parameter, and every turn that carried both schemas paid for
the second on every call.

What the split protected is kept, in the parameter's shape rather than in a
second verb. **Filing and submitting are different promises to the reader.**
Filing produces a draft nobody has to look at; submitting opens an inbox item
on a named reviewer and asks a person to spend attention — and once it is
``in_review`` the draft can no longer be replaced. A boolean is exactly the
shape a model fills in from the surrounding sentence: „leg das ab und schick es
gleich rum" and „leg das ab" differ by four words. So ``submit`` defaults to
``False``, the description says that „ablegen" alone is not a request for
review, and a ``reviewer`` without ``submit=True`` is refused rather than read
as one — a name is the strongest hint a model has, and a guess from it would
mail a half-finished Aktenvermerk to a Ziviltechniker.

**Submitting a draft that has not moved since it was filed only submits.** The
store remembers which draft version was filed
(``draft_store.FILED_AT_DRAFT_VERSION_KEY``); when that is still the current
one there is nothing to file, and an ``update`` of the same bytes would only
write a second object and trip If-Match over a person's edit in the Files pane.
Every refusal the old ``submit_draft`` gave on that path is given unchanged.

There is deliberately no ``note``. The wire carries the version,
``reviewerUserIds`` and a ``reviewer`` NAME
(``internalDocumentVersionRequestSchema``) and nothing else, so a note argument
would be a parameter the API discards — a lie in the signature, and the model
would put the substance of its handover into it. ``reviewer`` is there only
because the route grew somewhere to put it.

What this module may NOT do is in ``src/aiq_agent/tools/AGENTS.md``: it echoes
the BFF-signed envelope and never signs, and the BFF decides identity and
permission. See ``filing.py`` for why.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
from typing import Any

from aiq_agent import project_context
from nat.plugin_api import Builder
from nat.plugin_api import FunctionBaseConfig
from nat.plugin_api import FunctionInfo
from nat.plugin_api import register_function

from .cards import draft_title
from .cards import emit_draft_card
from .draft_store import DRAFT_ROOT
from .draft_store import FILED_DOCUMENT_KEY
from .draft_store import FILED_HASH_KEY
from .draft_store import FILED_STATE_KEY
from .draft_store import FILED_VERSION_KEY
from .draft_store import DraftBackend
from .draft_store import DraftUsage
from .draft_store import filing_record
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

#: Bound on the reviewer name this tier puts on the wire. Not a BFF ceiling —
#: the BFF resolves the name against the project's members and a name no person
#: has is refused there — but a display name is a display name, and a model that
#: pastes half a paragraph into the argument should not have it forwarded.
MAX_REVIEWER_CHARS = 200

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

#: The one refusal both filing paths (``create`` and ``update``) reach. An open version outside
#: :data:`REPLACEABLE_STATES` — ``in_review``, ``approved`` — may not be
#: replaced by a machine: a reviewer is looking at those bytes, and the
#: transition table gives the agent no way to take them back.
_ALREADY_SUBMITTED = (
    "Fehler: Dieser Entwurf liegt bereits zur Freigabe vor und kann nicht mehr geändert werden. "
    "Sage der Nutzerin, dass eine Person ihn zuerst zurückgeben oder freigeben muss."
)


def _slug(path: str) -> str:
    """A short stable name for the idempotency reference, from the file name."""
    name = path.rsplit("/", 1)[-1]
    name = re.sub(r"\.md$", "", name, flags=re.IGNORECASE)
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or "entwurf"


def _filing_hash(conversation_id: str, path: str) -> str:
    """The browser tier's collision suffix, mirrored byte for byte.

    ``frontends/ui/src/lib/conversations/draft-filing.ts::filingReference``
    mints the same key over the same normalized path; the two tiers must agree
    or a long key files this draft beside the browser's copy as a duplicate
    document.
    """
    return hashlib.sha256(f"{conversation_id}\0{path}".encode()).hexdigest()[:8]


def filing_reference(conversation_id: str, path: str) -> str:
    """The BFF's idempotency key: ``{conversation}-{slug}``, bounded.

    Two turns of one conversation writing „Aktenvermerk" must land on ONE
    document with two versions, which is what makes this key the conversation's
    and not the turn's.

    Past :data:`MAX_REF_CHARS` the tail is replaced by a hash of
    ``conversation_id\\0normalized_path`` rather than truncated: two long keys
    sharing a prefix would otherwise collapse onto one reference and file two
    documents as one. The browser truncates the same way, over the same
    normalized path — changing either side alone re-opens the duplicate.
    """
    normalized = path.strip().lstrip("/")
    raw = f"{conversation_id}-{_slug(normalized)}"
    if len(raw) <= MAX_REF_CHARS:
        return raw
    suffix = f"-{_filing_hash(conversation_id, normalized)}"
    return f"{raw[: MAX_REF_CHARS - len(suffix)]}{suffix}"


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


#: The generic refusal of a lifecycle call, ``{error}`` being the transport's
#: sentence. True of every call that has not yet put bytes into the project in
#: this invocation — a filing, and the submit of a draft filed in an earlier one.
_CALL_FAILED = (
    "Fehler beim Ablegen: {error}. Es wurde nichts abgelegt; sage der Nutzerin, dass der Entwurf im "
    "Arbeitsordner liegt."
)

#: The same refusal for a submit that follows a filing of THIS call, where
#: „nothing was filed" would be false: the bytes are in the project, the review
#: round is not.
_SUBMIT_FAILED_AFTER_FILING = (
    "Fehler beim Einreichen: {error}. Sage der Nutzerin, dass der Entwurf als ENTWURF im Projekt liegt, "
    "aber nicht eingereicht ist."
)


async def _post(
    payload: dict[str, Any],
    envelope: SignedEnvelope,
    *,
    bad_request: str | None = None,
    failure: str = _CALL_FAILED,
) -> dict[str, Any]:
    """The blocking call, off the event loop, with the refusal already worded.

    ``bad_request`` is the sentence a ``400`` gets instead of the generic one.
    It exists for exactly one caller: a submit that NAMED a reviewer, where the
    only validation the BFF can fail is resolving that name against the
    project's members. The generic wording („Fehler beim Ablegen") would send
    the model looking for a filing problem the reader could not act on, when
    what happened is that nobody in the project is called that.

    ``failure`` is the generic wording, with ``{error}`` for the transport's
    sentence; see :data:`_SUBMIT_FAILED_AFTER_FILING` for the one other.
    """
    try:
        return await asyncio.to_thread(post_document_version, payload, envelope)
    except FilingError as exc:
        if bad_request is not None and exc.status == 400:
            raise _Refused(bad_request) from exc
        raise _Refused(failure.format(error=exc)) from exc


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
    filing = filing_record(body)
    # The reference was already filed — a retried turn, or a working directory
    # that lost its mapping (a restart with an in-memory store). The item comes
    # back and NO version was written, so the bytes standing in the project are
    # the OLD ones; saying "filed" here would be true and misleading. Replace
    # them, using the hash the route just told us.
    if not body.get("alreadyFiled"):
        return filing
    if filing[FILED_STATE_KEY] not in REPLACEABLE_STATES:
        # And where the standing version may NOT be replaced, the same sentence
        # `_refile` says. Returning the record here would end the turn on „Im
        # Projekt abgelegt" for a call that wrote nothing at all: the reader is
        # told their revision is in the project, the reviewer is still holding
        # the old bytes, and neither of them finds out.
        raise _Refused(_ALREADY_SUBMITTED)
    return await _update(usage, filing, envelope)


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
    return filing_record(body)


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
    "Aufrufen, wenn die Nutzerin darum bittet („leg das ins Projekt“, „abspeichern“, „ablegen“), "
    "nicht von selbst nach jedem Schreiben. "
    "Ein zweiter Aufruf für denselben Pfad ersetzt den Inhalt desselben Entwurfs, es entsteht kein "
    "zweites Dokument. Abgelegt wird ein ENTWURF: niemand hat ihn freigegeben, er ist nicht "
    "veröffentlicht und wird nicht durchsucht. "
    "`submit=true` reicht den Entwurf danach ZUR FREIGABE ein: Er geht in die Prüfung und erscheint im "
    "Posteingang der Prüfenden. Ist er schon abgelegt und seither unverändert, wird nur eingereicht. "
    "Nur mit `submit=true` aufrufen, wenn die Nutzerin um Freigabe, Prüfung oder Weitergabe bittet — "
    "„ablegen“ allein ist keine solche Bitte. Das Einreichen kostet eine Person Aufmerksamkeit, und der "
    "Entwurf lässt sich danach nicht mehr ändern. "
    "`reviewer` gilt nur zusammen mit `submit=true` und ist optional: die Person, die prüfen soll, genau "
    "so genannt, wie die Nutzerin sie genannt hat (Name oder E-Mail) — DIESE Ausführung kennt die "
    "Projektmitglieder nicht und prüft den Namen nicht; aufgelöst wird er beim Einreichen gegen die "
    "Mitglieder des Projekts. Deshalb nur ausfüllen, wenn die Nutzerin die Person selbst genannt hat, "
    "und den Namen unverändert übernehmen. Ohne `reviewer` geht der Entwurf an die Bearbeiter des "
    "Projekts. Auch nach dem Einreichen ist das Dokument NICHT freigegeben: Es wartet auf die Freigabe "
    "durch eine Person."
)

#: A reviewer named on a call that does not submit. Refused before anything is
#: filed, rather than read as a request to submit: see the module docstring.
_REVIEWER_WITHOUT_SUBMIT = (
    "Fehler: `reviewer` gilt nur zusammen mit `submit=true`. Es wurde nichts abgelegt. Hat die Nutzerin "
    "um Freigabe oder Prüfung gebeten, erneut mit `submit=true` aufrufen; sonst ohne `reviewer`."
)


class FileDraftConfig(FunctionBaseConfig, name="file_draft"):
    """Configuration for the ``file_draft`` tool."""


async def _refile(usage: DraftUsage, envelope: SignedEnvelope) -> dict[str, str]:
    """A path this conversation has filed before: replace the open version's bytes."""
    if usage.filing.get(FILED_STATE_KEY, "") not in REPLACEABLE_STATES:
        raise _Refused(_ALREADY_SUBMITTED)
    return await _update(usage, usage.filing, envelope)


def _submit_payload(filing: dict[str, str], reviewer: str) -> dict[str, Any]:
    """The submit body: the version, and at most the NAME of a person.

    ``reviewerUserIds`` stays empty and ``reviewer`` carries the name as the
    user said it, because this tier has no member roster — the same reason
    `propose_file_change` forwards a name instead of resolving one. The BFF
    matches it against the project's members; a name nobody has comes back 400
    and never as a guess. Without one the route submits to the project's
    EDITORS, which is what the tool's own sentence has to say.
    """
    payload: dict[str, Any] = {
        "op": "submit",
        "documentId": filing[FILED_DOCUMENT_KEY],
        "versionId": filing[FILED_VERSION_KEY],
        "reviewerUserIds": [],
    }
    if reviewer:
        payload["reviewer"] = reviewer
    return payload


def _unknown_reviewer(reviewer: str) -> str:
    return (
        f"Ich kenne keine Person namens „{reviewer}“ in diesem Projekt. Es wurde nichts eingereicht. "
        "Frage die Nutzerin nach dem genauen Namen oder der E-Mail-Adresse, oder reiche ohne Namen ein "
        "— dann geht der Entwurf an die Bearbeiter des Projekts."
    )


def _whom(reviewer: str) -> str:
    return f"an {reviewer}" if reviewer else "an die Bearbeiter des Projekts"


def _submittable(filing: dict[str, str]) -> dict[str, str]:
    """The filing record of a version that may be submitted, or a refusal.

    Only the state is checked: both callers hold a record that names a
    document — the unchanged path by definition, the other because it just
    filed one.
    """
    if filing.get(FILED_STATE_KEY) not in REPLACEABLE_STATES:
        raise _Refused(
            "Fehler: Dieser Entwurf wurde bereits eingereicht. Sage der Nutzerin, dass er auf die "
            "Freigabe durch eine Person wartet."
        )
    return filing


async def _submit(
    backend: DraftBackend,
    path: str,
    filing: dict[str, str],
    reviewer: str,
    envelope: SignedEnvelope,
    *,
    failure: str = _CALL_FAILED,
) -> dict[str, str]:
    """Submit the filed version, remember its new state, and return that record."""
    body = await _post(
        _submit_payload(_submittable(filing), reviewer),
        envelope,
        bad_request=_unknown_reviewer(reviewer) if reviewer else None,
        failure=failure,
    )
    submitted = filing_record(body)
    await backend.arecord_filing(path, submitted)
    return submitted


async def _submit_unchanged(
    backend: DraftBackend, path: str, usage: DraftUsage, reviewer: str, envelope: SignedEnvelope
) -> str:
    """``submit=True`` on a draft the project already holds: submit, and nothing else."""
    # The draft is already in the project, so a failed submit must not say
    # „nothing was filed" (`_CALL_FAILED`): only the review round failed.
    submitted = await _submit(
        backend, path, usage.filing, reviewer, envelope, failure=_SUBMIT_FAILED_AFTER_FILING
    )
    emit_draft_card(path=path, content=usage.content or "", version=usage.version or 1, filing=submitted)
    return (
        f"Zur Freigabe {_whom(reviewer)} eingereicht: „{draft_title(path, usage.content or '')}“ wartet jetzt "
        f"auf die Prüfung durch eine Person. {_STILL_A_DRAFT}"
    )


async def _file(path: str, title: str, *, submit: bool, reviewer: str) -> str:
    """The whole of ``file_draft``, with every refusal raised where it is found."""
    _project_or_refuse()
    envelope = _envelope()
    named = " ".join((reviewer or "").split())[:MAX_REVIEWER_CHARS]
    if named and not submit:
        raise _Refused(_REVIEWER_WITHOUT_SUBMIT)
    backend, usage = await _draft(path)
    if submit and usage.filed_unchanged:
        return await _submit_unchanged(backend, path, usage, named, envelope)

    chosen = " ".join((title or "").split())[:MAX_TITLE_CHARS] or draft_title(path, usage.content or "")
    filing = (
        await _refile(usage, envelope)
        if usage.filing.get(FILED_DOCUMENT_KEY)
        else await _create(path, usage, chosen, envelope)
    )
    await backend.arecord_filing(path, filing, draft_version=usage.version)

    def _card(record: dict[str, str]) -> None:
        emit_draft_card(path=path, content=usage.content or "", version=usage.version or 1, filing=record, title=chosen)

    if not submit:
        _card(filing)
        return (
            f"Im Projekt abgelegt: „{chosen}“. {_STILL_A_DRAFT} "
            "Zur Freigabe einreichen kann derselbe Aufruf mit `submit=true`, wenn die Nutzerin darum bittet."
        )
    try:
        submitted = await _submit(backend, path, filing, named, envelope, failure=_SUBMIT_FAILED_AFTER_FILING)
    except _Refused as refused:
        # The filing stands, so the card and the sentence both say so: the
        # model must not tell the reader nothing happened, nor that it went out.
        _card(filing)
        raise _Refused(f"Im Projekt abgelegt: „{chosen}“ — aber NICHT eingereicht. {refused.message}") from refused
    _card(submitted)
    return (
        f"Im Projekt abgelegt und zur Freigabe {_whom(named)} eingereicht: „{chosen}“ wartet jetzt auf die "
        f"Prüfung durch eine Person. {_STILL_A_DRAFT}"
    )


async def run_file_draft(
    path: str,
    title: str | None = None,
    submit: bool = False,
    reviewer: str | None = None,
) -> str:
    """File one working-directory draft into the project, and submit it for review when asked.

    ``reviewer`` is a display name or an email exactly as the user said it,
    valid only with ``submit``. It is never resolved here — see
    :func:`_submit_payload` — and an empty one means the BFF submits to the
    project's editors.

    Module-level, and the tool below is a one-line wrapper around it, so the
    refusal paths are reachable by a test without going through NAT's
    generator — the refusals are most of what this tool is.
    """
    try:
        return await _file(path, title or "", submit=submit, reviewer=reviewer or "")
    except _Refused as refused:
        return refused.message


@register_function(config_type=FileDraftConfig)
async def file_draft(tool_config: FileDraftConfig, builder: Builder):
    yield FunctionInfo.from_fn(run_file_draft, description=_FILE_DRAFT_DESCRIPTION)
