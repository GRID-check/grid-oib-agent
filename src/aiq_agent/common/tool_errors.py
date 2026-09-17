"""How a failed tool call is written for the model that has to fix it.

A tool failure reaches the model as the text of a ``ToolMessage``, so that text
is the whole of what the turn can act on — and what anything reading tool
results is handed. Two properties matter. It names each problem in one clause,
because an argument the model cannot see it got wrong is one it retries
unchanged. And it carries no URL: pydantic appends
``https://errors.pydantic.dev/...`` to every error it renders, and a URL in a
tool result used to register as a web source, so the Herleitung showed a source
card for a host nobody had searched.
"""

from __future__ import annotations

from pydantic import ValidationError

#: The host pydantic links to from every rendered error.
_PYDANTIC_DOCS_HOST = "errors.pydantic.dev"

#: Longest rejected value echoed back; past it the value is the model's own
#: argument to look up, not something worth spending the message on.
_MAX_INPUT_CHARS = 60


def render_tool_error(exc: Exception) -> str:
    """The text a failed tool call returns: the problems, then what to do about them.

    Annotated ``Exception`` rather than ``BaseException`` on purpose:
    ``ToolNode`` reads this annotation to decide which exceptions it may hand
    the handler (``langgraph.prebuilt.tool_node._infer_handled_types``) and
    raises on a type that is not an ``Exception`` subclass.
    """
    if _validation_error(exc) is None:
        return f"Error: {render_error_detail(exc)}"
    return f"Error: the call was rejected. {render_error_detail(exc)}. Fix the arguments and call again."


def render_error_detail(exc: BaseException) -> str:
    """The problems alone, for a caller whose own sentence already frames them.

    One clause per rejected field for a validation failure, the exception's own
    message otherwise. Never a traceback and never a documentation link.
    """
    validation = _validation_error(exc)
    if validation is None:
        return f"{type(exc).__name__}: {_without_pydantic_links(str(exc))}"
    return "; ".join(_clauses(validation)) or "the arguments did not match the tool's schema"


def _validation_error(exc: BaseException) -> ValidationError | None:
    """The validation failure this exception is about, unwrapped.

    ``ToolNode`` wraps the ``ValidationError`` raised by argument validation in
    a ``ToolInvocationError`` that restates it, so the wrapper is asked for the
    original before its own message is used.
    """
    if isinstance(exc, ValidationError):
        return exc
    source = getattr(exc, "source", None)
    return source if isinstance(source, ValidationError) else None


def _clauses(exc: ValidationError) -> list[str]:
    """One ``<field>: <problem>`` per rejected entry, with the value when it is short.

    An entry with no location (a union tag that matches nothing) is about the
    call and not about a field, so it states the problem alone.
    """
    clauses: list[str] = []
    for error in exc.errors():
        location = ".".join(str(part) for part in error.get("loc", ()))
        problem = f"{error.get('msg', 'invalid')}{_got(error.get('input'))}"
        clauses.append(f"{location}: {problem}" if location else problem)
    return clauses


def _got(value: object) -> str:
    """The rejected value in parentheses, or nothing when it is not a short scalar."""
    if value is None or not isinstance(value, (str, int, float, bool)):
        return ""
    shown = repr(value)
    return f" (got {shown})" if len(shown) <= _MAX_INPUT_CHARS else ""


def _without_pydantic_links(text: str) -> str:
    """The message with every line that points at pydantic's error index dropped."""
    kept = [line for line in text.splitlines() if _PYDANTIC_DOCS_HOST not in line]
    return " ".join(line.strip() for line in kept if line.strip())
