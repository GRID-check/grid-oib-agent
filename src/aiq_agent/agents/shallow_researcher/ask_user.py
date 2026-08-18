"""``ask_user`` tool — a blocking, enumerable question the agent asks mid-turn.

The clarifier can only run on a deep turn (``chat_researcher`` routes to it
when the depth decision is ``deep``), so a shallow turn that needs to
disambiguate had exactly one move: write the question as prose and end the
turn. That is how "Welches IFC-Modell meinst du: AC20-Institute-Var-2.ifc oder
Ifc2x3_SampleCastle.ifc?" reaches the user as two filenames to retype.

This tool gives the shallow agent the clarifier's channel instead: it goes
through ``user_interaction_manager.prompt_user_input``, blocks until the answer
arrives, and hands it back as the tool result, so the agent finishes the SAME
turn with the answer in hand.

Going through the interaction manager is not incidental — it is what makes the
addressee guard, the pending-interaction registry, reconnect handling and
spectator (read-only) rendering apply for free (ADR-0032/0037). A private
channel here would re-open all four.

The blocking is the risk, so every failure is explicit: no interaction manager
bound, another prompt already outstanding, an unanswered prompt, or an
already-asked turn all return a short instruction to answer with a stated
assumption instead. A turn that hangs on a future nobody can resolve is far
worse than a prose question.
"""

from __future__ import annotations

import json
import logging
import threading
from collections import OrderedDict

from aiq_agent.common import build_human_prompt
from aiq_agent.common import extract_user_response
from nat.builder.builder import Builder
from nat.builder.context import Context
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig

logger = logging.getLogger(__name__)

MIN_OPTIONS = 2
"""Fewer than two labels is not a choice; that question belongs in the prose."""

MAX_OPTIONS = 6
"""More than six stops being the "small, enumerable set" this tool is for."""

_FALL_BACK_TO_ASSUMPTION = (
    "No question was put to the user. Answer now with the most reasonable assumption and say plainly "
    "which assumption you made, so the user can correct it in their next message."
)
"""What the agent is told whenever the prompt could not be delivered.

Never an error the model has to interpret: the useful next move is always the
same, and a model told only "failed" tends to ask the question in prose anyway
and end the turn — the exact behaviour this tool exists to replace.
"""

DECLINE_REPLIES = frozenset(
    {
        "skip",
        "egal",
        "weiss nicht",
        "weiß nicht",
        "keine ahnung",
        "keine angabe",
        "don't know",
        "dont know",
        "no idea",
        "",
    }
)
"""Replies that mean "decide for me" rather than naming a choice.

Kept literal and short: `skip` is the control word the rest of the product
already teaches (the clarifier's SKIP_COMMANDS), and the German entries are
here because this is a German-first product and "egal" is what people type.
"""

_TOOL_DESCRIPTION = """\
Ask the user ONE multiple-choice question in the middle of your answer and WAIT for their pick, then \
continue this same turn using what they chose. The user sees your question with the options as \
selectable buttons.

WHEN TO USE IT. Only when the answer genuinely cannot be given without the user choosing between a \
SMALL, ENUMERABLE set you can already see: the two IFC models in the project, the three Bundesländer \
the question could mean, the two document versions that both match. You must be able to name the \
options yourself — if you cannot list them, this is not the tool.

WHEN NOT TO USE IT — this is the default. Do NOT ask for something a search or another tool could \
establish: look it up instead, that is what the tools are for. Do NOT ask for something the project \
context already states. Do NOT ask when a good answer is possible with a stated assumption — answer, \
and say which assumption you made ("Ich gehe von Bauklasse 4 aus; für eine andere Klasse gilt …"). An \
agent that asks before answering is worse than one that answers and names its assumption, because the \
user waited and got nothing back. At most ONE ask_user per turn. Never for an open question ("welcher \
Zeitraum?") — write those as prose in your answer instead.

HOW. `question`: the whole question in the user's language, including the framing sentence; it is \
shown above the options. `options`: 2 to 6 SHORT labels, one per choice — a label, not a sentence \
("Ifc2x3_SampleCastle.ifc", not "Das Schloss-Modell, das letzte Woche hochgeladen wurde"). The user \
may also type a free-text answer or decline; you get back whatever they said, and you continue your \
answer from there."""


_MAX_TRACKED_TURNS = 1000
_asked_turns: OrderedDict[str, str] = OrderedDict()
_pending_conversations: dict[str, str] = {}
_guard_lock = threading.Lock()
"""Guards for the two "already asked" conditions.

Module-level and lock-guarded rather than a ContextVar: the tool loop binds
``parallel_tool_calls=True``, and parallel calls run in sibling asyncio tasks
that each copy the context at creation — a ContextVar set inside one is
invisible to the other, so it would guard nothing.
"""


def _claim_turn(conversation_id: str | None, turn_id: str | None) -> str | None:
    """Claim the single ask_user slot; return a refusal reason, or None on success.

    Two conditions, both of which end a live turn badly if ignored:

    * another prompt from this conversation is still outstanding — the
      transport keeps ONE pending interaction per conversation and a second
      registration overwrites the first, orphaning a future that another
      participant is looking at right now;
    * this turn already asked — the doctrine is one question per turn, and a
      loop that asks twice reads as interrogation.
    """
    if not conversation_id:
        # No conversation scope (CLI/batch): nothing to collide with, and a
        # global guard would serialize unrelated runs in the same process.
        return None
    with _guard_lock:
        if conversation_id in _pending_conversations:
            return "in_flight"
        if turn_id and _asked_turns.get(conversation_id) == turn_id:
            return "already_asked"
        _pending_conversations[conversation_id] = turn_id or ""
        if turn_id:
            _asked_turns[conversation_id] = turn_id
            _asked_turns.move_to_end(conversation_id)
            while len(_asked_turns) > _MAX_TRACKED_TURNS:
                _asked_turns.popitem(last=False)
    return None


def _release_turn(conversation_id: str | None) -> None:
    """Release the in-flight claim. Always run this, including on failure."""
    if not conversation_id:
        return
    with _guard_lock:
        _pending_conversations.pop(conversation_id, None)


def _normalize_options(options: list[str] | str | None) -> list[str]:
    """Coerce the model's ``options`` argument into a list of clean labels.

    A JSON array arriving as a string is accepted because weaker models
    stringify list arguments; failing on that would cost a turn for a
    formatting slip rather than a real mistake.
    """
    if options is None:
        return []
    if isinstance(options, str):
        text = options.strip()
        try:
            parsed = json.loads(text)
        except (json.JSONDecodeError, TypeError):
            parsed = [part for part in text.split("\n")] if "\n" in text else text.split(",")
        options = parsed if isinstance(parsed, list) else [str(parsed)]
    return [str(option).strip() for option in options if str(option).strip()]


def _is_decline(reply: str) -> bool:
    """Whether the user's reply declines to choose rather than naming a choice."""
    return reply.strip().strip(".!").lower() in DECLINE_REPLIES


class AskUserConfig(FunctionBaseConfig, name="ask_user"):
    """Configuration for the ``ask_user`` tool."""


@register_function(config_type=AskUserConfig)
async def ask_user(tool_config: AskUserConfig, builder: Builder):
    """Register the blocking ``ask_user`` interaction tool."""

    async def _ask(question: str, options: list[str] | str | None = None) -> str:
        """Put one enumerable question to the user and wait for the answer."""
        question_text = str(question or "").strip()
        if not question_text:
            return f"Error: `question` was empty. {_FALL_BACK_TO_ASSUMPTION}"

        labels = _normalize_options(options)
        if len(labels) < MIN_OPTIONS:
            return (
                f"Error: ask_user needs at least {MIN_OPTIONS} options — it is for a choice between "
                f"alternatives you can name. {_FALL_BACK_TO_ASSUMPTION}"
            )
        if len(labels) > MAX_OPTIONS:
            return (
                f"Error: ask_user takes at most {MAX_OPTIONS} options; you passed {len(labels)}. "
                f"A list that long is not a quick choice. {_FALL_BACK_TO_ASSUMPTION}"
            )

        try:
            nat_context = Context.get()
            conversation_id = nat_context.conversation_id
            turn_id = nat_context.user_message_id
            user_input_manager = nat_context.user_interaction_manager
        except Exception:
            logger.info("ask_user called with no usable NAT context", exc_info=True)
            return f"No channel to ask the user is available here. {_FALL_BACK_TO_ASSUMPTION}"

        refusal = _claim_turn(conversation_id, turn_id)
        if refusal == "in_flight":
            # Registering a second prompt would overwrite the first in the
            # transport's one-per-conversation slot, orphaning a question
            # somebody is looking at.
            logger.info("ask_user refused: a prompt is already pending for conversation %s", conversation_id)
            return f"Another question is already waiting for this conversation. {_FALL_BACK_TO_ASSUMPTION}"
        if refusal == "already_asked":
            logger.info("ask_user refused: this turn already asked a question")
            return f"You already asked the user once this turn. {_FALL_BACK_TO_ASSUMPTION}"

        try:
            prompt = build_human_prompt(question_text, labels)
            response = await user_input_manager.prompt_user_input(prompt)
        except NotImplementedError:
            # No HITL callback bound (async job runner, REST entrypoint, CLI).
            # The prompt would never be shown and the future never resolved.
            logger.info("ask_user called with no user-interaction callback bound; question dropped")
            return f"No channel to ask the user is available here. {_FALL_BACK_TO_ASSUMPTION}"
        except TimeoutError:
            logger.info("ask_user prompt expired unanswered")
            return f"The user did not answer in time. {_FALL_BACK_TO_ASSUMPTION}"
        except Exception:
            # Never propagate: an exception out of a tool aborts a turn the
            # user is watching, and the answer is still writable without this.
            logger.warning("ask_user failed to prompt the user", exc_info=True)
            return f"The question could not be delivered. {_FALL_BACK_TO_ASSUMPTION}"
        finally:
            _release_turn(conversation_id)

        answer = extract_user_response(response).strip()
        if _is_decline(answer):
            logger.info("ask_user: user declined to choose")
            return (
                "The user declined to choose. Answer now with the most reasonable assumption and say "
                "which assumption you made."
            )

        logger.info("ask_user: user answered a %d-option question", len(labels))
        # Quoted so the model treats it as the user's words rather than as an
        # instruction from the tool, and told not to re-ask.
        return f'The user answered: "{answer}". Continue your answer using this. Do not ask again this turn.'

    yield FunctionInfo.from_fn(_ask, description=_TOOL_DESCRIPTION)
