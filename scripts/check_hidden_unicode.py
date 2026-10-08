#!/usr/bin/env python3
"""Refuse invisible and bidi-control characters in committed text.

Why this exists
---------------

A zero-width space or a bidi override type-checks, builds and renders as
nothing. It shows up as a failure that looks like a bug in the code around it:
a grep finds nothing in a line that plainly contains the string, a lookup key
misses, a regex never matches. Nine files carried one before this check
existed (a BOM before CSV output, a zero-width space in a sanitiser table), and
each of them read as the defect it was.

The house spelling is the escape, `\\u200B` in code or `\\uFEFF` for a byte-order
mark. It means the same value and a reviewer can read it, so the check asks for
the escape rather than the raw character.

What it checks
--------------

Each file named on the command line, read as UTF-8. A character in FORBIDDEN is
an error wherever it appears, except a byte-order mark as the first character of
a file, which is the encoding marker a CSV that Excel opens needs. The zero-width
joiner and non-joiner are not forbidden: they carry meaning in emoji sequences
and in Indic and Persian text. Binary files and non-UTF-8 files are skipped.
"""

import sys
from pathlib import Path

BYTE_ORDER_MARK = 0xFEFF

FORBIDDEN = {
    0x200B,  # zero-width space
    0x2060,  # word joiner
    BYTE_ORDER_MARK,  # zero-width no-break space, allowed only at offset 0
    *range(0x202A, 0x202F),  # bidi embeddings and overrides
    *range(0x2066, 0x206A),  # bidi isolates
}


def find_hidden(text: str) -> list[tuple[int, int, int]]:
    """Return (line, column, code point) for each forbidden character."""
    hits = []
    for index, char in enumerate(text):
        code = ord(char)
        if code not in FORBIDDEN or (code == BYTE_ORDER_MARK and index == 0):
            continue
        line = text.count("\n", 0, index) + 1
        column = index - text.rfind("\n", 0, index)
        hits.append((line, column, code))
    return hits


def main(paths: list[str]) -> int:
    failures = 0
    for name in paths:
        if not Path(name).is_file():  # a deleted path, as `git ls-files` lists it
            continue
        raw = Path(name).read_bytes()
        if b"\x00" in raw[:8192]:
            continue
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            continue
        for line, column, code in find_hidden(text):
            print(f"{name}:{line}:{column}: U+{code:04X} is invisible; write the escape \\u{code:04X} instead")
            failures += 1
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
