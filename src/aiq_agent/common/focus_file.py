"""The file the current chat turn is about.

Set from the user_message payload (``focus_file_name``) when Ask Piloti
is looking at a project file. Retrieval reads it so the user does not
have to type the filename. Absence is the old behaviour.
"""

from __future__ import annotations

from contextvars import ContextVar

_focused_file_name: ContextVar[str | None] = ContextVar("grid_focused_file_name", default=None)


def set_focused_file_name(name: str | None) -> None:
    trimmed = name.strip() if isinstance(name, str) else ""
    _focused_file_name.set(trimmed or None)


def get_focused_file_name() -> str | None:
    return _focused_file_name.get()
