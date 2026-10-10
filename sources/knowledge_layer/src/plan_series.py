"""Planstände: which plans exist in several revisions, and which revision is current.

Planfred's request (feld72, Jour fixe 2026-10-09): read the index and the date
from the name, treat only the newest Planstand as the basis, and offer the older
ones only on request. It is a SUGGESTION a person confirms, never a decision.
Offices name every revision explicitly and never overwrite one, so the name
carries it: ``EG_Grundriss_Index_C_2026-08-14.pdf``, ``A-101_C_Grundriss EG.pdf``,
``260814_Schnitt_AA_idx-B.pdf``. Nothing here changes, hides or re-files a
document; it says which one looks current.

This is the Python twin of ``frontends/ui/src/features/documents/lib/plan-series.ts``.
The same grammar runs in both, and both are held to one set of cases
(``tests/fixtures/plan_series_cases.json``), so the folder brief in the UI and the
agent's ``list_files`` cannot disagree about which Planstand is current. Change a
rule on one side and the fixture must move with it.

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
# A bare capital letter right after a leading plan number: ``A-101_C_Grundriss``. Case-sensitive.
_PLAN_NUMBER_LETTER = re.compile(r"^([A-Za-z]{1,3}[-_ ]?[0-9]{2,4})[ _.-]([A-Z])(?=[ _.-]\S)")
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
class PlanIndex:
    kind: Literal["letter", "number"]
    # ``C``, ``12``: as it should be shown (letters upper-cased, numbers without leading zeros).
    value: str
    # Comparable within one kind: A=1 ... Z=26, numbers as themselves.
    rank: int


@dataclass(frozen=True)
class PlanName:
    # What revisions of one plan share: the name without its index, its date and its extension.
    key: str
    index: PlanIndex | None
    # ISO ``YYYY-MM-DD``.
    date: str | None


@dataclass(frozen=True)
class PlanSeriesMember(Generic[T]):
    item: T
    plan: PlanName


@dataclass(frozen=True)
class PlanSeries(Generic[T]):
    # The series key plus the format, so a PDF and a DWG of one Planstand are not versions of each other.
    key: str
    # The revision that looks current: a suggestion, never a decision.
    current: PlanSeriesMember[T]
    # The others, newest first.
    older: list[PlanSeriesMember[T]]


def _split_extension(filename: str) -> tuple[str, str]:
    name = filename.strip()
    match = _EXTENSION.match(name)
    if match is None:
        return name, ""
    return match.group(1), match.group(2).lower()


def _index_of(raw: str) -> PlanIndex:
    if _DIGITS.fullmatch(raw):
        number = int(raw)
        return PlanIndex(kind="number", value=str(number), rank=number)
    letter = raw.upper()
    return PlanIndex(kind="letter", value=letter, rank=ord(letter) - ord("A") + 1)


def _series_key(stem: str) -> str:
    """What is left once index and date are cut out, folded and with one space between words."""
    key = _KEY_SEPARATORS.sub(" ", stem.lower())
    key = _DASH_BEFORE_SPACE.sub(" ", key)
    key = _DASH_AT_WORD_START.sub(r"\1", key)
    return _WHITESPACE.sub(" ", key).strip()


def _cut(stem: str, match: re.Match[str], *, keep_lead: bool) -> str:
    lead = match.group(1) if keep_lead else ""
    return stem[: match.start()] + lead + " " + stem[match.end() :]


def parse_plan_name(filename: str) -> PlanName | None:
    """What a plan name says about its revision, or None when it names neither an index nor a date.

    None means a document, not a Planstand.
    """
    stem, _ = _split_extension(filename)
    index: PlanIndex | None = None
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
    elif match := _PLAN_NUMBER_LETTER.match(stem):
        index = _index_of(match.group(2))
        stem = match.group(1) + " " + stem[match.end() :]

    if index is None and date is None:
        return None
    key = _series_key(stem)
    return PlanName(key=key, index=index, date=date) if key else None


def _newest_first(
    members: list[PlanSeriesMember[T]], created_at: Callable[[T], str | None]
) -> list[PlanSeriesMember[T]]:
    """The revisions of ONE series, newest first, by a tuple — a total order (the TS twin's ``newestFirst``).

    When every revision carries an index of the same kind, the index decides,
    then the date, then arrival. Otherwise the date decides, then the index, then
    arrival. A pairwise rule that let the index decide some pairs and the date
    others was cyclic, and the current revision then depended on the sort.
    """
    kinds = {member.plan.index.kind if member.plan.index is not None else "none" for member in members}
    index_leads = len(kinds) == 1 and "none" not in kinds

    def rank(member: PlanSeriesMember[T]) -> int:
        return member.plan.index.rank if member.plan.index is not None else 0

    return sorted(
        members,
        key=lambda member: (
            rank(member) if index_leads else 0,
            member.plan.date or "",
            rank(member),
            created_at(member.item) or "",
        ),
        reverse=True,
    )


def _signature(plan: PlanName) -> str:
    kind = plan.index.kind if plan.index is not None else ""
    value = plan.index.value if plan.index is not None else ""
    return f"{kind}:{value}:{plan.date or ''}"


def find_plan_series(
    items: Sequence[T],
    *,
    filename: Callable[[T], str],
    created_at: Callable[[T], str | None],
) -> list[PlanSeries[T]]:
    """The plans that exist in more than one revision, each with its current one.

    A series needs at least two DIFFERENT revisions: one Planstand uploaded twice is
    a duplicate, which the upload already handles, not a version history. Grouped
    over the whole set handed in (callers pass one shelf's documents), because an
    older Planstand is often moved into an ``alt/`` folder.
    """
    groups: dict[str, list[PlanSeriesMember[T]]] = {}
    for item in items:
        name = filename(item)
        plan = parse_plan_name(name)
        if plan is None:
            continue
        key = f"{plan.key}.{_split_extension(name)[1]}"
        groups.setdefault(key, []).append(PlanSeriesMember(item=item, plan=plan))

    series: list[PlanSeries[T]] = []
    for key, members in groups.items():
        if len({_signature(member.plan) for member in members}) < 2:
            continue
        ordered = _newest_first(members, created_at)
        series.append(PlanSeries(key=key, current=ordered[0], older=ordered[1:]))
    # Code-point order, as the TS twin sorts.
    return sorted(series, key=lambda entry: entry.key)


def plan_revision_label(plan: PlanName) -> str:
    """How a revision reads to a person: ``Index C · 14.08.2026``, ``v3``, ``02.09.2026``."""
    parts: list[str] = []
    if plan.index is not None:
        parts.append(f"Index {plan.index.value}" if plan.index.kind == "letter" else f"v{plan.index.value}")
    if plan.date is not None:
        year, month, day = plan.date.split("-")
        parts.append(f"{day}.{month}.{year}")
    return " · ".join(parts)
