"""The one way an agent receives its tools from the NAT builder.

Every agent used to resolve its tools with its own copy of
``builder.get_tools(...)`` plus an ``exclude_tools`` filter. This is that copy,
once, and the place where what a model sends is made to fit what a tool
declares before the tool's schema sees it.

What arrives from the model is not always what the schema asks for: providers
send ``""`` for an optional argument they mean to leave out. A tool that
declares ``page: int = 1`` then rejects the call with ``int_parsing`` (#656),
the agent spends a round being told to fix the arguments, and the next tool with
an ``int`` parameter repeats it (``read_passage`` was fixed alone on 2026-09-15;
``ris_search`` failed the same way a week later). Here a blank string for a
field that cannot hold a string counts as omitted, so the tool's default
applies, for every tool an agent loads.
"""

from __future__ import annotations

from collections.abc import Iterable
from functools import cache
from typing import Any

from pydantic import BaseModel
from pydantic import TypeAdapter
from pydantic import model_validator

_MARKER = "__grid_blank_is_omitted__"


@cache
def _holds_a_string(annotation: Any) -> bool:
    """True when ``""`` is a valid value for the annotation, so a blank is the model's real answer."""
    try:
        TypeAdapter(annotation).validate_python("")
    except Exception:  # noqa: BLE001 - any refusal means "not a string field"
        return False
    return True


def _blank(value: Any) -> bool:
    return isinstance(value, str) and not value.strip()


def blank_is_omitted(schema: type[BaseModel]) -> type[BaseModel]:
    """``schema`` with a blank string dropped from every field that cannot hold one.

    The JSON schema the model is shown is unchanged; only validation differs.
    A dropped required field still fails, as "field required", which is the
    true complaint.
    """
    if getattr(schema, _MARKER, False):
        return schema
    fields = frozenset(name for name, field in schema.model_fields.items() if not _holds_a_string(field.annotation))
    if not fields:
        return schema

    def _drop_blanks(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        return {key: value for key, value in data.items() if not (key in fields and _blank(value))}

    lenient = type(
        schema.__name__,
        (schema,),
        {
            "__module__": schema.__module__,
            "__qualname__": schema.__qualname__,
            _MARKER: True,
            "_drop_blanks": model_validator(mode="before")(classmethod(_drop_blanks)),
        },
    )
    return lenient


def tolerate_blank_arguments(tool: Any) -> Any:
    """The same tool, validating its arguments with :func:`blank_is_omitted`."""
    schema = getattr(tool, "args_schema", None)
    if isinstance(schema, type) and issubclass(schema, BaseModel):
        tool.args_schema = blank_is_omitted(schema)
    return tool


async def load_agent_tools(builder: Any, tool_refs: Iterable[Any], exclude: Iterable[str] | None = None) -> list[Any]:
    """The LangChain tools for ``tool_refs``, minus ``exclude``, each tolerating blank arguments."""
    from nat.builder.framework_enum import LLMFrameworkEnum

    tools = await builder.get_tools(tool_names=list(tool_refs), wrapper_type=LLMFrameworkEnum.LANGCHAIN)
    excluded = set(exclude or ())
    return [tolerate_blank_arguments(tool) for tool in tools if getattr(tool, "name", "") not in excluded]
