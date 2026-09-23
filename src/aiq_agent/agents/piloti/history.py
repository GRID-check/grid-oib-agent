"""Conversation history, trimmed to a token budget before it reaches a model.

The conversation graph holds the whole thread; every node that hands the
history to an agent hands it through here first, so the window a model sees is
budgeted in TOKENS rather than in messages.
"""

import json
import logging
import re
from collections.abc import Callable
from collections.abc import Sequence
from functools import lru_cache
from typing import Any

from langchain_core.messages import AIMessage
from langchain_core.messages import BaseMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import ToolMessage
from langchain_core.messages import trim_messages

logger = logging.getLogger(__name__)


@lru_cache(maxsize=1)
def _get_token_encoder():
    """Cache a tiktoken encoder, or ``None`` when it cannot be had.

    ``get_encoding`` downloads the BPE table on first use, so a missing
    package and a transport failure are both "count by heuristic instead".
    """
    try:
        import tiktoken

        return tiktoken.get_encoding("cl100k_base")
    except (ImportError, OSError) as exc:
        # "tiktoken" and "per-token" are the BPE tokenizer, not a credential;
        # `exc` is an ImportError or an OSError from the BPE-table download.
        # The rule is a keyword match on "token" in a logged string, so it
        # cannot tell the two apart -- suppressed here rather than repo-wide,
        # because it does catch real credential logging elsewhere.
        # nosemgrep: python.lang.security.audit.logging.logger-credential-leak.python-logger-credential-disclosure
        logger.warning("tiktoken unavailable (%s); history is budgeted by the 4-chars-per-token heuristic", exc)
        return None


def _encoded_len(text: str) -> int:
    encoder = _get_token_encoder()
    if encoder is None:
        # Fallback heuristic when tiktoken is unavailable: ~4 chars per token.
        return max(1, len(text) // 4)
    # A user can type "<|endoftext|>"; counting must not refuse it.
    return len(encoder.encode(text, disallowed_special=()))


def _count_message_tokens(messages) -> int:
    """Total approximate tokens across messages, for history-trim budgeting.

    ``trim_messages`` invokes this on the list it holds — BaseMessage objects
    or dict dumps — so content is pulled from either form; non-string content
    is JSON-flattened before counting. Each message adds a small fixed
    overhead for role/format framing.
    """
    return sum(_encoded_len(_message_text(message)) + 4 for message in messages)


def _message_text(message: Any) -> str:
    content = getattr(message, "content", None)
    if content is None and isinstance(message, dict):
        content = message.get("content")
    if content is None:
        return ""
    return content if isinstance(content, str) else json.dumps(content, default=str)


def trim_message_history(
    messages: list[BaseMessage],
    max_tokens: int,
    token_counter: Callable[..., int] | None = None,
) -> list[BaseMessage]:
    """Trim conversation history to a real token budget (not a message count).

    Keeps the most recent turns (``strategy="last"``), always retains system
    messages, and starts the retained window on a human turn.
    """
    return trim_messages(
        messages=[m.model_dump() for m in messages],
        max_tokens=max_tokens,
        strategy="last",
        token_counter=token_counter or _count_message_tokens,
        start_on="human",
        include_system=True,
    )


def prune_tool_results(messages: list[BaseMessage], *, keep_turns: int = 1) -> list[BaseMessage]:
    """The history with tool results kept for the last ``keep_turns`` turns only.

    A turn writes its whole transcript back to the conversation — the tool
    calls, their results, the answer — so the NEXT turn has the passages the
    last answer was written from in front of it and a follow-up („und in
    GK 4?") needs no fetch at all. Older turns keep only what was said: the
    ``ToolMessage``s go, and so does an ``AIMessage`` that was nothing but
    tool calls (a provider rejects a call with no result, so the two leave
    together); an assistant message with prose keeps its prose and drops its
    calls. A turn starts at a ``HumanMessage``; the current question is a
    turn of its own and counts.
    """
    boundaries = [i for i, m in enumerate(messages) if isinstance(m, HumanMessage)]
    if len(boundaries) <= keep_turns + 1:
        return list(messages)
    cutoff = boundaries[-(keep_turns + 1)]
    pruned: list[BaseMessage] = []
    for index, message in enumerate(messages):
        if index >= cutoff or not isinstance(message, (AIMessage, ToolMessage)):
            pruned.append(message)
            continue
        if isinstance(message, ToolMessage):
            continue
        if getattr(message, "tool_calls", None):
            prose = _prose_only(message)
            if prose is None:
                continue
            message = prose
        pruned.append(message)
    return pruned


def prose_history(messages: Sequence[BaseMessage]) -> list[BaseMessage]:
    """The messages with every tool call and tool result gone: what was said.

    For a request that must not carry the turn's calls at all, such as the
    repair rewrite, which gets the thread without the tool results.
    """
    kept: list[BaseMessage] = []
    for message in messages:
        if isinstance(message, ToolMessage):
            continue
        if isinstance(message, AIMessage) and getattr(message, "tool_calls", None):
            prose = _prose_only(message)
            if prose is None:
                continue
            message = prose
        kept.append(message)
    return kept


def _prose_only(message: AIMessage) -> AIMessage | None:
    """The message's prose with its tool calls gone, or ``None`` when it had none.

    On the Responses API the calls ALSO live in ``content``, as
    ``function_call`` blocks beside the text blocks, and langchain-openai sends
    those blocks whatever ``tool_calls`` says. Clearing ``tool_calls`` alone
    would leave a call with no result, which the provider refuses with a 400.
    """
    content = message.content
    if isinstance(content, str):
        kept: str | list = content
        text = content
    else:
        kept = [block for block in content if isinstance(block, str) or block.get("type") == "text"]
        text = "".join(block if isinstance(block, str) else str(block.get("text") or "") for block in kept)
    if not text.strip():
        return None
    return message.model_copy(update={"content": kept, "tool_calls": [], "invalid_tool_calls": []})


#: The block delimiter ``grounding_block.render_grounding_block`` writes.
_RESULT_BLOCK_RE = re.compile(r"^--- Result \d+ ---$", re.M)
_CITATION_LINE_RE = re.compile(r"^Citation: (.+)$", re.M)
#: What stands where an uncited passage stood. English like the block's own
#: header lines; it names the way back, not the text.
UNCITED_PASSAGE_NOTE = "[passage not cited by the answer; re-open with read_passage if it is needed]"


def compact_tool_results(messages: list[BaseMessage], cited_keys: set[str]) -> list[BaseMessage]:
    """The turn's tool results, cut to the passages the answer was written from.

    A retrieval result is a run of ``--- Result N ---`` blocks, each a header
    (source, page, Punkt, citation key) over a passage body. The answer cited
    some of them; the rest were read and set aside. The next turn needs the
    cited passages whole — a follow-up („und in GK 5?") is answered from them
    — and of the rest only the fact that they exist and where: the header
    stays, the body becomes one line. A heavy turn carried eight to ten
    thousand tokens of results into the next one; the cited passages are a
    fraction of that.

    With no cited key at all the turn is left as it was: an answer that cited
    nothing gives no signal about which passage mattered, and guessing would
    cut the wrong one.
    """
    if not cited_keys:
        return list(messages)
    wanted = {key.strip() for key in cited_keys}
    return [
        message.model_copy(update={"content": _compact_block(message.content, wanted)})
        if isinstance(message, ToolMessage)
        and isinstance(message.content, str)
        and _RESULT_BLOCK_RE.search(message.content)
        else message
        for message in messages
    ]


def _compact_block(content: str, wanted: set[str]) -> str:
    starts = [m.start() for m in _RESULT_BLOCK_RE.finditer(content)]
    if not starts:
        return content
    head = content[: starts[0]]
    pieces = [head]
    for index, start in enumerate(starts):
        end = starts[index + 1] if index + 1 < len(starts) else len(content)
        block = content[start:end]
        match = _CITATION_LINE_RE.search(block)
        if match is not None and match.group(1).strip() in wanted:
            pieces.append(block)
            continue
        pieces.append(_header_only(block))
    return "".join(pieces)


def _header_only(block: str) -> str:
    """The block up to its first blank line, then the note, then the trailing
    text after the body (the next block starts there, or the block's own tail)."""
    header, sep, rest = block.partition("\n\n")
    if not sep:
        return block
    # The body runs to the blank line that closes it; keep whatever follows
    # (a trailer such as the ``## Gliederung`` index belongs to the result, not
    # to one passage).
    _body, tail_sep, tail = rest.partition("\n\n")
    return f"{header}\n\n{UNCITED_PASSAGE_NOTE}\n\n{tail}" if tail_sep else f"{header}\n\n{UNCITED_PASSAGE_NOTE}\n"
