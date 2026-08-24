"""What the model asked the spatial surface for and could not get.

The backlog for the MCP surface, written by the surface itself.

## Why this is not the trace

`measure_register._trace` sends the SHAPE of every call to Langfuse, and it is
deliberately careful about one thing (ADR-0045 §Observability): an operation the
model invented is recorded as ``unknown`` rather than echoed, because free text
out of a language model has no business reaching an external observability
service.

That rule is right, and it throws away the single most useful signal we have.
When a model asks for ``measure: "wandstaerke"`` it is not making a mistake in
the ordinary sense — it is telling us, in one word, that somebody wanted a wall
thickness and this surface has no operator for it. `unknown` records that a
miss happened. It cannot tell us what to build.

So the vocabulary is kept HERE instead: in full, locally, in a file.

## And a miss is an ERROR, because an error becomes an issue

Runtime logs ship to the OTLP collector, and an ERROR there is what turns into
a tracked issue. A missing tool should be one: nobody reads a local JSONL file
on a schedule, and a backlog nobody reads is not a backlog.

What leaves the process is narrower than what is written. Only a NAME-shaped
value is exported — anything else becomes a placeholder and the real text stays
in the ledger — and each distinct miss is escalated ONCE per process, under a
ceiling. Without those three the feature is a spam generator: the error is the
issue, so the hundredth retry of one bad name would be the hundredth issue.

## The distinction this module exists to draw

The engine already has a well-defined way of saying „I cannot answer that", and
**most of those are not gaps in our surface**:

- ``decidable: false`` — the question was well formed and THIS EXPORT cannot
  answer it. A finding about the architect's file. Not ours, and recording it
  as a capability gap would bury the real ones under thousands of rows.
- an unknown GlobalId, or a measure asked of the wrong kind of element — the
  caller made a mistake it can correct in the same turn. Not ours either.
- **a name that is not in any of our vocabularies** — the caller wanted
  something this surface does not have. *That* is ours, and it is what gets
  written here.

The third case is narrow on purpose. A ledger that logs every refusal is a log
nobody reads; a ledger that logs only „you asked for a thing that does not
exist" is a list of features, ranked by how often somebody wanted them.

## What is written, and what is refused

One JSON object per line: when, which surface, which field, the value asked
for, and the closed set it was checked against. Nothing else — specifically no
GlobalId, no element or storey name, no measured value, no file name, and no
project or organisation id. The asked-for value is the one piece of model-authored
text here; it is truncated, kept on one line, and never leaves the machine.

Failures to write are swallowed. A full disk or a read-only mount must never
turn a working measurement into an error — this ledger is a convenience for us
and the architect's answer is the product.
"""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
import threading
import time
from collections import Counter
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


def default_path() -> Path:
    """Where the ledger lives when nothing overrides it.

    A path rather than a database because the thing that reads it is a person,
    once a sprint, and `sort | uniq -c` is a fine query language for a list of
    missing features.

    NOT a predictable name in shared `/tmp`, which is where this started. That
    directory is world-writable, so any local user can pre-create the exact name
    — as a file, to read the model-authored requests that land in it, or as a
    symlink, to make this process append JSON to something else it can write.
    An application-owned state directory has neither property.

    `/tmp` remains the fallback for a container with no writable home, and there
    the directory is ours and created `0o700` rather than the file being dropped
    beside everyone else's.
    """
    state = os.environ.get("XDG_STATE_HOME")
    if state:
        return Path(state) / "aiq" / "capability-gaps.jsonl"
    home = Path.home()
    if str(home) not in ("", "/") and os.access(home.parent if not home.exists() else home, os.W_OK):
        return home / ".local" / "state" / "aiq" / "capability-gaps.jsonl"
    return Path(tempfile.gettempdir()) / f"aiq-{os.getuid()}" / "capability-gaps.jsonl"


#: How much of a model-authored value is kept. Long enough to name a
#: measurement, short enough that a model which pastes a paragraph into the
#: field cannot fill a disk with it.
MAX_VALUE_CHARS = 120

#: Beyond this the ledger stops accepting rows.
#:
#: An agent in a retry loop against a name that does not exist can write the
#: same row hundreds of times a minute, and the failure mode of an unbounded
#: append-only file on a shared box is everyone else's outage. The ledger is
#: advisory; the cap protects the thing that is not.
MAX_BYTES = 8 * 1024 * 1024

#: A value shaped like a NAME, which is the only shape that leaves this process.
#:
#: The ledger keeps whatever the model wrote; the OTLP record does not. A miss
#: is nearly always one identifier — „wandstaerke", „uWert", „schallschutz" —
#: and anything that is not is likelier to be a paste than a feature request.
#: German letters are in the class because the vocabulary this surface refuses
#: is German.
_NAME_SHAPED = re.compile(r"^[\w .\-]{1,60}$", re.UNICODE)

#: What is exported instead when the value is not name-shaped. The full text
#: stays in the local ledger, which is where somebody triaging can read it.
UNEXPORTABLE = "<nicht exportierbar>"

_LOCK = threading.Lock()

#: (surface, field, value) already reported as an error in THIS process.
#:
#: The error is the issue, so this set is the difference between a backlog and
#: an inbox nobody can use. An agent retrying a name that does not exist calls
#: `record_gap` on every attempt, and without dedup each one is another
#: identical issue. The ledger still counts every occurrence — that count is
#: what ranks the backlog — and only the FIRST of each distinct miss is
#: escalated.
_ESCALATED: set[tuple[str, str, str]] = set()

#: Beyond this the process stops escalating anything new.
#:
#: A model that invents a fresh word every turn would defeat the dedup above by
#: never repeating itself. This is the backstop: past it the ledger keeps
#: recording and the alerting goes quiet, which is the right way round — a
#: capability backlog is worth having, and a pager that fires all night is not.
MAX_ESCALATIONS = 50


def ledger_path() -> Path:
    """The ledger in use. The env var is a TRUSTED deployment override —
    a path an operator chose, not one a request can influence."""
    override = os.environ.get("AIQ_CAPABILITY_GAP_LOG")
    return Path(override) if override else default_path()


def _clean(value: Any) -> str:
    """A model-authored value, made safe to keep on one line of a log file.

    Newlines out because the format is one JSON object per line and a value
    carrying one would still be valid JSON but would defeat `tail`/`grep` for
    whoever reads this; control characters out because this file is read in a
    terminal.
    """
    text = str(value or "").strip()
    text = "".join(character for character in text if character.isprintable())
    return text[:MAX_VALUE_CHARS]


def record_gap(*, surface: str, field: str, asked_for: Any, known: Any = ()) -> None:
    """Note that the caller wanted a name this surface does not have.

    Call this ONLY for the third case in the module docstring — a value that is
    in no vocabulary. Not for `decidable: false`, which is a finding about the
    export, and not for a wrong GlobalId, which the caller can fix itself.
    """
    value = _clean(asked_for)
    if not value:
        # „the model sent nothing" is a bug in the caller, not a feature request.
        return
    row = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "surface": surface,
        "field": field,
        "askedFor": value,
        "known": sorted(str(name) for name in known),
    }
    try:
        path = ledger_path()
        with _LOCK:
            if path.exists() and path.stat().st_size >= MAX_BYTES:
                return
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            # `O_NOFOLLOW` so a symlink sitting on the final component is an
            # error rather than a redirect, and `0o600` so the file is not
            # readable by other local users — the values in it are whatever a
            # language model wrote. `Path.open("a")` gives neither: it follows
            # the link and takes its mode from the umask.
            handle = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
            try:
                os.write(handle, (json.dumps(row, ensure_ascii=False) + "\n").encode("utf-8"))
            finally:
                os.close(handle)
    except Exception:  # noqa: BLE001 — see the module docstring
        logger.debug("the capability-gap ledger could not be written", exc_info=True)

    _escalate(surface=surface, field=field, value=value, known=row["known"])


def _escalate(*, surface: str, field: str, value: str, known: list[str]) -> None:
    """Report the miss as an ERROR, so it becomes an issue.

    Runtime logs ship to the OTLP collector (`observability/otlp_logging_method`),
    and an ERROR there is what turns into a tracked issue. A missing tool is
    exactly the thing that should: nobody is going to read a local JSONL file on
    a schedule, and the whole point of the ledger is that somebody acts on it.

    Three things keep it from becoming noise, and they are the design:

    1. **Once per distinct miss per process.** The error IS the issue, so the
       hundredth retry of one bad name must not be the hundredth issue. The
       ledger still counts every occurrence; only the first is escalated.
    2. **A ceiling.** A model inventing a new word every turn would slip past
       the dedup by never repeating itself. Past `MAX_ESCALATIONS` the ledger
       keeps recording and this goes quiet — a backlog that grows is fine, a
       pager that fires all night is not.
    3. **Only a name-shaped value leaves the process.** ADR-0045 keeps
       model-authored text out of external observability, and `_trace` honours
       that by recording an invented operation as `unknown`. The compromise here
       is narrower than either: a value that looks like an identifier is what an
       issue needs to be actionable and is not building data, and anything else
       is replaced by a placeholder with the real text left in the local ledger.

    Failures are swallowed for the same reason the ledger's are: this must never
    turn a working measurement into an error the architect sees.
    """
    key = (surface, field, value)
    try:
        with _LOCK:
            if key in _ESCALATED or len(_ESCALATED) >= MAX_ESCALATIONS:
                return
            _ESCALATED.add(key)
        exportable = value if _NAME_SHAPED.match(value) else UNEXPORTABLE
        logger.error(
            "ifc spatial surface: no %s named %r — a caller wanted a capability this surface does not have",
            field,
            exportable,
            extra={
                "ifc_capability_gap": True,
                "ifc_gap_surface": surface,
                "ifc_gap_field": field,
                "ifc_gap_asked_for": exportable,
                # The closed set, so whoever picks up the issue can see what was
                # offered instead without opening the repository.
                "ifc_gap_known": ", ".join(known),
            },
        )
    except Exception:  # noqa: BLE001
        logger.debug("the capability gap could not be escalated", exc_info=True)


def reset_escalations_for_tests() -> None:
    _ESCALATED.clear()


def read_gaps(path: Path | None = None) -> list[dict[str, Any]]:
    """Every row, oldest first. Unreadable lines are skipped, not raised."""
    target = path or ledger_path()
    if not target.exists():
        return []
    rows: list[dict[str, Any]] = []
    for line in target.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def summarise(path: Path | None = None) -> list[dict[str, Any]]:
    """The ledger as a ranked backlog: what was wanted, and how often.

    Ranked by count because that is the only ordering that answers the question
    somebody opens this file to ask — „what do we build next" — and a bare log
    read newest-first answers „what happened last", which is a different
    question nobody has.
    """
    counts: Counter[tuple[str, str, str]] = Counter()
    last_seen: dict[tuple[str, str, str], str] = {}
    for row in read_gaps(path):
        key = (str(row.get("surface", "")), str(row.get("field", "")), str(row.get("askedFor", "")))
        counts[key] += 1
        last_seen[key] = str(row.get("at", ""))
    return [
        {"surface": surface, "field": field, "askedFor": asked, "count": count, "lastSeen": last_seen[key]}
        for key, count in counts.most_common()
        for surface, field, asked in [key]
    ]


def render_report(path: Path | None = None) -> str:
    """The backlog as text a person can paste into an issue.

    Deliberately a report and not an API call. Filing an issue is an outward
    action with somebody else's notifications on the other end of it, and a
    surface that opens one automatically the first time a model invents a word
    would be a spam generator. This produces the body; a human decides.
    """
    rows = summarise(path)
    if not rows:
        return "Keine Lücken erfasst — jede Anfrage traf ein vorhandenes Werkzeug."

    lines = [
        "# Was Modelle von dieser Oberfläche wollten und nicht bekamen",
        "",
        f"{len(rows)} verschiedene Anfragen, nach Häufigkeit.",
        "",
        "| Anzahl | Oberfläche | Feld | Gewünscht | Zuletzt |",
        "|---:|---|---|---|---|",
    ]
    for row in rows:
        asked = str(row["askedFor"]).replace("|", "\\|")
        lines.append(f"| {row['count']} | {row['surface']} | {row['field']} | `{asked}` | {row['lastSeen']} |")
    lines += [
        "",
        "Jede Zeile ist ein Name, den ein Modell aufgerufen hat und den es hier nicht gibt.",
        "Das ist keine Fehlermeldung über ein Gebäude, sondern eine Aussage darüber, was",
        "dieser Oberfläche fehlt. Die Werte stammen aus einem Sprachmodell — als",
        "Wunschliste lesen, nicht als Spezifikation.",
    ]
    return "\n".join(lines)


def reset_for_tests(path: Path | None = None) -> None:
    target = path or ledger_path()
    if target.exists():
        target.unlink()
