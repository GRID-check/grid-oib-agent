"""Shared reading of an OpenAI-compatible chat completion that must be JSON.

Three routes here — ``generate_conversation_title``, ``feedback_digest`` and
``consistency_check`` — ask an LLM for "ONLY a JSON object" and then have to
cope with what a real model actually sends back. Each grew its own copy of that
logic and the copies disagreed about what to tolerate: the title and digest
routes recover a ``{...}`` span from surrounding prose, the consistency check
only strips a code fence (so a single line of preamble defeats it), and **none
of them survived a reply the completion-token cap cut off mid-object** — the
failure behind issue #233, where a cosmetic conversation title logged an
ERROR-severity `llm_response_malformed` three times in four hours.

What is tolerated here is deliberately bounded:

* a ```` ```json ```` fence, with or without its closing fence;
* prose before and after the object (a brace inside a string value cannot end
  the span and prose after it cannot extend it — unlike a first-``{``-to-last-
  ``}`` slice);
* a reply truncated by the token cap, repaired with **structural closers only**.

What is NOT tolerated is a reply that never contained a JSON object: a bare
title, an apology, a refusal sentence. Those still raise, because every caller
of this module fails open to something better than the model's prose — the
title route's caller keeps the provisional first-message name, the wizard saves
anyway, the digest surface shows the numbers it already has. Guessing that a
sentence is the answer would be worse than admitting we did not get one.
"""

from __future__ import annotations

import json
from typing import Any


def message_content(data: Any) -> tuple[str | None, str | None]:
    """Return ``(content, finish_reason)`` for the first choice of a completion.

    Raises ``ValueError`` when the envelope is not the shape an OpenAI-compatible
    endpoint promises. That includes OpenRouter's ``{"choices": null}`` failure
    mode, where indexing ``None[0]`` raises ``TypeError`` rather than ``KeyError``.

    ``content`` may legitimately be ``None``: a model that spends its whole
    completion budget on reasoning returns a null content. That is "no answer",
    not a broken envelope, so it is returned rather than raised — the caller
    reports it with ``finish_reason`` attached, which is what tells an operator
    whether the budget or the prompt is at fault.
    """
    try:
        choice = data["choices"][0]
        content = choice["message"]["content"]
        finish_reason = choice.get("finish_reason")
    except (KeyError, IndexError, AttributeError, TypeError) as exc:
        raise ValueError("chat completion has no usable first choice") from exc

    if content is not None and not isinstance(content, str):
        raise ValueError("message content is not text")
    return content, finish_reason if isinstance(finish_reason, str) else None


def extract_json_object(raw: str | None) -> dict:
    """Recover the JSON object from a model's reply.

    ``raw`` may be ``None`` (a null ``content``); that is simply "no object".
    Raises ``ValueError`` — of which ``json.JSONDecodeError`` is a subclass —
    when nothing usable can be recovered.
    """
    text = _strip_code_fence((raw or "").strip())
    span = _object_span(text)
    if span is None:
        raise ValueError("no JSON object in response")

    try:
        data = json.loads(span)
    except json.JSONDecodeError:
        repaired = _close_truncated(span)
        if repaired is None:
            raise ValueError("response is not valid JSON") from None
        try:
            data = json.loads(repaired)
        except json.JSONDecodeError:
            raise ValueError("response was cut off mid-object and could not be recovered") from None

    if not isinstance(data, dict):
        raise ValueError("response JSON is not an object")
    return data


def _strip_code_fence(text: str) -> str:
    """Drop a ```` ```json ... ``` ```` wrapper, closing fence optional.

    A truncated reply loses its closing fence, so an unterminated fence is
    stripped just the same rather than being treated as "not fenced".
    """
    if not text.startswith("```"):
        return text
    body = text.split("\n", 1)[1] if "\n" in text else ""
    closing = body.rfind("```")
    return (body[:closing] if closing != -1 else body).strip()


def _object_span(text: str) -> str | None:
    """The first top-level ``{...}`` span, or ``None`` when there is no ``{``.

    String-aware on purpose. ``text[text.find("{") : text.rfind("}") + 1]`` —
    what each route used to do — swallows a trailing "Hope that helps! :}" into
    the object and mis-ends on a ``}`` that lives inside a string value.

    When the object never closes, everything from the opening brace on is
    returned: that is the token-cap truncation case, which :func:`_close_truncated`
    repairs.
    """
    start = text.find("{")
    if start == -1:
        return None

    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
        elif char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start : index + 1]
    return text[start:]


def _close_truncated(span: str) -> str | None:
    """Close a span the token cap cut off mid-object; ``None`` if it was intact.

    **Structural repairs only** — terminate an open string, drop a dangling
    escape or trailing comma, and close the brackets still open. Nothing is
    invented and no value is guessed, so this can only ever recover a reply
    whose prefix was already well-formed JSON. A cut that landed on a bare key
    (``{"title":``) cannot be closed into anything valid and is deliberately
    left to fail rather than papered over.

    Recovering a title that lost its last word beats reporting a failure for a
    name the user can rewrite in two clicks; recovering a *guess* would not.
    """
    stack: list[str] = []
    in_string = False
    escaped = False
    for char in span:
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
        elif char == '"':
            in_string = True
        elif char in "{[":
            stack.append(char)
        elif char in "}]" and stack:
            stack.pop()

    if not stack and not in_string:
        return None

    repaired = span[:-1] if escaped else span
    if in_string:
        repaired += '"'
    repaired = repaired.rstrip()
    if repaired.endswith(","):
        repaired = repaired[:-1]
    return repaired + "".join("}" if opener == "{" else "]" for opener in reversed(stack))
