"""Revision series: which documents exist in several Fassungen, and which one is current.

The Planfred-like logic feld72 asked for (Jour fixe 2026-10-09): read the index and
the date from the name, treat only the newest Fassung as the basis, and offer the older
ones only on request. It is a SUGGESTION a person confirms, never a decision.
Offices name every revision explicitly and never overwrite one, so the name
carries it: ``EG_Grundriss_Index_C_2026-08-14.pdf``, ``A-101_C_Grundriss EG.pdf``,
``260814_Schnitt_AA_idx-B.pdf``. Nothing here changes, hides or re-files a
document; it says which one looks current.

This is the Python twin of ``frontends/ui/src/features/documents/lib/revision-series.ts``.
The same grammar runs in both, and both are held to one set of cases
(``tests/fixtures/revision_series_cases.json``), so the folder brief in the UI and the
agent's ``list_files`` cannot disagree about which Fassung is current. Change a
rule on one side and the fixture must move with it.

A name says nothing about WHAT a file is, so nothing here calls a file a plan
(CONTEXT.md, "Fassung").

Pure: no I/O, no framework.
"""

import re
from collections.abc import Callable
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Generic
from typing import Literal
from typing import TypeVar

T = TypeVar("T")

_SEP = r"[ _.\-]"
# ``re.ASCII`` on the case-insensitive patterns: JS ``/i`` without ``u`` folds only ASCII
# letters, while Python would also match the four non-ASCII look-alikes of ``[a-z]``.
_FLAGS = re.IGNORECASE | re.ASCII

# ``Index C``, ``idx-B``, ``index_a``, ``Rev. 12``, ``Rev02``, ``v3``, ``Version 2``.
_KEYWORD_INDEX = re.compile(
    rf"(^|{_SEP})(?:index|idx|ind|rev|revision|ver|version|v)\.?{_SEP}?([a-z]|[0-9]{{1,3}})(?=\Z|{_SEP})",
    _FLAGS,
)
# A bare capital letter right after a leading sheet number: ``A-101_C_Grundriss``. Case-sensitive.
_SHEET_NUMBER_LETTER = re.compile(r"^([A-Za-z]{1,3}[-_ ]?[0-9]{2,4})[ _.-]([A-Z])(?=[ _.-]\S)")
# ``2026-08-14``, ``2026_08_14``, ``20260814``, optionally after ``Stand``.
_ISO_DATE = re.compile(
    rf"(^|{_SEP})(?:stand{_SEP}*)?(20[0-9]{{2}})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12][0-9]|3[01])(?=\Z|{_SEP})",
    _FLAGS,
)
# ``14.08.2026``, optionally after ``Stand``.
_DOTTED_DATE = re.compile(
    rf"(^|{_SEP})(?:stand{_SEP}*)?(0[1-9]|[12][0-9]|3[01])\.(0[1-9]|1[0-2])\.(20[0-9]{{2}})(?=\Z|{_SEP})",
    _FLAGS,
)
# ``260814_...`` or ``..._260814``: six digits only at either end, where offices put a date.
_SHORT_DATE_START = re.compile(r"^([0-9]{2})(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])(?=[ _.-])")
_SHORT_DATE_END = re.compile(rf"{_SEP}([0-9]{{2}})(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])\Z")
_EXTENSION = re.compile(r"^(.*)\.([a-z0-9]{1,5})\Z", _FLAGS)
_DIGITS = re.compile(r"[0-9]+")
_KEY_SEPARATORS = re.compile(r"[\s_.]+")
_DASH_BEFORE_SPACE = re.compile(r"\s*-\s*(?=\s|\Z)")
_DASH_AT_WORD_START = re.compile(r"(^|\s)-\s*")
_WHITESPACE = re.compile(r"\s+")


@dataclass(frozen=True)
class RevisionIndex:
    kind: Literal["letter", "number"]
    # ``C``, ``12``: as it should be shown (letters upper-cased, numbers without leading zeros).
    value: str
    # Comparable within one kind: A=1 ... Z=26, numbers as themselves.
    rank: int


@dataclass(frozen=True)
class RevisionName:
    # What the Fassungen of one document share: the name without its index, its date and its extension.
    key: str
    index: RevisionIndex | None
    # ISO ``YYYY-MM-DD``.
    date: str | None


@dataclass(frozen=True)
class RevisionSeriesMember(Generic[T]):
    item: T
    revision: RevisionName


@dataclass(frozen=True)
class RevisionSeries(Generic[T]):
    # The series key plus the format, so a PDF and a DWG of one Fassung are not versions of each other.
    key: str
    # The revision that looks current: a suggestion, never a decision.
    current: RevisionSeriesMember[T]
    # The others, newest first.
    older: list[RevisionSeriesMember[T]]


def _split_extension(filename: str) -> tuple[str, str]:
    name = filename.strip()
    match = _EXTENSION.match(name)
    if match is None:
        return name, ""
    return match.group(1), match.group(2).lower()


def _index_of(raw: str) -> RevisionIndex:
    if _DIGITS.fullmatch(raw):
        number = int(raw)
        return RevisionIndex(kind="number", value=str(number), rank=number)
    letter = raw.upper()
    return RevisionIndex(kind="letter", value=letter, rank=ord(letter) - ord("A") + 1)


def _series_key(stem: str) -> str:
    """What is left once index and date are cut out, folded and with one space between words."""
    key = _KEY_SEPARATORS.sub(" ", stem.lower())
    key = _DASH_BEFORE_SPACE.sub(" ", key)
    key = _DASH_AT_WORD_START.sub(r"\1", key)
    return _WHITESPACE.sub(" ", key).strip()


def _cut(stem: str, match: re.Match[str], *, keep_lead: bool) -> str:
    lead = match.group(1) if keep_lead else ""
    return stem[: match.start()] + lead + " " + stem[match.end() :]


def parse_revision_name(filename: str) -> RevisionName | None:
    """What a file name says about its revision, or None when it names neither an index nor a date.

    None means the file is not part of a series.
    """
    stem, _ = _split_extension(filename)
    index: RevisionIndex | None = None
    date: str | None = None

    if match := _ISO_DATE.search(stem):
        date = f"{match.group(2)}-{match.group(3)}-{match.group(4)}"
        stem = _cut(stem, match, keep_lead=True)
    elif match := _DOTTED_DATE.search(stem):
        date = f"{match.group(4)}-{match.group(3)}-{match.group(2)}"
        stem = _cut(stem, match, keep_lead=True)
    elif match := _SHORT_DATE_START.search(stem):
        date = f"20{match.group(1)}-{match.group(2)}-{match.group(3)}"
        stem = _cut(stem, match, keep_lead=False)
    elif match := _SHORT_DATE_END.search(stem):
        date = f"20{match.group(1)}-{match.group(2)}-{match.group(3)}"
        stem = _cut(stem, match, keep_lead=False)

    if match := _KEYWORD_INDEX.search(stem):
        index = _index_of(match.group(2))
        stem = _cut(stem, match, keep_lead=True)
    elif match := _SHEET_NUMBER_LETTER.match(stem):
        index = _index_of(match.group(2))
        stem = match.group(1) + " " + stem[match.end() :]

    if index is None and date is None:
        return None
    key = _series_key(stem)
    return RevisionName(key=key, index=index, date=date) if key else None


def series_key_of(filename: str) -> str:
    """What this file name shares with the other Fassungen of its document, extension left out.

    The key of the revision parse when the name carries an index or a date; the
    folded name itself when it carries neither, because the FIRST state of a
    document usually has none (``Grundriss EG.pdf`` beside ``Grundriss EG Index B.pdf``).
    Backend only: the folder brief groups by :func:`find_revision_series`, which
    needs two different revisions, so it has no use for a bare key.
    """
    revision = parse_revision_name(filename)
    if revision is not None:
        return revision.key
    stem, _ = _split_extension(filename)
    return _series_key(stem)


def _newest_first(
    members: list[RevisionSeriesMember[T]], created_at: Callable[[T], str | None]
) -> list[RevisionSeriesMember[T]]:
    """The revisions of ONE series, newest first, by a tuple — a total order (the TS twin's ``newestFirst``).

    When every revision carries an index of the same kind, the index decides,
    then the date, then arrival. Otherwise the date decides, then the index, then
    arrival. A pairwise rule that let the index decide some pairs and the date
    others was cyclic, and the current revision then depended on the sort.
    """
    kinds = {member.revision.index.kind if member.revision.index is not None else "none" for member in members}
    index_leads = len(kinds) == 1 and "none" not in kinds

    def rank(member: RevisionSeriesMember[T]) -> int:
        return member.revision.index.rank if member.revision.index is not None else 0

    return sorted(
        members,
        key=lambda member: (
            rank(member) if index_leads else 0,
            member.revision.date or "",
            rank(member),
            created_at(member.item) or "",
        ),
        reverse=True,
    )


def _signature(revision: RevisionName) -> str:
    kind = revision.index.kind if revision.index is not None else ""
    value = revision.index.value if revision.index is not None else ""
    return f"{kind}:{value}:{revision.date or ''}"


def find_revision_series(
    items: Sequence[T],
    *,
    filename: Callable[[T], str],
    created_at: Callable[[T], str | None],
) -> list[RevisionSeries[T]]:
    """The documents that exist in more than one Fassung, each with its current one.

    A series needs at least two DIFFERENT revisions: one Fassung uploaded twice is
    a duplicate, which the upload already handles, not a version history. Grouped
    over the whole set handed in (callers pass one shelf's documents), because an
    older Fassung is often moved into an ``alt/`` folder.
    """
    groups: dict[str, list[RevisionSeriesMember[T]]] = {}
    for item in items:
        name = filename(item)
        revision = parse_revision_name(name)
        if revision is None:
            continue
        key = f"{revision.key}.{_split_extension(name)[1]}"
        groups.setdefault(key, []).append(RevisionSeriesMember(item=item, revision=revision))

    series: list[RevisionSeries[T]] = []
    for key, members in groups.items():
        if len({_signature(member.revision) for member in members}) < 2:
            continue
        ordered = _newest_first(members, created_at)
        series.append(RevisionSeries(key=key, current=ordered[0], older=ordered[1:]))
    # Code-point order, as the TS twin sorts.
    return sorted(series, key=lambda entry: entry.key)


def revision_label(revision: RevisionName) -> str:
    """How a revision reads to a person: ``Index C · 14.08.2026``, ``v3``, ``02.09.2026``."""
    parts: list[str] = []
    if revision.index is not None:
        parts.append(f"Index {revision.index.value}" if revision.index.kind == "letter" else f"v{revision.index.value}")
    if revision.date is not None:
        year, month, day = revision.date.split("-")
        parts.append(f"{day}.{month}.{year}")
    return " · ".join(parts)
