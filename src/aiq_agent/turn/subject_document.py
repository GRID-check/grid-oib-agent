"""Reading the turn's subject document when retrieval cannot see it.

## The hole this closes

A conversation can be ABOUT a document (``conversations.subject_resource_type``
= ``document``): „Besprechen" on a file, on a report card or on a review request
in the inbox opens one. The turn answers it from the retrieval index, and the
focus filter prefers the subject's own chunks.

Only a PUBLISHED version is ever dispatched to that index (ADR-0054). So for a
version that is still being worked on — ``draft``, ``in_review``,
``changes_requested`` — there are no chunks at all, the focus filter matches
nothing, and it falls open to the whole corpus
(``sources/knowledge_layer/src/register.py``). The reader asks „warum steht in
Abschnitt 3 GK 4?" about the Befund Piloti filed a minute ago and gets an answer
sourced from everything except that Befund — confidently, and with citations.

That fail-open is correct where it is: a filter that closed on an empty match
would turn every indexing lag into a turn that can answer nothing. The fix
belongs UPSTREAM of it, and this is it: when the composer says the subject is an
open version, the turn reads that version's own bytes and puts them where the
model already looks for text it can read in full — the conversation's working
directory.

## Why the working directory and not the prompt

Three reasons, in the order they matter.

**It is already the place.** ``ls`` / ``read_file`` / ``edit_file`` are on the
turn, the model uses them, and a draft under ``/entwuerfe/`` is a file it can
quote from and revise. Pasting the document into the prompt instead would pay
for the whole text on every LLM call of the turn, including the ones that never
mention it.

**Reading and revising are one gesture.** „Besprechen" turns into „ändere
Abschnitt 3" without a hop: the file is there, ``edit_file`` works on it, and
``file_draft`` files it back.

**Which is exactly why the filing record is stamped here.** The file is written
with the four :data:`~aiq_agent.tools.documents.draft_store.FILING_KEYS` of the
version it came from, so a later ``file_draft`` on that path takes the ``update``
branch and REPLACES this document's open version. Without them the tool would
see an unfiled draft, call ``create``, and the conversation would end with two
documents where the reader asked about one.

## What it never does

It does not touch a PUBLISHED subject. That version has chunks, the focus filter
works, and a copy in the working directory would be a second, stale answer to
"what does this document say" sitting one ``ls`` away from the real one.

It fails open, in every direction: no subject, no conversation, no organization,
an unreachable BFF, a refusal, empty bytes, a full working directory — each
costs the model one document and never the turn. That is the contract every unit
in this package works under (``AGENTS.md``), and it is why this runs inside the
setup ``asyncio.gather`` rather than in front of it.
"""

from __future__ import annotations

import asyncio
import logging
import unicodedata

from aiq_agent.cards.registry import reset_card_registry
from aiq_agent.cards.registry import set_card_registry
from aiq_agent.common.turn_status import SUBJECT_EMPTY
from aiq_agent.common.turn_status import SUBJECT_NOT_STORED
from aiq_agent.common.turn_status import SUBJECT_REFUSED
from aiq_agent.common.turn_status import SUBJECT_UNREACHABLE
from aiq_agent.common.turn_status import emit_subject_document
from aiq_agent.tools.documents.draft_store import DRAFT_ROOT
from aiq_agent.tools.documents.draft_store import FILED_DOCUMENT_KEY
from aiq_agent.tools.documents.draft_store import FILED_HASH_KEY
from aiq_agent.tools.documents.draft_store import FILED_STATE_KEY
from aiq_agent.tools.documents.draft_store import FILED_VERSION_KEY
from aiq_agent.tools.documents.draft_store import DraftBackend
from aiq_agent.tools.documents.draft_store import DraftUsage
from aiq_agent.tools.documents.draft_store import get_draft_backend
from aiq_agent.tools.documents.filing import FilingError
from aiq_agent.tools.documents.filing import get_document_version_content
from aiq_agent.turn.payload import SubjectVersion

logger = logging.getLogger(__name__)

#: Longest file name this may build, extension included. The BFF caps a document
#: name at 200 characters (``MAX_DOCUMENT_NAME_LENGTH``); this is that, minus the
#: room ``.md`` needs, so a legal name never becomes an illegal path.
MAX_NAME_CHARS = 197

#: Characters that would make the name something other than one file in one
#: directory. ``/`` is the one that matters — an agent-authored document is
#: filed under ``piloti/<id>/<name>`` and a display name is free text — and the
#: backslash and the control range ride along because a path is not the place to
#: find out which of them the store minds.
_UNSAFE = {"/", "\\", "\x00"}


def draft_path(display_name: str) -> str:
    """Where a subject document is written in the working directory.

    ``/entwuerfe/<name>.md``: the one directory the working directory has, so the
    file appears in the same ``ls`` as anything the turn writes itself, under the
    name the reader sees in the Files pane. NFC first, for the same reason
    everything else in the store is (``draft_store``): a name typed decomposed
    and the same name typed composed must not be two files.
    """
    name = unicodedata.normalize("NFC", display_name or "").strip()
    name = "".join("-" if character in _UNSAFE or character < " " else character for character in name)
    # `..` is refused by the working directory itself (`path_refusal`), so a name
    # carrying one would produce a path nothing could later write to or file —
    # a file the reader can see in `ls` and the tools cannot touch. Collapsed
    # rather than rejected: the name is a label, and „Plan .. Stand Mai" is a
    # careless name, not an attack.
    while ".." in name:
        name = name.replace("..", ".")
    name = " ".join(name.split()).strip(". ")
    for suffix in (".md", ".markdown"):
        if name.lower().endswith(suffix):
            name = name[: -len(suffix)].strip()
            break
    return f"{DRAFT_ROOT}{(name or 'dokument')[:MAX_NAME_CHARS]}.md"


def filing_record(body: dict) -> dict[str, str]:
    """The four filing keys, read out of the read route's answer.

    The same shape ``file_draft`` writes after a successful ``create`` — one
    record, one reader — so the tool's ``update`` branch finds exactly what it
    finds after a filing of its own: which document, which open version, and the
    content hash to send as ``If-Match``.
    """
    return {
        FILED_DOCUMENT_KEY: str(body.get("documentId") or ""),
        FILED_VERSION_KEY: str(body.get("versionId") or ""),
        FILED_HASH_KEY: str(body.get("contentHash") or ""),
        FILED_STATE_KEY: str(body.get("state") or ""),
    }


async def _fetch(version_id: str, organization_id: str) -> dict | None:
    """The version's body, or ``None`` with the miss already recorded."""
    try:
        return await asyncio.to_thread(get_document_version_content, version_id, organization_id)
    except FilingError as refused:
        reason = SUBJECT_REFUSED if refused.status is not None else SUBJECT_UNREACHABLE
        logger.warning("Subject version %s could not be read: %s", version_id, refused)
        emit_subject_document(loaded=False, version_id=version_id, reason=reason)
        return None


def already_loaded(usage: DraftUsage, filing: dict[str, str]) -> bool | None:
    """Is this path already this document's working copy?

    ``True`` it is and nothing has to be read; ``False`` the path is free;
    ``None`` the path is taken by something else and this load must not happen.

    **Why the file is never rewritten.** The working directory refuses to
    overwrite (that is DeepAgents' own guard, and the reason ``edit_file``
    exists), and the guard is right here for a product reason too: a subject is
    loaded once per TURN, and by turn three the model may have revised the draft
    at the reader's request. Rewriting the stored bytes over it would silently
    undo an edit they watched happen.

    So the conversation's copy wins for the life of the conversation. If the
    version's bytes moved on the server in the meantime — a reviewer replaced
    them — the divergence is not swallowed: the filing record still carries the
    content hash this copy was made from, so filing it back is an ``If-Match``
    conflict rather than an overwrite. That is what the header is for.

    **Why a foreign file is a refusal.** Two documents in one project can share
    a display name, and the path is built from that name. Reusing a path whose
    filing record names a DIFFERENT document would file one document's text as
    another's. Nothing is written, and the miss is recorded.
    """
    if usage.content is None:
        return False
    stored = usage.filing.get(FILED_DOCUMENT_KEY)
    return True if stored == filing[FILED_DOCUMENT_KEY] else None


async def _write(backend: DraftBackend, path: str, text: str, filing: dict[str, str]) -> bool:
    """Write the text and stamp the filing record. ``False`` when the store refused.

    Through the backend and not the store, so the two things that make the
    working directory what it is still apply to bytes that came from outside it:
    NFC normalisation, and the per-conversation byte ceiling. A subject bigger
    than the ceiling is refused exactly as a model-written draft would be — the
    refusal is the store's own sentence, and it lands in the log rather than in
    front of the reader, because nobody asked for this write.

    THE CARD IS SUPPRESSED, deliberately and explicitly. Every successful write
    through the backend emits a ``document_draft`` card — „Entwurf geschrieben" —
    because a write is normally something the model just did at the reader's
    request. This one is not: the reader pressed „Besprechen" on a document that
    already exists, and a card announcing a draft would be a claim about work
    nobody did. Unbinding the registry for the duration says so, rather than
    relying on the setup phase happening to run before the registry is bound.
    """
    token = set_card_registry(None)
    try:
        result = await backend.awrite(path, text)
    finally:
        reset_card_registry(token)
    if result.error:
        logger.warning("Subject document not written to %s: %s", path, result.error)
        return False
    await backend.arecord_filing(path, filing)
    return True


async def load_subject_document(
    subject: SubjectVersion,
    *,
    conversation_id: str | None,
    organization_id: str | None,
) -> str | None:
    """Put the turn's unpublished subject into the working directory.

    Returns the path it was written to, or ``None`` — which is every other case,
    including every failure. One member of the turn's setup gather; see the
    module docstring for why nothing here may raise.

    Args:
        subject: What the composer said this turn is about.
        conversation_id: Namespaces the working directory. The SAME id
            ``file_draft`` resolves (NAT's context conversation id), because the
            file this writes is the file that tool has to find.
        organization_id: The tenant the read is scoped to, from the signed
            envelope. Never from the client: the version id is the only thing
            the client chooses, and the organization is what stops it choosing
            somebody else's.
    """
    try:
        return await _load_subject_document(subject, conversation_id=conversation_id, organization_id=organization_id)
    except Exception:  # noqa: BLE001 - one document is worth strictly less than the answer
        logger.warning("Subject document load failed; the turn continues without it", exc_info=True)
        return None


async def _load_subject_document(
    subject: SubjectVersion,
    *,
    conversation_id: str | None,
    organization_id: str | None,
) -> str | None:
    # A published subject, a plain question, or a run with nowhere to put a file.
    # None of the three is a miss worth recording: nothing was expected.
    if not subject.is_open or not conversation_id or not organization_id:
        return None

    assert subject.version_id is not None  # noqa: S101 - `is_open` is the check; this is for the type
    body = await _fetch(subject.version_id, organization_id)
    if body is None:
        return None

    text = body.get("content")
    if not isinstance(text, str) or not text.strip():
        logger.info("Subject version %s has no text to read", subject.version_id)
        emit_subject_document(loaded=False, version_id=subject.version_id, reason=SUBJECT_EMPTY)
        return None

    path = draft_path(str(body.get("displayName") or body.get("filename") or ""))
    filing = filing_record(body)
    backend = await get_draft_backend(conversation_id)
    standing = already_loaded(await backend.aread(path), filing)
    if standing is None:
        logger.warning("Working-directory path %s belongs to another document; subject not read", path)
        emit_subject_document(loaded=False, version_id=subject.version_id, reason=SUBJECT_NOT_STORED)
        return None
    if standing:
        logger.debug("Subject document %s already in the working directory at %s", subject.document_id, path)
        return path
    if not await _write(backend, path, text, filing):
        emit_subject_document(loaded=False, version_id=subject.version_id, reason=SUBJECT_NOT_STORED)
        return None

    emit_subject_document(
        loaded=True,
        document_id=subject.document_id,
        version_id=subject.version_id,
        state=subject.state,
        path=path,
        chars=len(text),
    )
    logger.info("Subject document %s (%s) read into %s", subject.document_id, subject.state, path)
    return path
