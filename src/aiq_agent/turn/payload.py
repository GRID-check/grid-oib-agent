"""What one user message states about how to answer it.

The chat socket hands the workflow the v2 ``user_message`` itself
(``wire_v2.UserMessage``): its fields are flat and typed, so nothing is parsed
out of the text. ``nat run``, ``nat eval`` and a single-shot HTTP turn hand it
the question as a plain string, which is the whole question and states nothing
else. The turn's intent (the composer's "Asking about <file>" subject) is set
from it here, once per turn, because retrieval reads the same ContextVars.
"""

from dataclasses import dataclass
from typing import NamedTuple

from aiq_agent.common import parse_data_sources
from aiq_agent.common.focus_file import get_focused_file_name
from aiq_agent.common.focus_file import get_focused_shelf
from aiq_agent.common.focus_file import set_turn_intent
from aiq_agent.common.wire_v2 import UserMessage


@dataclass(frozen=True)
class SubjectVersion:
    """The document version the composer says this turn is about.

    Additive beside the focused FILE NAME, and a different question from it.
    The name is a retrieval identity — which chunks to prefer — and it is only
    ever as good as the index: a version nobody has published has no chunks at
    all, so the focus filter matches nothing and falls open to the whole corpus
    (``sources/knowledge_layer/src/register.py``). This says WHICH version, by
    id, and what editorial state it is in, so the turn can read the bytes
    instead of hoping the index has them.

    Every field is optional and unvalidated here on purpose: it arrives from a
    client, the BFF re-checks tenancy on the read, and an incomplete triple is
    simply not a subject version.
    """

    document_id: str | None = None
    version_id: str | None = None
    state: str | None = None

    @property
    def is_open(self) -> bool:
        """Whether this names a version retrieval cannot see.

        The open states of the lifecycle (``lifecycle-types.ts``,
        ``OPEN_DOCUMENT_VERSION_STATES``). ``published`` is deliberately NOT a
        membership test that could grow a hole: anything not in this set is
        left to retrieval, which is the behaviour that already works.
        """
        return bool(self.document_id) and bool(self.version_id) and self.state in _OPEN_VERSION_STATES


#: The version states in which a document is still being worked on and therefore
#: has no chunks. Mirrors ``OPEN_DOCUMENT_VERSION_STATES`` in
#: ``frontends/ui/src/lib/documents/lifecycle-types.ts``; there is no shared
#: schema between the two, exactly as for the source kinds.
_OPEN_VERSION_STATES = frozenset({"draft", "in_review", "changes_requested"})


class TurnInputs(NamedTuple):
    """Everything one user message states about how to answer it.

    The focus fields are read back from the turn ContextVars that
    :func:`extract_turn_inputs` sets — retrieval reads the same vars, so the
    state carries exactly the (normalised) subject retrieval sees.
    """

    query_text: str
    #: None: not stated (a plain question), so every configured tool. A list,
    #: even an empty one, is the composer's selection.
    data_sources: list[str] | None
    focus_file_name: str | None
    focus_shelf: str | None
    #: The subject's open version, or an empty :class:`SubjectVersion`. NOT read
    #: back from a ContextVar like the two fields above it: nothing in retrieval
    #: consumes it, so it never becomes turn-wide state.
    subject: SubjectVersion = SubjectVersion()


def extract_turn_inputs(request: UserMessage | str) -> TurnInputs:
    """The inputs a turn is built from, with the turn's intent set for retrieval.

    Always sets the intent: a turn without a subject clears the previous
    turn's, because the ContextVars outlive one turn.

    Raises:
        TypeError: for anything but a ``UserMessage`` or a plain question.
    """
    if isinstance(request, str):
        set_turn_intent()
        return TurnInputs(request.strip(), None, None, None)
    if not isinstance(request, UserMessage):
        raise TypeError(f"A turn is asked with a v2 user_message or a plain question, not a {type(request).__name__}")
    set_turn_intent(file_name=request.focus_file_name, shelf=request.focus_shelf, source_preset=request.source_preset)
    subject = SubjectVersion(request.focus_document_id, request.focus_version_id, request.focus_version_state)
    return TurnInputs(
        request.text.strip(),
        parse_data_sources(request.data_sources),
        get_focused_file_name(),
        get_focused_shelf(),
        subject,
    )
